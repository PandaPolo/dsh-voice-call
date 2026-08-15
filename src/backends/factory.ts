/**
 * Backend factory: wires the resolved config + a shell runner (from
 * `ctx.shell`) into the concrete backend instances the tools use. Selection
 * is pure ({@link selectSttBackend} / {@link selectTtsBackend}); a failed
 * selection throws the resolver's reason so the user sees exactly what to
 * configure.
 *
 * @module dsh-voice/backends/factory
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RecordedMedia, VoiceConfig } from '../types.ts';
import { CrispasrTtsBackend } from './crispasr.ts';
import { EdgeTtsBackend } from './edge-tts.ts';
import { FakeSttBackend, FakeTtsBackend } from './fake.ts';
import { MacosSttBackend, recordWithMacos } from './macos.ts';
import { OpenAiSttBackend } from './openai.ts';
import { PiperTtsBackend } from './piper.ts';
import { probeBackends } from './probe.ts';
import type { BackendProbes } from './selection.ts';
import { makeShellRunner, type ShellRun, type VoiceSandboxPolicy } from './runner.ts';
import { SayTtsBackend } from './say.ts';
import { selectSttBackend, selectTtsBackend } from './selection.ts';
import type { SttBackend, TtsBackend } from './types.ts';
import { WhisperLocalSttBackend } from './whisper-local.ts';

/** Everything the factory needs; tests may inject `run` and `probes`. */
export interface BackendDeps {
  readonly ctx: Context;
  readonly config: VoiceConfig;
  /** Shell runner override (unit tests); defaults to `ctx.shell`. */
  readonly run?: ShellRun;
  /** Availability probes override (unit tests); defaults to live probes. */
  readonly probes?: BackendProbes;
  /**
   * Per-call sandbox policy stamped onto every shell request (e.g. a fixed
   * danger-full-access policy for the local TTS engine — its binaries, models,
   * and audio dir span multiple roots that no confined mode covers).
   */
  readonly policy?: VoiceSandboxPolicy;
}

/** Build the configured STT backend, throwing the selection reason on none. */
export function createSttBackend(deps: BackendDeps): SttBackend {
  const run = deps.run ?? makeShellRunner(deps.ctx, deps.policy);
  const probes = deps.probes ?? probeBackends(deps.config);
  const selected = selectSttBackend(deps.config.stt, probes);
  if (selected.kind === 'none') throw new Error(`dsh-voice: ${selected.reason}`);
  switch (selected.id) {
    case 'fake':
      return new FakeSttBackend();
    case 'whisper-local':
      return new WhisperLocalSttBackend(run, {
        bin: deps.config.stt.whisperLocal?.bin ?? 'whisper-cli',
        model: deps.config.stt.whisperLocal?.model,
      });
    case 'openai':
      return new OpenAiSttBackend(deps.ctx, {
        baseUrl: deps.config.stt.openai?.baseUrl ?? 'https://api.openai.com/v1',
        apiKeyEnv: deps.config.stt.openai?.apiKeyEnv ?? 'OPENAI_API_KEY',
        model: deps.config.stt.model ?? 'whisper-1',
      });
    case 'macos':
      return new MacosSttBackend(run);
  }
}

/** Build the configured TTS backend, throwing the selection reason on none. */
export function createTtsBackend(deps: BackendDeps): TtsBackend {
  const run = deps.run ?? makeShellRunner(deps.ctx, deps.policy);
  const probes = deps.probes ?? probeBackends(deps.config);
  const selected = selectTtsBackend(deps.config.tts, probes);
  if (selected.kind === 'none') throw new Error(`dsh-voice: ${selected.reason}`);
  switch (selected.id) {
    case 'fake':
      return new FakeTtsBackend();
    case 'say':
      return new SayTtsBackend(run);
    case 'piper':
      return new PiperTtsBackend(run, {
        bin: deps.config.tts.piper?.bin ?? 'piper',
        model: deps.config.tts.piper?.model ?? '',
      });
    case 'edge-tts':
      return new EdgeTtsBackend(run, {
        bin: 'edge-tts',
        voice: deps.config.tts.edgeTts?.voice ?? deps.config.tts.voice ?? 'en-US-GuyNeural',
      });
    case 'crispasr': {
      const engine = deps.config.tts.crispasr ?? {};
      return new CrispasrTtsBackend(run, {
        bin: engine.bin ?? 'crispasr',
        model: engine.model ?? '',
        codec: engine.codec ?? '',
      });
    }
  }
}

/**
 * Build the mic-recording function used by `transcribe({record})`. Gated on
 * availability: the caller checks `probes.mic` before offering recording.
 */
export function createRecordFn(deps: BackendDeps): (seconds: number | undefined, signal?: AbortSignal) => Promise<RecordedMedia> {
  const run = deps.run ?? makeShellRunner(deps.ctx, deps.policy);
  return async (seconds, signal) => {
    if (!(deps.probes ?? probeBackends(deps.config)).mic) {
      throw new Error('dsh-voice: mic recording is not available in this deployment (needs ffmpeg or swift on macOS)');
    }
    const file = await recordTarget(deps.config, 'voice-record');
    await recordWithMacos(run, file, seconds, signal);
    return { file, durationMs: seconds !== undefined && seconds > 0 ? Math.round(seconds * 1000) : 5000 };
  };
}

async function recordTarget(config: VoiceConfig, kind: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-record-'));
  return join(dir, `${kind}.m4a`);
}
