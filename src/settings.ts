/**
 * dsh-voice settings: the `voice` namespace under the user-settings seam.
 * Users edit `stt` / `tts` / `readReplies` / `audioDir` from their profile
 * patch or the settings UI; the plugin keeps reading the live resolved
 * source so a change reaches the very next tool call.
 *
 * @module dsh-voice/settings
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { resolveConfig } from './types.ts';
import type { VoiceConfig, VoiceConfigInput } from './types.ts';

/** The `voice` settings namespace. */
export const NS = settingsNamespace('voice');

const backendSchema = (options: readonly string[]) => z.union([...options]);

/** Plugin config schema (all fields optional; defaults in {@link resolveConfig}). */
export const Config = z.object({
  stt: z.object({
    backend: backendSchema(['whisper-local', 'openai', 'macos', 'fake']),
    model: z.string(),
    whisperLocal: z.object({
      bin: z.string(),
      model: z.string(),
    }),
    openai: z.object({
      baseUrl: z.string(),
      apiKeyEnv: z.string().role('credential-ref'),
    }),
  }),
  tts: z.object({
    backend: backendSchema(['say', 'piper', 'edge-tts', 'fake', 'crispasr']),
    voice: z.string(),
    rate: z.number().min(1).max(600),
    piper: z.object({
      bin: z.string(),
      model: z.string(),
    }),
    edgeTts: z.object({
      voice: z.string(),
    }),
    crispasr: z.object({
      bin: z.string(),
      model: z.string(),
      codec: z.string(),
    }),
  }),
  readReplies: z.boolean().default(false),
  // Must mirror index.ts Config: appending voice/* session events poisons
  // history loading on harness builds without plugin-event support.
  durableEvents: z.boolean().default(false),
  callMode: z.union(['ask', 'direct', 'off']).default('ask'),
  audioDir: z.string(),
  // Reserved for v0.3 — accepted now so configs written against v0.1 keep loading.
  voicemail: z.object({ enabled: z.boolean() }),
  readReceipts: z.object({ enabled: z.boolean() }),
});

/**
 * Install the settings wiring: while a settings service exists, register the
 * namespace with the plugin's composition entry as base and point the source
 * thunk at the resolved scope; otherwise fall back to the entry.
 * @param onChange - invoked after any attach/detach/commit so the plugin can
 *   re-judge derived state (audio root, route registrations).
 * @returns a thunk returning the current effective config.
 */
export function installVoiceSettings(ctx: Context, entry: VoiceConfigInput, onChange?: () => void): () => VoiceConfig {
  let current: () => VoiceConfig = () => resolveConfig(entry);
  installSettingsSection(ctx, NS, Config, entry, {
    setSource: (source) => {
      current = () => resolveConfig(source() as VoiceConfigInput);
    },
    onChange: () => {
      current();
      onChange?.();
    },
  });
  return current;
}
