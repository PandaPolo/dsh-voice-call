/**
 * The provisioning client transport: the browser half of `/voice/provision`.
 * Same-origin `fetch` / `EventSource` only, and every type here is a *mirror* of
 * a server shape — the client never receives or sends a URL, a size or a digest,
 * only the identifiers the server resolves against the manifest.
 *
 * The card re-renders off the streamed view, so a run keeps updating even while
 * the user is looking away; `GET /state` on open covers the case where the run
 * finished before the stream was established.
 *
 * @module dsh-voice-call/client/provision-api
 */

/** One step of a run, as the server reports it. */
export interface StepView {
  readonly id: 'engine' | 'talker' | 'codec';
  readonly label: string;
  readonly status: 'ready' | 'queued' | 'downloading' | 'installing' | 'failed' | 'cancelled';
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly bytesPerSecond: number;
  readonly origin: string;
  readonly remainingSeconds?: number;
  readonly manualRecommended: boolean;
  readonly message?: string;
  readonly advice?: string;
}

/** The whole run's view — the payload of `GET /state` and every SSE frame. */
export interface ProvisionView {
  readonly phase: 'unknown' | 'unprepared' | 'preparing' | 'ready' | 'failed' | 'cancelled';
  readonly variantId: string;
  readonly steps: readonly StepView[];
  readonly remainingBytes: number;
  readonly receivedBytes: number;
  readonly updatedAt: number;
  readonly summary: string;
}

/** One engine build the server may install. */
export interface VariantOption {
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly gpu: 'none' | 'vulkan' | 'cuda12';
  readonly note: string;
  /** Whether *this* machine can run it; the rest are shown but disabled. */
  readonly offered: boolean;
  /** Why not, in the words the dropdown shows. */
  readonly whyNot: string;
}

/** Everything the 运行环境 section renders besides the view. */
export interface ProvisionCatalogue {
  /** One line from the engine's own `--diagnostics`. */
  readonly device: string;
  /**
   * What the server would act on now: the build and model pair it found on disk,
   * or what this machine should get when the root is empty. The dropdowns start
   * here, so the card never shows a choice the plugin does not intend to honour.
   */
  readonly selection: { variantId: string; talkerFile: string; codecQuant: string; policy: string };
  readonly variants: readonly VariantOption[];
  readonly models: readonly { role: string; file: string; quant: string; bytes: string; label: string; note: string; backend: string; isDefault: boolean }[];
  readonly sources: readonly { policy: string; label: string; proxies: readonly string[] }[];
  readonly dropDir: string;
  /** Whether the plugin already speaks via paths the user wrote into its config. */
  readonly usableFromConfig: boolean;
}

/** What the card opens with: the current view plus what it may offer. */
export interface ProvisionState {
  readonly view: ProvisionView;
  readonly catalogue: ProvisionCatalogue;
}

/** A selection the card may send — identifiers only. */
export interface ProvisionSelection {
  readonly variantId?: string;
  /** The talker file to install; the engine backend moves with it. */
  readonly talkerFile?: string;
  readonly codecQuant?: string;
  readonly policy?: string;
  readonly proxyPrefix?: string;
  readonly only?: readonly ('engine' | 'talker' | 'codec')[];
}

/** A mutation reply. */
export interface ProvisionAck {
  readonly view?: ProvisionView;
  readonly ok?: boolean;
  readonly message?: string;
}

/** Read the current provisioning state; `undefined` when the routes are absent. */
export async function fetchProvisionState(): Promise<ProvisionState | undefined> {
  try {
    const response = await fetch('/voice/provision/state', { headers: { accept: 'application/json' } });
    if (!response.ok) return undefined;
    return await response.json() as ProvisionState;
  } catch {
    return undefined;
  }
}

/** Start (or resume) a run. The view that follows arrives over the stream. */
export async function startProvision(selection: ProvisionSelection): Promise<ProvisionAck> {
  return postJson('/voice/provision/prepare', selection);
}

/** Stop the run, keeping the downloaded bytes for a later resume. */
export async function cancelProvision(): Promise<ProvisionAck> {
  return postJson('/voice/provision/cancel', {});
}

/**
 * Ask what a hypothetical selection would cost. Nothing downloads; the server
 * re-reads the root with that choice and answers with the view for it, so the
 * rows and the button's byte total describe the build the dropdown is showing.
 */
export async function previewProvision(selection: ProvisionSelection): Promise<ProvisionAck> {
  return postJson('/voice/provision/preview', selection);
}

/** Verify and take in a file placed in the drop directory. */
export async function adoptProvision(role: StepView['id'], selection: ProvisionSelection): Promise<ProvisionAck> {
  return postJson('/voice/provision/adopt', { role, ...selection });
}

async function postJson(url: string, payload: unknown): Promise<ProvisionAck> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({})) as ProvisionAck & { message?: string };
    if (!response.ok && body.message === undefined) {
      return { ok: false, message: `HTTP ${response.status}` };
    }
    return body;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Backoff bounds for the reconnect loop (ms), matching the call-card policy. */
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * Follow the run. Returns the disposer; call it when the section unmounts so a
 * closed card holds no open stream.
 */
export function connectProvisionEvents(onView: (view: ProvisionView) => void): () => void {
  let source: EventSource | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let delay = RECONNECT_MIN_MS;
  let disposed = false;

  const open = (): void => {
    if (disposed) return;
    source = new EventSource('/voice/provision/events');
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        onView(JSON.parse(event.data) as ProvisionView);
      } catch {
        // A malformed frame is dropped; the next one carries the full view.
      }
    };
    source.addEventListener('open', () => {
      delay = RECONNECT_MIN_MS;
    });
    source.addEventListener('error', () => {
      // A permanent close (no routes on this host) needs the manual loop;
      // transient drops keep the browser's own auto-reconnect.
      if (disposed || source === null || source.readyState !== EventSource.CLOSED) return;
      source.close();
      source = null;
      reconnect = setTimeout(open, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    });
  };

  open();
  return () => {
    disposed = true;
    clearTimeout(reconnect);
    source?.close();
    source = null;
  };
}

/** One group's footprint, as the server measured it. */
export interface GroupUsage {
  readonly id: 'engine' | 'models' | 'cache';
  readonly label: string;
  readonly path: string;
  readonly bytes: number;
  readonly entries: number;
  readonly present: boolean;
}

/** What the voice root holds. */
export interface DiskUsage {
  readonly root: string;
  readonly groups: readonly GroupUsage[];
  readonly totalBytes: number;
  readonly busy: boolean;
}

/** The reply to a cleanup. */
export interface CleanupReply {
  readonly ok?: boolean;
  readonly message?: string;
  readonly needConfirm?: boolean;
  readonly usage?: DiskUsage;
  readonly freedBytes?: number;
  readonly removed?: readonly { id: string; bytes: number }[];
  readonly failed?: readonly { id: string; bytes: number; reason?: string }[];
}

/** Ask what is taking the space. Cheap enough to run when the panel opens. */
export async function fetchDiskUsage(): Promise<DiskUsage | undefined> {
  const response = await fetch('/voice/provision/disk', { headers: { accept: 'application/json' } });
  if (!response.ok) return undefined;
  return await response.json() as DiskUsage;
}

/**
 * Delete the named groups under the voice root.
 *
 * `confirm` is a real argument rather than a header trick: the server answers an
 * unconfirmed call with the usage report instead of an empty folder, so a client
 * bug cannot turn into data loss.
 */
export async function cleanupGroups(groups: readonly string[], confirm: boolean): Promise<CleanupReply> {
  const response = await fetch('/voice/provision/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groups, confirm }),
  });
  return await response.json() as CleanupReply;
}
