/**
 * Turning a provisioned root into the paths the backend layer asks for.
 *
 * The rule that keeps both audiences happy: a hand-written
 * `tts.crispasr.{bin,model,codec}` in the plugin config always wins, and the
 * provisioned root fills only the holes. Someone who already laid out
 * `D:\crispasr` + `D:\tts` must keep running exactly those files after an
 * upgrade that adds auto-provisioning — the feature may not reach past a
 * working install to replace it.
 *
 * Merging happens before the config reaches the probes and the factory, so
 * backend *selection* opens up on its own once a root is provisioned:
 * `probeCrispasr` already requires bin+model+codec to exist, and now they do.
 *
 * @module dsh-voice-call/provision/engine
 */
import { ENGINE_VARIANTS, MODEL_ASSETS } from './manifest.ts';
import type { EngineVariant, ModelAsset } from './manifest.ts';
import { defaultModels } from './manifest.ts';
import { engineBinaryFor, readRecord } from './layout.ts';
import { sizeOf } from './download.ts';
import type { ProvisionLayout, ProvisionRecord } from './layout.ts';
import type { VoiceConfig } from '../types.ts';

/** The three paths the crispasr backend needs to run one synthesis. */
export interface ProvisionedEngine {
  readonly bin: string;
  readonly model: string;
  readonly codec: string;
  /**
   * The backend the installed talker needs. It is carried with the model rather
   * than configured separately because the pairing is what the engine loads:
   * the 1.7B port is a different backend name, and running its weights under
   * the 0.6B one is a silent mismatch, not an error.
   */
  readonly backend: string;
  /** Which build is installed, so the UI can name it. */
  readonly variant: EngineVariant;
}

/**
 * What the root holds, if anything. A partial root is not an engine: an
 * unpacked binary without its models would make the backend selectable and then
 * fail on the first call, which is worse than staying unavailable.
 *
 * The models are read **from the record**, not from the defaults: a root that
 * was provisioned with the 1.7B talker must resolve to that file and to the
 * backend that file needs. Resolving against `defaultModels()` instead would
 * make every non-default installation invisible.
 */
export async function readProvisionedEngine(
  layout: ProvisionLayout,
  /** Injectable for tests: a root holding multi-GB weights cannot be built in a unit test. */
  probe: (path: string) => Promise<number> = sizeOf,
): Promise<ProvisionedEngine | undefined> {
  const record = await readRecord(layout.stateFile);
  if (record.engineVariant === undefined) return undefined;
  const variant = ENGINE_VARIANTS.find((entry) => entry.id === record.engineVariant);
  if (variant === undefined) return undefined;
  const bin = await engineBinaryFor(layout, record, variant, probe);
  if (bin === undefined) return undefined;
  const talker = await installedRole(record, layout, 'talker', probe);
  const codec = await installedRole(record, layout, 'codec', probe);
  if (talker === undefined || codec === undefined) return undefined;
  return { bin, model: talker.path, codec: codec.path, backend: talker.asset.backend, variant };
}

/**
 * Which model files this root actually holds, by role.
 *
 * The plan asks this before it asks the manifest: a root provisioned with the
 * 1.7B talker must be reported as holding that talker, or the card spends its
 * life saying `Talker 未安装 · 还需下载 923 MB` to someone whose models are
 * complete. {@link defaultModels} is the answer for an empty root only.
 */
export async function readInstalledModels(
  layout: ProvisionLayout,
  probe: (path: string) => Promise<number> = sizeOf,
): Promise<InstalledModels> {
  const record = await readRecord(layout.stateFile);
  const out: { talker?: ModelAsset; codec?: ModelAsset } = {};
  for (const role of ['talker', 'codec'] as const) {
    const found = await installedRole(record, layout, role, probe);
    if (found !== undefined) out[role] = found.asset;
  }
  return out;
}

/** The models present on disk, per role — `undefined` means that role is unfilled. */
export interface InstalledModels {
  readonly talker?: ModelAsset;
  readonly codec?: ModelAsset;
}

/** One model role, resolved from the record against the manifest. */
async function installedRole(
  record: ProvisionRecord,
  layout: ProvisionLayout,
  role: 'talker' | 'codec',
  probe: (path: string) => Promise<number>,
): Promise<{ readonly path: string; readonly asset: ModelAsset } | undefined> {
  const stored = record.assets.find((asset) => asset.role === role);
  // A record naming a file the manifest no longer carries is a stale root (the
  // plugin was downgraded, or the pinned release moved): treat it as unprovisioned.
  const asset = MODEL_ASSETS.find((entry) => entry.role === role && entry.file === stored?.file)
    ?? (stored === undefined ? defaultFor(role) : undefined);
  if (asset === undefined) return undefined;
  const path = await pathForAsset(layout, stored, asset, probe);
  return path === undefined ? undefined : { path, asset };
}

function defaultFor(role: 'talker' | 'codec'): ModelAsset | undefined {
  return MODEL_ASSETS.find((asset) => asset.role === role && asset.default);
}

async function pathForAsset(
  layout: ProvisionLayout,
  stored: { readonly path: string } | undefined,
  asset: ModelAsset,
  probe: (path: string) => Promise<number>,
): Promise<string | undefined> {
  const candidates = [stored?.path, layout.modelPath(asset)].filter((entry): entry is string => entry !== undefined);
  for (const path of candidates) {
    if (await probe(path) === asset.bytes) return path;
  }
  return undefined;
}

/**
 * The config the rest of the plugin should see: `configured` verbatim where it
 * names a file, the provisioned root everywhere it left a hole.
 */
export function withProvisionedEngine(config: VoiceConfig, provisioned: ProvisionedEngine | undefined): VoiceConfig {
  if (provisioned === undefined) return config;
  const engine = config.tts.crispasr;
  const model = named(engine?.model) ? engine?.model as string : provisioned.model;
  const merged = {
    bin: named(engine?.bin) ? engine?.bin as string : provisioned.bin,
    model,
    codec: named(engine?.codec) ? engine?.codec as string : provisioned.codec,
    // The backend travels with the model it loads: take the configured one when
    // the user named a model themselves, otherwise the one the installed talker
    // needs. A hand-written `model` with no `backend` keeps the 0.6B default,
    // which is what every existing config expects.
    backend: named(engine?.backend) ? engine?.backend as string
      : model === provisioned.model ? provisioned.backend : engine?.backend,
  };
  if (merged.bin === engine?.bin && merged.model === engine?.model && merged.codec === engine?.codec && merged.backend === engine?.backend) return config;
  return {
    ...config,
    tts: { ...config.tts, crispasr: merged },
  };
}

/** A path the config actually names — `undefined` and `''` are both "not set". */
function named(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

/**
 * Whether the config *names* all three engine paths. Note the distinction this
 * file keeps tripping over: naming a path is not having it — `probeCrispasr`
 * answers "can I run this engine" by checking the files exist, which is the
 * question the backend selection actually asks.
 */
export function engineReady(config: VoiceConfig): boolean {
  const engine = config.tts.crispasr;
  return named(engine?.bin) && named(engine?.model) && named(engine?.codec);
}
