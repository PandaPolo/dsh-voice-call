/**
 * The audio artifact store: plain files under `audioDir` (`~/.dsh/voice`).
 * Following the attachment/image-ref pattern, raw audio never enters the
 * session log — the store commits bytes to disk and the log carries only a
 * compact {@link AudioRef}. Files are ordinary and deletable: the user can
 * `rm` any artifact and the UI degrades to a transcript-only card.
 *
 * @module dsh-voice/audio
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import type { AudioRef } from './types.ts';

/** The default audio root: `~/.dsh/voice` (or `$DSH_HOME/voice`). */
export function defaultAudioDir(): string {
  return join(resolveDshHome(), 'voice');
}

/** Resolve the effective audio root from config (empty string = default). */
export function resolveAudioDir(configured: string | undefined): string {
  const raw = configured !== undefined && configured !== '' ? configured : defaultAudioDir();
  return expandHomePath(raw);
}

/** MIME type by file extension (the set dsh-voice produces or reads). */
export function mimeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.m4a': return 'audio/mp4';
    case '.aiff': case '.aif': return 'audio/aiff';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.caf': return 'audio/x-caf';
    case '.txt': case '.json': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

/**
 * The audio store for one plugin instance. Paths are confined to the root:
 * any reference that would escape (via `..` or an absolute path) is rejected,
 * so a crafted ref can never make the web route read outside audioDir.
 */
export class AudioStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** The store root (created lazily on first write). */
  get rootDir(): string {
    return this.root;
  }

  /** Ensure the root exists. */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /**
   * Resolve a store-relative or absolute-under-root path to an absolute path.
   * @throws when the path escapes the root.
   */
  resolve(rel: string): string {
    if (isAbsolute(rel)) {
      const candidate = resolve(rel);
      const root = resolve(this.root);
      if (candidate === root || candidate.startsWith(`${root}${sep}`)) return candidate;
      throw new Error(`dsh-voice: audio path escapes the audio root: ${rel}`);
    }
    const candidate = resolve(this.root, rel);
    const root = resolve(this.root);
    if (candidate === root || candidate.startsWith(`${root}${sep}`)) return candidate;
    throw new Error(`dsh-voice: audio path escapes the audio root: ${rel}`);
  }

  /**
   * Commit one audio file into the root under `name` (basename only).
   * @returns the durable ref for the session log.
   */
  async commit(srcPath: string, name: string, extra?: { readonly durationMs?: number }): Promise<AudioRef> {
    const safeName = basename(name);
    await this.ensure();
    const dest = join(this.root, safeName);
    await copyFile(srcPath, dest);
    return { path: dest, mime: mimeForPath(dest), ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}) };
  }

  /** A fresh artifact path under the root (not yet written). */
  pathFor(kind: string, ext: string): string {
    return join(this.root, `${kind}.${ext.replace(/^\./, '')}`);
  }

  /** Whether a store-confined file currently exists. */
  async exists(refPath: string): Promise<boolean> {
    try {
      const resolved = this.resolve(refPath);
      const info = await stat(resolved);
      return info.isFile();
    } catch {
      return false;
    }
  }

  /** The basename of a store-confined path (safe for URLs). */
  basenameOf(refPath: string): string {
    return basename(this.resolve(refPath));
  }
}

/**
 * The check a caller-supplied audio path has to pass, phrased so the refusal is
 * actionable. {@link AudioStore.resolve} holds the rule; this adds the way out,
 * because the message is what the agent reads back.
 */
export function confineAudioInput(root: string, file: string): string {
  try {
    return new AudioStore(root).resolve(file);
  } catch {
    throw new Error(
      `dsh-voice: source.file has to sit inside the audio directory (${root}). `
      + 'Move the audio there first, or use source.record to capture it.',
    );
  }
}

/** True when the path lies under the audio root (used by the web route). */
export function isUnderRoot(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(`${r}${sep}`);
}

/** Relative store path of an absolute artifact path (for display/URLs). */
export function relOf(root: string, absolute: string): string {
  const r = resolve(root);
  const c = resolve(absolute);
  if (c === r) return '';
  if (c.startsWith(`${r}${sep}`)) return c.slice(r.length + 1);
  return dirname(c) === r ? basename(c) : c;
}
