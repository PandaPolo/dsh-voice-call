/**
 * dsh-voice — voice notes in, spoken answers out. Dictate audio that becomes
 * user messages (`transcribe`), have the agent read replies aloud (`speak`),
 * and leave walk-away narration on long headless runs. Local-first: audio is
 * plain files under `~/.dsh/voice/`, nothing leaves the machine unless a
 * cloud backend is configured, and nothing audio-related ever auto-runs —
 * the model must call a tool.
 *
 * One bundle, one plugin (plus the web client half that renders the
 * `voice/note` audio cards):
 * - `transcribe({ source: {file|record}, to? })` — STT; the transcript is
 *   inserted as a user message and a `voice/note` event renders the audio
 *   card as a user-authored turn.
 * - `speak({ text, voice?, rate? })` — TTS on a background job; returns
 *   `{ jobId, audioRef }` immediately, never blocks the turn.
 * - `readReplies` + `/voice` — per-session toggle that narrates replies.
 * - The `dsh-voice-backends` module owns backend selection and the fake
 *   backend (the CI default): whisper-local / openai / macos STT and
 *   say / piper / edge-tts TTS.
 *
 * @module @dsh-voice/bundle
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-shell';
import type {} from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { AudioStore, resolveAudioDir } from './audio.ts';
import { createRecordFn, createSttBackend, createTtsBackend } from './backends/index.ts';
import { registerVoiceCommand } from './command.ts';
import { installReadReplies, ReadRepliesToggle } from './read-replies.ts';
import { installVoiceSettings } from './settings.ts';
import { applySpeakTool, buildSpeakDeps } from './tools/speak.ts';
import { applyTranscribeTool, buildTranscribeDeps } from './tools/transcribe.ts';
import { resolveConfig, type VoiceConfig } from './types.ts';
import type { VoiceConfigInput } from './types.ts';
import { installAudioRoute } from './web.ts';

/** Cordis plugin name (also the config key under `plugins:`). */
export const name = 'dsh-voice';

/** Services required before the plugin can mount. */
export const inject = ['tools'] as const;

/** The `voice-speak` background job kind owned by this plugin. */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'voice-speak': 'voice-speak';
  }
}

/** Plugin config (all fields optional — defaults match the documented behavior). */
export const Config = z.object({
  stt: z.object({
    backend: z.union(['whisper-local', 'openai', 'macos', 'fake']),
    model: z.string(),
    whisperLocal: z.object({ bin: z.string(), model: z.string() }),
    openai: z.object({ baseUrl: z.string(), apiKeyEnv: z.string().role('credential-ref') }),
  }),
  tts: z.object({
    backend: z.union(['say', 'piper', 'edge-tts', 'fake']),
    voice: z.string(),
    rate: z.number().min(1).max(600),
    piper: z.object({ bin: z.string(), model: z.string() }),
    edgeTts: z.object({ voice: z.string() }),
  }),
  readReplies: z.boolean().default(false),
  audioDir: z.string(),
});

/** Mount the plugin: settings, tools, narration, command, web route. */
export function apply(ctx: Context, rawConfig: VoiceConfigInput): void {
  // Settings: live source thunk; backends resolve fresh per tool call.
  let current = (): VoiceConfig => resolveConfig(rawConfig);

  // Audio store: plain files under audioDir; the log carries refs only.
  let audioRoot = resolveAudioDir(current().audioDir);
  let disposeRoute: (() => void) | undefined;
  const mountRoute = (): void => {
    disposeRoute?.();
    disposeRoute = installAudioRoute(ctx, audioRoot);
  };
  mountRoute();
  current = installVoiceSettings(ctx, rawConfig, () => {
    audioRoot = resolveAudioDir(current().audioDir);
    mountRoute();
  });
  const audioStore = (): AudioStore => new AudioStore(audioRoot);
  const audioPath = (): string => audioStore().pathFor(`voice-speak-${speakSeq()}`, 'm4a');

  // Backends: created per call so config changes reach the next tool call.
  const backendDeps = () => ({ ctx, config: current() });
  const agentFor = (session: { readonly id: string }): Agent | undefined => {
    const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined;
    return agents?.get(session.id);
  };

  applyTranscribeTool(ctx, {
    makeDeps: (exec) => buildTranscribeDeps(ctx, {
      stt: createSttBackend(backendDeps()),
      record: createRecordFn(backendDeps()),
      commit: (file, name, extra) => audioStore().commit(file, name, extra),
    }, exec),
  });

  applySpeakTool(ctx, {
    makeDeps: (exec) => buildSpeakDeps(ctx, {
      tts: createTtsBackend(backendDeps()),
      audioPath,
    }, exec),
  });

  // Narration: per-session toggle, off unless configured or /voice on.
  const toggle = new ReadRepliesToggle(current().readReplies);
  installReadReplies(ctx, toggle, (session) => buildSpeakDeps(ctx, {
    tts: createTtsBackend(backendDeps()),
    audioPath,
  }, { agent: agentFor(session) }));

  registerVoiceCommand(ctx, {
    readReplies: () => toggle.enabled,
    setReadReplies: (enabled) => toggle.set(enabled),
    statusLine: () => {
      const config = current();
      return `stt: ${config.stt.backend ?? 'auto'} · tts: ${config.tts.backend ?? 'auto'} · readReplies: ${toggle.enabled ? 'on' : 'off'}`;
    },
    configLine: () => `audioDir: ${audioRoot}`,
    speakDeps: (session) => buildSpeakDeps(ctx, {
      tts: createTtsBackend(backendDeps()),
      audioPath,
    }, { agent: agentFor(session) }),
  });
}

let seq = 0;
function speakSeq(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}
