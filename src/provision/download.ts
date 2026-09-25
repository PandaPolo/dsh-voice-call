/**
 * The provisioning downloader: one asset, several origins, resumable, verified.
 *
 * The design follows the measured link rather than the happy path (see
 * `manifest.ts`): a GitHub release stalls on connect and a hf-mirror body runs
 * at 2.7 MB/s, so the two things that matter are *rotating origins fast* and
 * *not losing the bytes already paid for*. Hence:
 *
 * - a **stall** budget (no bytes for N ms) instead of a total timeout — a 693 MB
 *   download is fine, a connection that produced nothing for 30 s is not;
 * - a **`.part`** sibling kept across failures and resumed with `Range`, so the
 *   next origin attempt continues where the last one stopped;
 * - **verification after the body lands** (`hashFile`), not while it streams:
 *   one code path, and the resume logic carries no hash state to get wrong;
 * - a **digest mismatch deletes the `.part`** and rotates origins, because
 *   bytes that are wrong are not worth resuming.
 *
 * `fetchImpl` is injectable so the tests run against a local `node:http` server
 * with the real file I/O — no network, and no mock that would drift from
 * undici's behaviour.
 *
 * @module dsh-voice-call/provision/download
 */
import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname } from 'node:path';
import { servesCanonicalBytes } from './manifest.ts';
import type { Candidate } from './manifest.ts';

/** The suffix of an in-flight download; safe to keep, never a final artifact. */
export const PART_SUFFIX = '.part';

/**
 * Throughput floor, judged once `SLOW_PROBE_BYTES` have arrived.
 *
 * A first-byte race picks the origin that *answered* fastest, which turned out
 * not to be the origin that *delivers* fastest: on the measured link the
 * quickest-to-answer accelerator sustained ~50 KB/s while a slower-to-answer
 * one did 0.6 MB/s. So the running download re-judges its own lane early and
 * gives it up rather than committing an hour to 8 MB.
 *
 * The probe is deliberately small: at 80 KB/s it costs ~6 s to notice, against
 * ~100 s to finish an 8 MB archive at that speed.
 */
export const SLOW_PROBE_BYTES = 512_000;
export const SLOW_MIN_BYTES_PER_SECOND = 80_000;

/** No bytes for this long ⇒ this origin is done for, rotate. */
export const DEFAULT_STALL_MS = 30_000;
/** No response headers this fast ⇒ the connect is stuck (the GitHub failure mode). */
export const DEFAULT_FIRST_BYTE_MS = 15_000;
/** Progress callbacks are coalesced to this cadence. */
export const PROGRESS_INTERVAL_MS = 250;

/** Why a fetch did not produce the expected file. */
export type FailureReason =
  | 'aborted'
  | 'stalled'
  | 'slow'
  | 'first-byte'
  | 'not-found'
  | 'server'
  | 'size'
  | 'checksum'
  | 'unsupported';

/** A download failure that the UI can act on, not just display. */
export class DownloadError extends Error {
  readonly reason: FailureReason;
  readonly origin: string;
  readonly receivedBytes: number;
  readonly details: readonly string[];

  constructor(reason: FailureReason, message: string, init: {
    readonly origin?: string;
    readonly receivedBytes?: number;
    readonly details?: readonly string[];
  } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.reason = reason;
    this.origin = init.origin ?? '';
    this.receivedBytes = init.receivedBytes ?? 0;
    this.details = init.details ?? [];
  }
}

/** A progress tick, in bytes and bytes/second over the whole attempt. */
export interface DownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly bytesPerSecond: number;
  readonly origin: string;
  readonly resumedFrom: number;
}

/** The slice of `fetch` this module needs; tests satisfy it directly. */
export interface FetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
}

export type FetchLike = (url: string, init: {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}) => Promise<FetchResponse>;

/** The global fetch, narrowed to {@link FetchLike}. */
export const globalFetch: FetchLike = (url, init) => fetch(url, init).then((response) => ({
  status: response.status,
  headers: response.headers,
  // undici's body is async-iterable at runtime; the published types describe
  // the WHATWG surface, which does not, so the narrowing happens once here.
  body: response.body === null ? null : response.body as unknown as AsyncIterable<Uint8Array>,
}));

/** What one successful download cost and proved. */
export interface DownloadOutcome {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly origin: string;
  readonly resumedFrom: number;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly bytesPerSecond: number;
  readonly triedOrigins: readonly string[];
}

export interface DownloadOptions {
  /** Ordered by {@link candidatesFor}; the first usable one wins. */
  readonly candidates: readonly Candidate[];
  /** The final path; written only after verification passes. */
  readonly dest: string;
  readonly expectedBytes: number;
  /** Lowercase hex, from the manifest. */
  readonly expectedSha256: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly fetchImpl?: FetchLike;
  readonly stallMs?: number;
  readonly firstByteMs?: number;
  readonly progressIntervalMs?: number;
  /** Throughput floor overrides, so the slow-lane bail is testable on a small body. */
  readonly slowProbeBytes?: number;
  readonly slowMinBytesPerSecond?: number;
  readonly now?: () => number;
}

/** The in-flight sibling of a destination path. */
export function partPath(dest: string): string {
  return `${dest}${PART_SUFFIX}`;
}

/** Current size of a path, or 0 when it does not exist. */
export async function sizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/**
 * The streaming sha256 of a file, lowercase hex. Used both to verify a fresh
 * download and to recognise an asset the user placed by hand.
 */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectHash);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk as Buffer));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

/** Whether a file is byte-for-byte the asset the manifest describes. */
export async function matchesAsset(path: string, expectedBytes: number, expectedSha256: string): Promise<boolean> {
  if (await sizeOf(path) !== expectedBytes) return false;
  return (await hashFile(path)).toLowerCase() === expectedSha256.toLowerCase();
}

/**
 * Fetch one asset into `dest`, trying each candidate origin until one delivers
 * the expected bytes and digest.
 *
 * @throws {DownloadError} with the reason of the last meaningful failure, and
 * `details` naming every origin that was tried.
 */
export async function downloadAsset(options: DownloadOptions): Promise<DownloadOutcome> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalFetch;
  const startedAt = now();
  const candidates = dedupeCandidates(options.candidates);
  if (candidates.length === 0) {
    throw new DownloadError('unsupported', '没有可用的下载地址');
  }
  await mkdir(dirname(options.dest), { recursive: true });
  const part = partPath(options.dest);
  const details: string[] = [];
  let attempts = 0;
  let last: DownloadError | undefined;

  for (const [index, candidate] of candidates.entries()) {
    if (options.signal?.aborted === true) {
      throw new DownloadError('aborted', '已取消', { origin: candidate.origin, details });
    }
    attempts += 1;
    // The last origin is never abandoned for being slow. On a link where every
    // route crawls, rotating through all of them and failing would be strictly
    // worse than finishing at the slow rate — the floor exists to exploit a
    // better route while one is still untried, not to declare victory impossible.
    const mayBailForRate = index < candidates.length - 1;
    try {
      const outcome = await attemptFetch({
        candidate, options, part, fetchImpl, now,
        startedAt, attempts, mayBailForRate, triedOrigins: candidates.slice(0, attempts).map((entry) => entry.origin),
      });
      return { ...outcome, attempts, triedOrigins: candidates.slice(0, attempts).map((entry) => entry.origin) };
    } catch (error) {
      const failure = asDownloadError(error);
      last = failure;
      details.push(`${candidate.origin}: ${failure.message}`);
      // A user cancel is never a network problem: report it, do not rotate.
      if (failure.reason === 'aborted') throw failure;
    }
  }
  throw new DownloadError(last?.reason ?? 'server', [
    `所有来源都没能拿到这个文件（已试 ${attempts} 次）`,
    last?.message ?? '',
  ].filter((line) => line !== '').join('：'), {
    origin: last?.origin ?? candidates[0]?.origin ?? '',
    receivedBytes: last?.receivedBytes ?? 0,
    details,
  });
}

interface AttemptInput {
  readonly candidate: Candidate;
  readonly options: DownloadOptions;
  readonly part: string;
  readonly fetchImpl: FetchLike;
  readonly now: () => number;
  readonly startedAt: number;
  readonly attempts: number;
  readonly triedOrigins: readonly string[];
  readonly mayBailForRate: boolean;
}

/** One origin's turn: resume, stream to `.part`, then verify. */
async function attemptFetch(input: AttemptInput): Promise<Omit<DownloadOutcome, 'attempts' | 'triedOrigins'>> {
  const { candidate, options, part, fetchImpl, now } = input;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const firstByteMs = options.firstByteMs ?? DEFAULT_FIRST_BYTE_MS;
  const before = await sizeOf(part);
  // Only an origin that serves the upstream bytes verbatim may be resumed
  // against. A prefix accelerator answers a Range request relative to *its own*
  // body — its landing page, or its own copy of a moved release — so continuing
  // there would splice foreign bytes onto a good prefix and only fail at the
  // digest, after burning the whole transfer.
  const resumable = servesCanonicalBytes(candidate.kind)
    && before > 0 && before < options.expectedBytes;
  const from = resumable ? before : 0;

  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort);
  let expired: 'first-byte' | 'stalled' | undefined;
  let timer = setTimeout(() => {
    expired = 'first-byte';
    controller.abort();
  }, firstByteMs);
  const armStallTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      expired = 'stalled';
      controller.abort();
    }, stallMs);
  };

  try {
    const response = await fetchImpl(candidate.url, {
      ...(from > 0 ? { headers: { range: `bytes=${from}-` } } : {}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    armStallTimer();

    const decision = classifyResponse(response.status, from, options.expectedBytes);
    if (decision.kind === 'reject') {
      throw new DownloadError(decision.reason, decision.message, { origin: candidate.origin, receivedBytes: from });
    }
    // A server that ignored our Range restarts the file from zero.
    const start = decision.kind === 'resume' ? from : 0;
    const total = declaredTotal(response, decision.kind === 'resume');
    if (total !== null && total !== options.expectedBytes) {
      throw new DownloadError('size', `来源声明的体积是 ${total} 字节，和清单里的 ${options.expectedBytes} 字节不符`, {
        origin: candidate.origin,
      });
    }
    if (response.body === null) {
      throw new DownloadError('server', '响应没有正文', { origin: candidate.origin });
    }

    let written = 0;
    let lastEmit = 0;
    let probeDone = false;
    const intervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    const handle = await open(part, start > 0 ? 'r+' : 'w');
    try {
      if (start > 0) await handle.truncate(start);
      written = start;
      const attemptStarted = now();
      for await (const chunk of response.body) {
        await handle.write(chunk, 0, chunk.byteLength, written);
        written += chunk.byteLength;
        armStallTimer();
        // Answering fast is not delivering fast: give up a lane that turns out
        // to crawl, while the file is still small enough for it to cost little.
        if (input.mayBailForRate && !probeDone && written - start >= (options.slowProbeBytes ?? SLOW_PROBE_BYTES)) {
          probeDone = true;
          const rate = ((written - start) / Math.max(1, now() - attemptStarted)) * 1000;
          if (rate < (options.slowMinBytesPerSecond ?? SLOW_MIN_BYTES_PER_SECOND)) {
            throw new DownloadError('slow', `${candidate.origin} 只有 ${(rate / 1024).toFixed(0)} KB/s`, {
              origin: candidate.origin, receivedBytes: written,
            });
          }
        }
        const elapsed = Math.max(1, now() - input.startedAt);
        if (now() - lastEmit >= intervalMs || written >= options.expectedBytes) {
          lastEmit = now();
          options.onProgress?.({
            receivedBytes: written,
            totalBytes: options.expectedBytes,
            bytesPerSecond: (written / elapsed) * 1000,
            origin: candidate.origin,
            resumedFrom: start,
          });
        }
      }
    } finally {
      await handle.close();
      clearTimeout(timer);
    }

    if (written < options.expectedBytes) {
      // Keep the bytes: the next origin resumes from here.
      throw new DownloadError('size', `只收到 ${written}/${options.expectedBytes} 字节`, {
        origin: candidate.origin, receivedBytes: written,
      });
    }

    const digest = await hashFile(part);
    if (digest.toLowerCase() !== options.expectedSha256.toLowerCase()) {
      await rm(part, { force: true });
      throw new DownloadError('checksum', `校验和不符（收到 ${digest.slice(0, 12)}…）`, { origin: candidate.origin });
    }
    await rename(part, options.dest);
    const elapsedMs = Math.max(1, now() - input.startedAt);
    return {
      path: options.dest,
      bytes: written,
      sha256: digest,
      origin: candidate.origin,
      resumedFrom: start,
      elapsedMs,
      bytesPerSecond: (written / elapsedMs) * 1000,
    };
  } catch (error) {
    clearTimeout(timer);
    if (options.signal?.aborted === true) {
      throw new DownloadError('aborted', '已取消', { origin: candidate.origin, receivedBytes: from });
    }
    if (expired !== undefined && error instanceof DownloadError === false) {
      throw new DownloadError(expired, expired === 'stalled' ? '传输中途停了' : '连不上这个来源', {
        origin: candidate.origin, receivedBytes: from,
      });
    }
    if (error instanceof DownloadError) throw error;
    // undici surfaces a connect/TLS failure as a plain Error with a useful message.
    throw new DownloadError('server', messageOf(error), { origin: candidate.origin, receivedBytes: from });
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Order candidates by measured *throughput*, not by shipped preference.
 *
 * A first-byte race turned out to rank the wrong thing: on the measured link
 * the origin that answered quickest sustained ~58 KB/s while a slower-to-answer
 * one did 0.6 MB/s, and shipping the first version cost 148 s for an 8 MB
 * archive that another lane finished in 66. So the race pulls a bounded sample
 * (first `RACE_SAMPLE_BYTES`) from every candidate at once and ranks by the rate
 * it actually delivered. The sample is what bounds the cost — each origin is cut
 * off after ~128 KB, so the whole race throws away at most `N × 128 KB`.
 *
 * Nothing is dropped: an origin that never answered keeps its original place at
 * the end, so the list stays a fallback chain rather than a gamble, and the
 * official URL remains reachable as the last attempt.
 */
export async function orderByThroughput<T extends { readonly url: string }>(
  candidates: readonly T[],
  options: { readonly fetchImpl?: FetchLike; readonly signal?: AbortSignal; readonly budgetMs?: number; readonly sampleBytes?: number; readonly now?: () => number } = {},
): Promise<T[]> {
  if (candidates.length < 2) return [...candidates];
  const fetchImpl = options.fetchImpl ?? globalFetch;
  const budgetMs = options.budgetMs ?? RACE_BUDGET_MS;
  const sampleBytes = options.sampleBytes ?? RACE_SAMPLE_BYTES;
  const started = options.now?.() ?? Date.now();
  const rates = new Map<T, number>();
  await Promise.all(candidates.map(async (candidate) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort);
    let bytes = 0;
    try {
      const response = await fetchImpl(candidate.url, {
        headers: { range: `bytes=0-${sampleBytes - 1}` },
        signal: controller.signal,
      });
      const body = response.body;
      if (body === null || response.status >= 400) return;
      for await (const chunk of body) {
        bytes += chunk.byteLength;
        // Enough of a sample to rank by: keep the bytes we did not take.
        if (bytes >= sampleBytes) break;
      }
      const elapsed = Math.max(1, (options.now?.() ?? Date.now()) - started);
      rates.set(candidate, (bytes / elapsed) * 1000);
    } catch {
      // unreachable, timed out, or cancelled: ranked by whatever it delivered
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (bytes > 0) {
        const elapsed = Math.max(1, (options.now?.() ?? Date.now()) - started);
        const partial = (bytes / elapsed) * 1000;
        if ((rates.get(candidate) ?? 0) < partial) rates.set(candidate, partial);
      }
    }
  }));
  return candidates
    .map((candidate, index) => ({ candidate, index, rate: rates.get(candidate) }))
    .sort((left, right) => {
      if (left.rate === undefined && right.rate === undefined) return left.index - right.index;
      if (left.rate === undefined) return 1;
      if (right.rate === undefined) return -1;
      return right.rate - left.rate || left.index - right.index;
    })
    .map((entry) => entry.candidate);
}

/** How much of each candidate the race samples, and how long it may take. */
export const RACE_SAMPLE_BYTES = 131_072;
export const RACE_BUDGET_MS = 8000;

/** How to treat a status code against the resume point we asked for. */
function classifyResponse(status: number, from: number, expectedBytes: number):
  { readonly kind: 'resume' } | { readonly kind: 'full' } | { readonly kind: 'reject'; readonly reason: FailureReason; readonly message: string } {
  if (status === 206) return from > 0 ? { kind: 'resume' } : { kind: 'full' };
  if (status === 200) return { kind: 'full' };
  if (status === 404 || status === 403) {
    return { kind: 'reject', reason: 'not-found', message: `来源说这个文件不存在或不可得（HTTP ${status}）` };
  }
  if (status === 416) {
    return { kind: 'reject', reason: 'size', message: `断点已经超出文件长度（${from}/${expectedBytes}）` };
  }
  if (status >= 500) return { kind: 'reject', reason: 'server', message: `来源出错（HTTP ${status}）` };
  return { kind: 'reject', reason: 'server', message: `意外的 HTTP ${status}` };
}

/** The total body size the origin claims, if it claims one. */
function declaredTotal(response: FetchResponse, resumed: boolean): number | null {
  const contentRange = response.headers.get('content-range');
  if (contentRange !== null) {
    const match = /\/(\d+)\s*$/.exec(contentRange);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  if (resumed) return null;
  const length = response.headers.get('content-length');
  if (length === null) return null;
  const parsed = Number(length);
  return Number.isFinite(parsed) ? parsed : null;
}

function dedupeCandidates(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    out.push(candidate);
  }
  return out;
}

function asDownloadError(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  return new DownloadError('server', messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
