/**
 * dsh-voice-call — the agent's voice, offered. Fork of dsh-voice that adds
 * the call domain: `offer_call` rings the human with what the agent wants to
 * say, and nothing plays until the human answers 接听/拒接/稍后. Local-first:
 * audio is plain files under `~/.dsh/voice/`, synthesis runs on the local
 * CrispASR engine with the Qwen3-TTS CustomVoice model (9 baked speakers).
 *
 * One bundle, one plugin (plus the web client half that renders the
 * `voice/note` audio cards):
 * - `offer_call({ text, voice? })` — the call domain: ring → human answers →
 *   accepted calls synthesize on a background job, rejected/deferred calls
 *   return the human's decision to the agent.
 * - `transcribe({ source: {file|record}, to? })` — STT (from dsh-voice).
 * - `speak({ text, voice?, rate? })` — direct TTS on a background job
 *   (from dsh-voice; the crispasr backend is the local default here).
 * - `readReplies` + `/voice` — per-session narration toggle.
 * - `callMode: ask | card | direct | off` — how calls ring the human; `card`
 *   rings the v0.2 call-card UI (ring animation, caller identity) over the
 *   `/voice/call` web routes, with the v0.1 prompt as its fallback.
 *
 * Upgrade-ready contracts (reserved, not implemented in v0.1):
 * `src/rpc/contract.ts` (call-card UI endpoints), `src/domain/voicemail.ts`
 * (voicemail + read receipts), `voice/call.read` / `voice/call.voicemail`
 * event types.
 *
 * @module dsh-voice-call
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-shell';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-questions';
import z from '@deepseek-ai/schemastery';
import { AudioStore, resolveAudioDir } from './audio.ts';
import { CallBoard } from './callcard/board.ts';
import { installCallCardRoutes } from './callcard/web.ts';
import { createRecordFn, createSttBackend, createTtsBackend } from './backends/index.ts';
import { AskUserRingChannel, DirectRingChannel, type RingChannel } from './channels/ring.ts';
import { CallCardRingChannel } from './channels/callcard.ts';
import { registerVoiceCommand } from './command.ts';
import { installVoicePersona } from './persona.ts';
import { installReadReplies, ReadRepliesToggle } from './read-replies.ts';
import { installVoiceSettings } from './settings.ts';
import { applyOfferCallTool, buildOfferCallDeps } from './tools/offer-call.ts';
import { applySpeakTool, buildSpeakDeps } from './tools/speak.ts';
import { applyTranscribeTool, buildTranscribeDeps } from './tools/transcribe.ts';
import { resolveConfig, type VoiceConfig } from './types.ts';
import type { VoiceConfigInput } from './types.ts';
import { installAudioRoute } from './web.ts';

/** Cordis plugin name (also the config key under `plugins:`). */
export const name = 'dsh-voice-call';

/** Services required before the plugin can mount. */
export const inject = ['tools', 'userQuestions', 'jobs'] as const;

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
    backend: z.union(['say', 'piper', 'edge-tts', 'fake', 'crispasr']),
    voice: z.string(),
    rate: z.number().min(1).max(600),
    piper: z.object({ bin: z.string(), model: z.string() }),
    edgeTts: z.object({ voice: z.string() }),
    crispasr: z.object({ bin: z.string(), model: z.string(), codec: z.string() }),
  }),
  readReplies: z.boolean().default(false),
  // Session-log durability for voice events. MUST stay off on harness builds
  // without plugin-event support (rc.6 refuses unknown event types on history
  // load — an appended voice/* event poisons the session log).
  durableEvents: z.boolean().default(false),
  callMode: z.union(['ask', 'card', 'direct', 'off']).default('ask'),
  callCard: z.object({
    callerName: z.string(),
    ringTimeoutMs: z.number().min(1000).max(600_000),
  }),
  audioDir: z.string(),
  // Reserved for v0.3 — accepted now so configs written against v0.1 keep loading.
  voicemail: z.object({ enabled: z.boolean() }),
  readReceipts: z.object({ enabled: z.boolean() }),
});

/** Mount the plugin: settings, tools, narration, call domain, persona, command, web route. */
export function apply(ctx: Context, rawConfig: VoiceConfigInput): void {
  // Settings: live source thunk; backends resolve fresh per tool call.
  let current = (): VoiceConfig => resolveConfig(rawConfig);

  // Audio store: plain files under audioDir; the log carries refs only.
  let audioRoot = resolveAudioDir(current().audioDir);
  // The call-card board: the host half of the v0.2 card UI. The web routes
  // stream its state to connected clients; with no webserver (headless) it
  // simply never gains subscribers and the card channel falls back to the
  // v0.1 prompt channel.
  const callBoard = new CallBoard();
  let disposeRoute: (() => void) | undefined;
  const mountRoute = (): void => {
    disposeRoute?.();
    disposeRoute = installAudioRoute(ctx, audioRoot);
  };
  // Web routes mount via ctx.inject: the webserver fiber boots in parallel
  // with this plugin, so a plain ctx.get('webServer') in apply() races and
  // silently registers nothing (the harness's own web-app waits the same
  // way). In headless compositions the service never appears and the
  // callback simply never fires.
  let routesReady = false;
  ctx.inject(['webServer'], () => {
    routesReady = true;
    mountRoute();
    installCallCardRoutes(ctx, callBoard);
  });
  current = installVoiceSettings(ctx, rawConfig, () => {
    audioRoot = resolveAudioDir(current().audioDir);
    if (routesReady) mountRoute();
  });
  const audioStore = (): AudioStore => new AudioStore(audioRoot);
  const audioPath = (): string => audioStore().pathFor(`voice-speak-${speakSeq()}`, 'wav');

  // Backends: created per call so config changes reach the next tool call.
  // The local TTS engine spans several roots (engine bin, GGUF models, the
  // audio dir) that no confined sandbox mode covers, and the Windows ACL
  // runner is unusable when the temp dir sits inside the workspace — so the
  // engine's shell calls carry an explicit danger-full-access policy.
  const fullAccessPolicy = { mode: 'danger-full-access' as const, workspaceRoot: process.cwd() };
  const backendDeps = () => ({ ctx, config: current(), policy: fullAccessPolicy });
  const agentFor = (session: { readonly id: string }): Agent | undefined => {
    const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined;
    return agents?.get(session.id);
  };

  applyTranscribeTool(ctx, {
    makeDeps: (exec) => buildTranscribeDeps(ctx, {
      stt: createSttBackend(backendDeps()),
      record: createRecordFn(backendDeps()),
      commit: (file, name, extra) => audioStore().commit(file, name, extra),
      durableEvents: () => current().durableEvents,
    }, exec),
  });

  applySpeakTool(ctx, {
    makeDeps: (exec) => buildSpeakDeps(ctx, {
      tts: createTtsBackend(backendDeps()),
      audioPath,
      durableEvents: () => current().durableEvents,
    }, exec),
  });

  // The call domain: the ring channel follows callMode (ask → human prompt,
  // card → the v0.2 call-card UI with the v0.1 prompt as fallback,
  // direct → immediate accept; off → refused).
  const askChannel = (): RingChannel => new AskUserRingChannel((request) => ctx.userQuestions.ask({
    questions: request.questions,
    ...(request.agent !== undefined ? { agent: request.agent } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  }));
  const ringChannel = (): RingChannel => {
    const mode = current().callMode;
    if (mode === 'direct') return new DirectRingChannel();
    if (mode === 'card') {
      return new CallCardRingChannel({
        board: callBoard,
        callerName: () => current().callCard.callerName,
        ringTimeoutMs: () => current().callCard.ringTimeoutMs,
        fallback: askChannel(),
      });
    }
    return askChannel();
  };

  applyOfferCallTool(ctx, {
    makeDeps: (exec) => buildOfferCallDeps(ctx, {
      ring: ringChannel(),
      callMode: () => current().callMode,
      durableEvents: () => current().durableEvents,
      speak: buildSpeakDeps(ctx, {
        tts: createTtsBackend(backendDeps()),
        audioPath,
        durableEvents: () => current().durableEvents,
      }, exec),
    }, exec),
  });

  // The voice persona: tells the agent it has a voice and how to use it.
  installVoicePersona(ctx, () => current().callMode);

  // Narration: per-session toggle, off unless configured or /voice on.
  const toggle = new ReadRepliesToggle(current().readReplies);
  installReadReplies(ctx, toggle, (session) => buildSpeakDeps(ctx, {
    tts: createTtsBackend(backendDeps()),
    audioPath,
    durableEvents: () => current().durableEvents,
  }, { agent: agentFor(session) }));

  registerVoiceCommand(ctx, {
    readReplies: () => toggle.enabled,
    setReadReplies: (enabled) => toggle.set(enabled),
    statusLine: () => {
      const config = current();
      return `stt: ${config.stt.backend ?? 'auto'} · tts: ${config.tts.backend ?? 'auto'} · readReplies: ${toggle.enabled ? 'on' : 'off'}`;
    },
    callMode: () => current().callMode,
    configLine: () => `audioDir: ${audioRoot}`,
    speakDeps: (session) => buildSpeakDeps(ctx, {
      tts: createTtsBackend(backendDeps()),
      audioPath,
      durableEvents: () => current().durableEvents,
    }, { agent: agentFor(session) }),
  });
}

let seq = 0;
function speakSeq(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}
