/**
 * Segmented download: several ranges in flight, across several origins.
 *
 * **What this is for is resilience, not speed.** The measured rates on the link
 * this plugin targets vary by an order of magnitude between *attempts*, not
 * between routes (`node .verify-backup/net/concurrency.mjs`,
 * `node .verify-backup/net/throttle.mjs`):
 *
 *   hf-mirror.com, one stream, four separate runs:  4.75 / 18–20 / 30–33 / 63 MB/s
 *   github.com release asset:                       0 of 6 connects, then 1.44 MB/s
 *   gh-proxy.com:                                   0.20 single, 0.45 with 8 lanes
 *
 * So no sample predicts the next one, and a single lane means one unlucky
 * attempt — a proxy that answers 200 with an empty body, a connect that stalls,
 * a mirror that has begun throttling — decides the fate of the whole file. With
 * segments, such an attempt costs one segment: the lane rotates to the next
 * origin, the finished ones stay finished.
 *
 * What it is *not*: a proven throughput win. On one sample eight lanes on
 * hf-mirror were **2.5× slower** than one stream (24.8 vs 63 MB/s), and on
 * another eight lanes were 6× faster (30.9 vs 4.75). Both are real. Four lanes
 * is the compromise: enough redundancy that a dead attempt is not a dead run,
 * few enough that a healthy route is not smothered. The user can raise it.
 *
 * The claim this file does *not* settle is whether the model mirror throttles by
 * accumulated traffic (先快后慢). Its own quota behaviour is not observable from
 * these samples, and a download that collapses halfway is exactly the case the
 * segment bitmap exists to survive: cancel, wait, click again, and keep every
 * segment already paid for.
 *
 * The parts that are deliberate:
 *
 * - **Work-stealing over fixed segments**, not a static N-way split. Lane rates
 *   vary 4× within a single test, so a fixed split would finish when its
 *   slowest lane did; workers claim the next segment when they are free.
 * - **Origins shared, not pinned**: each lane rotates the candidate list from
 *   its own offset, so lanes spread across mirrors by themselves and a dead
 *   origin cannot block everyone.
 * - **A bitmap of finished segments** in a sidecar (`<dest>.part.json`): a byte
 *   prefix cannot describe a download that finished the middle before the start.
 * - **The file is still verified once**, against the manifest digest. There is
 *   no per-segment digest to check, so garbage from one lane is caught at the
 *   end and the asset is re-fetched — bounded by one re-download, not by trust.
 *
 * @module dsh-voice-call/provision/segmented
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DownloadError, globalFetch, partPath } from './download.ts';
import type { FetchLike } from './download.ts';
import type { Candidate } from './manifest.ts';

/** 4 MiB: small enough that lanes finish at different times and can be re-claimed. */
export const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
/**
 * Four lanes. Enough that one dead attempt cannot kill a run — the failure mode
 * actually observed here is an origin answering 200 with nothing behind it — and
 * few enough that a healthy route is not smothered by its own concurrency. See
 * the module header for why this is not tuned for peak throughput.
 */
export const DEFAULT_CONNECTIONS = 4;
/** Below this many bytes, splitting costs more handshakes than it saves. */
export const MIN_SEGMENTED_BYTES = 8 * 1024 * 1024;


/** A segment the workers have not finished yet. */
export interface Segment {
  readonly index: number;
  readonly from: number;
  readonly to: number;
}

/** The split of one file into claimable segments. */
export function planSegments(total: number, size: number = DEFAULT_SEGMENT_BYTES): Segment[] {
  if (total <= 0 || size <= 0) return [];
  const count = Math.ceil(total / size);
  return Array.from({ length: count }, (_unused, index) => ({
    index,
    from: index * size,
    to: Math.min(total, (index + 1) * size) - 1,
  }));
}

/** The resumable record of which segments have landed. */
export interface SegmentState {
  readonly total: number;
  readonly size: number;
  readonly done: boolean[];
}

export function statePath(dest: string): string {
  return `${partPath(dest)}.json`;
}

/** Read a sidecar; a mismatched total/size means the plan changed, so start clean. */
export async function loadState(dest: string, total: number, size: number): Promise<SegmentState> {
  const fresh: SegmentState = { total, size, done: Array.from({ length: planSegments(total, size).length }, () => false) };
  try {
    const parsed = JSON.parse(await readFile(statePath(dest), 'utf8')) as Partial<SegmentState>;
    if (parsed.total !== total || parsed.size !== size || !Array.isArray(parsed.done)) return fresh;
    // The caller has already confirmed the `.part` is present at full length, so
    // a recorded segment really is on disk.
    return { ...fresh, done: fresh.done.map((_unused, index) => parsed.done?.[index] === true) };
  } catch {
    return fresh;
  }
}

async function saveState(dest: string, state: SegmentState): Promise<void> {
  const path = statePath(dest);
  await writeFile(`${path}.tmp`, JSON.stringify({ total: state.total, size: state.size, done: state.done }), 'utf8');
  await rename(`${path}.tmp`, path);
}

async function sizeOfOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Progress across the whole segmented run. */
export interface SegmentedProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly bytesPerSecond: number;
  readonly lanes: number;
  readonly origins: readonly string[];
}

export interface SegmentedOptions {
  readonly candidates: readonly Candidate[];
  readonly dest: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly connections?: number;
  readonly segmentBytes?: number;

  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SegmentedProgress) => void;
  readonly fetchImpl?: FetchLike;
  readonly stallMs?: number;
  readonly firstByteMs?: number;
  readonly now?: () => number;
}

export interface SegmentedOutcome {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly origins: readonly string[];
  readonly lanes: number;
  readonly segments: number;
  readonly elapsedMs: number;
  readonly bytesPerSecond: number;
}

/**
 * Fetch `dest` with `connections` concurrent range lanes.
 *
 * @throws {DownloadError} when a segment cannot be delivered by any candidate, or
 * the assembled file fails its digest.
 */
export async function downloadSegmented(options: SegmentedOptions): Promise<SegmentedOutcome> {
  const fetchImpl = options.fetchImpl ?? globalFetch;
  const now = options.now ?? Date.now;
  const started = now();
  const size = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
  const lanes = Math.max(1, Math.min(options.connections ?? DEFAULT_CONNECTIONS, 16));
  const segments = planSegments(options.expectedBytes, size);
  if (segments.length === 0) throw new DownloadError('size', '清单里的体积不是正数');
  await mkdir(dirname(options.dest), { recursive: true });
  const part = partPath(options.dest);
  // A bitmap is only worth trusting while the file it describes is still there
  // at full length: a cleaned-up `.part` must not resume as a hole-filled file.
  const have = await sizeOfOrZero(part);
  const state = have === options.expectedBytes
    ? await loadState(options.dest, options.expectedBytes, size)
    : { total: options.expectedBytes, size, done: Array.from({ length: planSegments(options.expectedBytes, size).length }, () => false) };
  if (have !== options.expectedBytes) {
    // Create-if-absent first: `truncate` needs the file to exist, and opening
    // with 'w' would throw away the bytes a resumed run is trying to keep.
    const created = await open(part, 'a');
    await created.close();
    // Pre-allocate: lanes write at arbitrary offsets, so the file must already
    // be as long as the asset before the first write lands.
    await truncate(part, options.expectedBytes);
  }
  const handle = await open(part, 'r+');
  const queue = segments.filter((_segment, index) => state.done[index] !== true).values();
  const usedOrigins = new Set<string>();
  let received = countDone(state, size, options.expectedBytes);
  let lastEmit = 0;
  const emit = (force: boolean): void => {
    if (!force && now() - lastEmit < 250) return;
    lastEmit = now();
    const elapsed = Math.max(1, now() - started);
    options.onProgress?.({
      receivedBytes: received,
      totalBytes: options.expectedBytes,
      bytesPerSecond: (received / elapsed) * 1000,
      lanes,
      origins: [...usedOrigins],
    });
  };

  try {
    await Promise.all(Array.from({ length: Math.min(lanes, segments.length) }, async (_unused, lane) => {
      for (;;) {
        if (options.signal?.aborted === true) throw new DownloadError('aborted', '已取消');
        // `next()` is synchronous, so two lanes can never claim one segment.
        const segment = queue.next().value as Segment | undefined;
        if (segment === undefined) return;
        let lastError: DownloadError | undefined;
        // Rotate the candidate list per lane so concurrent lanes do not all pile
        // onto the same mirror and throttle each other further.
        for (let attempt = 0; attempt < options.candidates.length; attempt += 1) {
          const candidate = options.candidates[(attempt + lane) % options.candidates.length];
          if (candidate === undefined) continue;
          try {
            const written = await fetchRange({
              candidate, segment, handle, fetchImpl, options, now,
              onBytes: (bytes) => {
                received += bytes;
                emit(false);
              },
            });
            if (written !== segment.to - segment.from + 1) {
              throw new DownloadError('size', `分段 ${segment.index} 只收到 ${written} 字节`, { origin: candidate.origin });
            }
            state.done[segment.index] = true;
            usedOrigins.add(candidate.origin);
            emit(false);
            lastError = undefined;
            break;
          } catch (error) {
            const failure = error instanceof DownloadError ? error : new DownloadError('server', messageOf(error), { origin: candidate.origin });
            if (failure.reason === 'aborted') throw failure;
            lastError = failure;
          }
        }
        if (lastError !== undefined) throw lastError;
      }
    }));
  } finally {
    await handle.close();
    // Persist the bitmap on the way out, not only on the way through — that was
    // the entire defect here. The sidecar exists for the run that got cancelled
    // at 60 % or lost every lane to a throttling mirror; writing it only after
    // the lanes had all returned meant the next run found the pre-allocated
    // `.part` at full length, no bitmap to believe in, and paid for the whole
    // 1.95 GB again, while `adviceFor` was still promising 从断点继续. A segment
    // is marked done only once its bytes have been written, so what lands here is
    // never a lie about a partial range. Best-effort: a sidecar that cannot be
    // written costs a re-download, whereas letting its error escape would bury
    // the download failure the card needs to read.
    await saveState(options.dest, state).catch(() => undefined);
    emit(true);
  }

  const digest = await hashFile(part);
  if (digest.toLowerCase() !== options.expectedSha256.toLowerCase()) {
    // The bitmap and the file are both untrustworthy now: start the next run clean.
    await rm(part, { force: true });
    await rm(statePath(options.dest), { force: true });
    throw new DownloadError('checksum', `校验和不符（收到 ${digest.slice(0, 12)}…）`);
  }
  await rename(part, options.dest);
  await rm(statePath(options.dest), { force: true });
  const elapsedMs = Math.max(1, now() - started);
  return {
    path: options.dest,
    bytes: options.expectedBytes,
    sha256: digest,
    origins: [...usedOrigins],
    lanes,
    segments: segments.length,
    elapsedMs,
    bytesPerSecond: (options.expectedBytes / elapsedMs) * 1000,
  };
}

/** One lane's range fetch, written at its offset. */
async function fetchRange(input: {
  readonly candidate: Candidate;
  readonly segment: Segment;
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly fetchImpl: FetchLike;
  readonly options: SegmentedOptions;
  readonly now: () => number;
  readonly onBytes: (bytes: number) => void;
}): Promise<number> {
  const { candidate, segment, handle, fetchImpl, options, now, onBytes } = input;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  let stalled: 'first-byte' | 'stalled' | undefined;
  let timer = setTimeout(() => {
    stalled = 'first-byte';
    controller.abort();
  }, options.firstByteMs ?? 15_000);
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = 'stalled';
      controller.abort();
    }, options.stallMs ?? 30_000);
  };
  let written = 0;
  try {
    const response = await fetchImpl(candidate.url, {
      headers: { range: `bytes=${segment.from}-${segment.to}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    arm();
    if (response.status === 404 || response.status === 403) {
      throw new DownloadError('not-found', `来源没有这个文件（HTTP ${response.status}）`, { origin: candidate.origin });
    }
    if (response.status !== 206) {
      // A server that ignores Range would hand us the file from byte 0, which is
      // the wrong slice for this lane; treat it as unusable rather than corrupt.
      throw new DownloadError('server', `不支持分段读取（HTTP ${response.status}）`, { origin: candidate.origin });
    }
    if (response.body === null) throw new DownloadError('server', '响应没有正文', { origin: candidate.origin });
    let offset = segment.from;
    for await (const chunk of response.body) {
      await handle.write(chunk, 0, chunk.byteLength, offset);
      offset += chunk.byteLength;
      written += chunk.byteLength;
      onBytes(chunk.byteLength);
      arm();
    }
    return written;
  } catch (error) {
    if (options.signal?.aborted === true) throw new DownloadError('aborted', '已取消', { origin: candidate.origin });
    if (stalled !== undefined) {
      throw new DownloadError(stalled, stalled === 'stalled' ? '这一段传不下去了' : '连不上这个来源', {
        origin: candidate.origin, receivedBytes: written,
      });
    }
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('server', messageOf(error), { origin: candidate.origin, receivedBytes: written });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function countDone(state: SegmentState, size: number, total: number): number {
  return state.done.reduce((sum, flag, index) => (flag ? sum + (Math.min(total, (index + 1) * size) - index * size) : sum), 0);
}

/** The streaming sha256 of an assembled file. */
async function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectHash);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk as Buffer));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a file is big enough to be worth splitting. */
export function shouldSegment(bytes: number): boolean {
  return bytes >= MIN_SEGMENTED_BYTES;
}
