/**
 * Pure backend selection: given config and availability probes, pick the
 * expected backend and fall back in order. Cloud backends are never
 * auto-selected — a pinned `openai` / `edge-tts` is chosen only when the
 * user explicitly configured it.
 *
 * @module dsh-voice/backends/selection
 */
import type { SttBackendId, TtsBackendId } from './types.ts';

/** Availability facts probed once at load (or faked in unit tests). */
export interface BackendProbes {
  /** A whisper.cpp binary is reachable. */
  readonly whisperLocal: boolean;
  /** macOS `say` is on PATH. */
  readonly say: boolean;
  /** macOS + a swift runtime is present (the SFSpeechRecognizer shim). */
  readonly macos: boolean;
  /** A piper binary is reachable. */
  readonly piper: boolean;
  /** The `edge-tts` CLI is reachable. */
  readonly edgeTts: boolean;
  /** The local crispasr binary + talker/codec GGUFs are configured. */
  readonly crispasr: boolean;
  /** A microphone recording path exists (ffmpeg or the swift shim). */
  readonly mic: boolean;
}

/** Offline STT fallback order: whisper-local → macos (never cloud). */
export const AUTO_STT_ORDER: readonly SttBackendId[] = ['whisper-local', 'macos'];
/** Offline TTS fallback order: say → crispasr → piper (never edge-tts). */
export const AUTO_TTS_ORDER: readonly TtsBackendId[] = ['say', 'crispasr', 'piper'];

/** The resolved selection: a concrete id, or `none` with a reason. */
export type BackendSelection<Id extends string> =
  | { readonly kind: 'ok'; readonly id: Id }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * Select the STT backend. A configured backend always wins (including cloud);
 * otherwise the offline fallback order runs against the probes.
 */
export function selectSttBackend(
  configured: { readonly backend?: SttBackendId },
  probes: BackendProbes,
): BackendSelection<SttBackendId> {
  if (configured.backend !== undefined) return { kind: 'ok', id: configured.backend };
  for (const id of AUTO_STT_ORDER) {
    if (probeFor(id, probes)) return { kind: 'ok', id };
  }
  return {
    kind: 'none',
    reason: 'no offline STT backend available (whisper-local or macos); configure stt.backend — "fake" for tests, "openai" for cloud',
  };
}

/**
 * Select the TTS backend. A configured backend always wins; `edge-tts` is
 * never chosen automatically (cloud). Otherwise say → piper.
 */
export function selectTtsBackend(
  configured: { readonly backend?: TtsBackendId },
  probes: BackendProbes,
): BackendSelection<TtsBackendId> {
  if (configured.backend !== undefined) return { kind: 'ok', id: configured.backend };
  for (const id of AUTO_TTS_ORDER) {
    if (probeFor(id, probes)) return { kind: 'ok', id };
  }
  return {
    kind: 'none',
    reason: 'no local TTS backend available (say or piper); configure tts.backend — "fake" for tests, "edge-tts" for cloud',
  };
}

function probeFor(id: SttBackendId | TtsBackendId, probes: BackendProbes): boolean {
  switch (id) {
    case 'whisper-local': return probes.whisperLocal;
    case 'macos': return probes.macos;
    case 'say': return probes.say;
    case 'piper': return probes.piper;
    case 'crispasr': return probes.crispasr;
    default: return false;
  }
}
