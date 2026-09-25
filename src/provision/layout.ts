/**
 * Where provisioning puts things, and what it remembers about them.
 *
 * Everything lives under the voice root (`~/.dsh/voice` by default, or
 * `audioDir` if the user moved it) so one folder holds the whole feature and
 * `rm -r` is a complete uninstall:
 *
 *   <root>/engine/<variant-id>/   unpacked engine; the binary is *found*, not
 *                                 assumed, because release archives wrap their
 *                                 payload in a top-level directory
 *   <root>/models/<file>.gguf     the GGUFs, named exactly as upstream
 *   <root>/provision.json         what landed here, its digest, and where from
 *
 * A hand-written `tts.crispasr.{bin,model,codec}` in the plugin config always
 * outranks this directory: a user who already laid out `D:\crispasr` + `D:\tts`
 * must not have that overwritten by a plugin that thinks it knows better.
 *
 * Cost rule: on startup an asset counts as present when its **size** matches.
 * Hashing 1.2 GB on every mount would bill the user a disk stall for a
 * precaution; full digest checks happen when something is adopted, when it
 * finishes downloading, and when the user presses 校验.
 *
 * @module dsh-voice-call/provision/layout
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sizeOf } from './download.ts';
import type { EngineVariant, EngineVariantId, Installed, ModelAsset } from './manifest.ts';
import { ENGINE_TAG } from './manifest.ts';

/** The schema version of `provision.json`; a newer file is ignored, not guessed. */
export const STATE_VERSION = 1;

/** The file recording what this root contains. */
export const STATE_FILE = 'provision.json';

/** One asset this root holds, with the proof that it is the right one. */
export interface InstalledAsset {
  readonly role: 'engine' | 'talker' | 'codec';
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly path: string;
  /** The origin that actually served it, for reporting. */
  readonly origin: string;
  readonly installedAt: number;
}

/** The on-disk record of a provisioned runtime. */
export interface ProvisionRecord {
  readonly version: number;
  readonly engineVariant?: EngineVariantId;
  readonly engineTag?: string;
  /** Absolute path to the unpacked `crispasr(.exe)`, located after unpacking. */
  readonly engineBinary?: string;
  readonly assets: readonly InstalledAsset[];
}

/** The empty record, used before anything is installed. */
export function emptyRecord(): ProvisionRecord {
  return { version: STATE_VERSION, assets: [] };
}

/** The directory plan for one voice root. */
export interface ProvisionLayout {
  readonly root: string;
  readonly stateFile: string;
  readonly modelsDir: string;
  /** Where every unpacked engine variant lives — the whole group a clean removes. */
  engineRootDir(): string;
  /** Where a variant's engine lands once unpacked. */
  engineDir(variantId: string): string;
  /**
   * The one path the backend runs: unpacking guarantees the executable sits
   * directly beside its DLLs here, so no caller has to search.
   */
  engineBinaryPath(variant: EngineVariant): string;
  /** Where a variant's archive is downloaded (removed after a successful unpack). */
  archivePath(variant: EngineVariant): string;
  /** The final path of one model file. */
  modelPath(asset: ModelAsset): string;
  /** The scratch dir for in-flight downloads of one archive. */
  downloadDir(): string;
}

/** Build the layout for a voice root. */
export function provisionLayout(root: string): ProvisionLayout {
  const base = resolve(root);
  return {
    root: base,
    stateFile: join(base, STATE_FILE),
    modelsDir: join(base, 'models'),
    engineRootDir: () => join(base, 'engine'),
    engineDir: (variantId: string) => join(base, 'engine', safeSegment(variantId)),
    engineBinaryPath: (variant: EngineVariant) => join(base, 'engine', safeSegment(variant.id), variant.binary),
    archivePath: (variant: EngineVariant) => join(base, 'downloads', safeSegment(variant.file)),
    modelPath: (asset: ModelAsset) => join(base, 'models', safeSegment(asset.file)),
    downloadDir: () => join(base, 'downloads'),
  };
}

/** Refuse anything that could escape the root when it becomes a path segment. */
function safeSegment(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._+-]/g, '_');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'asset' : cleaned;
}

/** Read `provision.json`; a corrupt or foreign-version file reads as empty. */
export async function readRecord(stateFile: string): Promise<ProvisionRecord> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return emptyRecord();
    const record = parsed as Partial<ProvisionRecord>;
    if (record.version !== STATE_VERSION || !Array.isArray(record.assets)) return emptyRecord();
    const dir = dirname(stateFile);
    return {
      version: STATE_VERSION,
      ...(typeof record.engineVariant === 'string' ? { engineVariant: record.engineVariant as EngineVariantId } : {}),
      ...(typeof record.engineTag === 'string' ? { engineTag: record.engineTag } : {}),
      ...(typeof record.engineBinary === 'string' ? { engineBinary: resolveStored(dir, record.engineBinary) } : {}),
      assets: record.assets.filter(isInstalledAsset).map((asset) => ({ ...asset, path: resolveStored(dir, asset.path) })),
    };
  } catch {
    return emptyRecord();
  }
}

function isInstalledAsset(value: unknown): value is InstalledAsset {
  const asset = value as Partial<InstalledAsset> | null;
  return asset !== null
    && (asset.role === 'engine' || asset.role === 'talker' || asset.role === 'codec')
    && typeof asset.file === 'string'
    && typeof asset.bytes === 'number'
    && typeof asset.sha256 === 'string'
    && typeof asset.path === 'string';
}

/**
 * Asset paths are stored **relative to the voice root**, so moving or copying a
 * `~/.dsh/voice` folder keeps the record valid. A path outside the root (a
 * hand-configured absolute engine, adopted as-is) stays absolute.
 */
function relativize(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return rel;
}

function resolveStored(stateDir: string, stored: string): string {
  return isAbsolute(stored) ? stored : join(stateDir, stored);
}

/** Write the record atomically (a torn file would read as empty and re-download 1.2 GB). */
export async function writeRecord(layout: ProvisionLayout, record: ProvisionRecord): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  const stored: ProvisionRecord = {
    ...record,
    version: STATE_VERSION,
    ...(record.engineBinary !== undefined ? { engineBinary: relativize(layout.root, record.engineBinary) } : {}),
    assets: record.assets.map((asset) => ({ ...asset, path: relativize(layout.root, asset.path) })),
  };
  // One scratch name per writer. With a fixed `.tmp`, two processes sharing a
  // root (two profiles, or a second mount) both stage into the same file and the
  // second rename publishes the first one's payload under the second's name —
  // which is the same lost install a torn file causes, only quieter.
  const tmp = `${layout.stateFile}.${process.pid}.${(recordSeq += 1)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  await rename(tmp, layout.stateFile);
}

let recordSeq = 0;

/** Locate the engine executable anywhere under a directory. */
export async function findEngineBinary(dir: string, binary: string): Promise<string | undefined> {
  return walkForFile(dir, [binary], 400);
}

/**
 * Breadth-first search for the first file named one of `names` (case-insensitive,
 * and `foo` also matches `foo.exe`). `budget` bounds the walk so a symlink cycle
 * or a directory that was never an archive cannot hang provisioning.
 */
export async function walkForFile(dir: string, names: readonly string[], budget = 400): Promise<string | undefined> {
  const wanted = names.map((name) => name.toLowerCase());
  const queue: string[] = [resolve(dir)];
  let seen = 0;
  let best: { path: string; rank: number } | undefined;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (++seen > budget) break;
        queue.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++seen > budget) break;
      const rank = wanted.indexOf(entry.name.toLowerCase());
      // Every match is collected and the best-ranked one wins. Returning the
      // *first* hit let readdir order choose between `crispasr.exe` and
      // `crispasr.dll`, which installed an engine that cannot be run.
      if (rank >= 0 && (await isExecutable(path)) && (best === undefined || rank < best.rank)) {
        best = { path, rank };
      }
    }
  }
  return best?.path;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1024) return false;
    if (process.platform === 'win32') return true;
    return (info.mode & 0b001_001_001) !== 0;
  } catch {
    return false;
  }
}

/** What the root already holds, keyed by plan step, for {@link buildPlan}. */
export async function installedMap(layout: ProvisionLayout, input: {
  readonly variant: EngineVariant;
  readonly talker: ModelAsset;
  readonly codec: ModelAsset;
}): Promise<Installed> {
  const record = await readRecord(layout.stateFile);
  const out: Installed = {};
  // The engine counts as installed only when the unpacked binary is really
  // there — an archive that downloaded but never unpacked must re-run the plan.
  const binary = await engineBinaryFor(layout, record, input.variant);
  if (record.engineVariant === input.variant.id && record.engineTag === ENGINE_TAG && binary !== undefined) {
    out.engine = { bytes: input.variant.bytes, sha256: input.variant.sha256 };
  }
  for (const asset of [input.talker, input.codec]) {
    const entry = record.assets.find((candidate) => candidate.role === asset.role && candidate.file === asset.file);
    const size = await sizeOf(entry?.path ?? layout.modelPath(asset));
    if (size === asset.bytes) out[asset.role] = { bytes: size, sha256: asset.sha256 };
  }
  return out;
}

/**
 * The executable to invoke: the canonical unpacked path, or wherever a 手动放置
 * run found it. `undefined` when neither exists.
 */
export async function engineBinaryFor(
  layout: ProvisionLayout,
  record: ProvisionRecord,
  variant: EngineVariant,
  probe: (path: string) => Promise<number> = sizeOf,
): Promise<string | undefined> {
  const canonical = layout.engineBinaryPath(variant);
  if (await probe(canonical) > 0) return canonical;
  const stored = record.engineBinary;
  if (stored !== undefined && (await probe(stored)) > 0) return stored;
  return undefined;
}

/** Remove a downloaded archive once it has been unpacked (a 693 MB zip is not a keepsake). */
export async function discardArchive(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Look for a file the user dropped for one asset, by **name only**, in the two
 * directories this plugin owns: the download dir and the models dir. The web
 * layer resolves a dropped file through here rather than accepting a path from
 * the wire, so no HTTP client can name a file to read or to move.
 */
export async function findDropped(layout: ProvisionLayout, file: string): Promise<string | undefined> {
  const wanted = safeSegment(file);
  for (const dir of [layout.downloadDir(), layout.modelsDir, layout.root]) {
    const candidate = join(dir, wanted);
    if (await sizeOf(candidate) > 0) return candidate;
  }
  return undefined;
}
