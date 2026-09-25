/**
 * dsh-voice-call settings: the live-config read contract.
 *
 * 0.1.7 removed the `SettingsProvider.installSection` seam this module used to
 * hang its config off. The loader now owns the plugin's exported `Config`, and
 * the profile patch is the single source of truth, so nothing is registered
 * here any more — what remains is the *liveness* contract:
 *
 * - a field the schema marks `.volatile()` arrives in `apply()`'s config as a
 *   cosmokit live reference, so re-resolving on every read is what carries a
 *   settings-UI change into the next tool call;
 * - a field without that mark is fixed until the plugin reloads, and the host
 *   refuses a form write to it (`has no volatile fields` / `is not volatile`).
 *
 * @module dsh-voice/settings
 */
import { plainConfig } from './plain.ts';
import type { VoiceConfig, VoiceConfigInput } from './types.ts';
import { resolveConfig } from './types.ts';

/**
 * Build the plugin's effective-config thunk.
 * @param entry - the parsed `Config` the loader handed to `apply()`.
 * @returns a thunk resolving the current config on every call, so volatile
 *   fields are read fresh and never cached.
 */
export function voiceConfigSource(entry: VoiceConfigInput | undefined): () => VoiceConfig {
  return () => resolveConfig(plainConfig(entry) as VoiceConfigInput | undefined);
}
