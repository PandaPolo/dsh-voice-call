/**
 * The provisioning manifest: every byte dsh-voice-call may fetch, the digest
 * that proves it arrived intact, and the ordered origins that can serve it.
 *
 * Why this exists at all: the official 语音输入 plugin ships its weights inside
 * the bundle; ours cannot (1.2 GB of GGUF does not belong in an npm tarball),
 * so the plugin has to pull them at first run. That is only acceptable if the
 * fetch is *verifiable* and the source is chosen for the network the user is
 * actually on — which is what this file pins.
 *
 * Measurements behind the ordering (mainland-China link, 2026-09-25, re-runnable
 * with `node scripts/net-probe.mjs`):
 *
 *   origin                    result
 *   ------------------------  ---------------------------------------------------
 *   huggingface.co            connect timeout — unusable
 *   hf-mirror.com             0.5–2.7 MB/s, answers 206 on mid-file ranges
 *   github.com (release file) **intermittent**: 0/6 connects one hour, 0.6 MB/s
 *                             the next — fast whenever it connects at all
 *   api.github.com            9/9 in ~0.5s — metadata is fine, bytes are not
 *   gh-proxy.com              0.11–0.19 MB/s
 *   ghproxy.net               0.08–0.16 MB/s
 *   gh-proxy.org              0.05–0.09 MB/s, sometimes stalls
 *   ghproxy.link              200 with an empty body for release assets
 *   ghfast.top, mirror.ghproxy.com, gh.llkk.cc, github.moeyy.xyz,
 *   hub.gitmirror.com, kkgithub.com, gitclone.com   no usable response
 *
 * The order below is therefore *not* a ranking of mirrors — it is a fallback
 * chain, and `policy: 'auto'` measures it per asset with a bounded-throughput race
 * (`orderByThroughput`) before following it. Three consequences:
 * 1. Digests live *here*, not behind a network call, so verification never
 *    depends on a host the user may not be able to reach.
 * 2. The race drops nothing: an origin that did not answer simply moves to the
 *    back, so the official URL is always the last attempt and a dead mirror can
 *    never dead-end an install.
 * 3. The CUDA build (693 MB ⇒ hours through any working proxy) is offered but
 *    never defaulted — see `manualRecommended`.
 *
 * @module dsh-voice-call/provision/manifest
 */

/** The upstream whose release assets the engine entries were read from. */
export const ENGINE_REPO = 'CrispStrobe/CrispASR';
/** The release the digests below are pinned to; `detect` reports drift. */
export const ENGINE_TAG = 'v0.8.36';
/** The Hugging Face organisation publishing the GGUF ports the engine loads. */
export const MODEL_ORG = 'cstr';

/** The canonical origin hosts, used to rewrite URLs onto a mirror. */
export const GITHUB_HOST = 'https://github.com';
export const HUGGINGFACE_HOST = 'https://huggingface.co';

/** An engine build, one per (platform × accelerator) pair we are willing to install. */
export type EngineVariantId =
  | 'win-cpu'
  | 'win-cpu-legacy'
  | 'win-vulkan'
  | 'win-cuda'
  | 'win-cuda-non-cuda'
  | 'mac-cpu'
  | 'linux-cpu'
  | 'linux-vulkan';

/** What the build needs from the machine beyond a CPU. */
export type GpuRequirement = 'none' | 'vulkan' | 'cuda12';

/** A downloadable engine build, pinned by digest. */
export interface EngineVariant {
  readonly id: EngineVariantId;
  /** Dropdown label. */
  readonly label: string;
  readonly os: 'win32' | 'darwin' | 'linux';
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly gpu: GpuRequirement;
  /** Which unpacker the archive needs. */
  readonly archive: 'zip' | 'tar.gz';
  /** The executable's basename once unpacked (found by walking, not assumed). */
  readonly binary: string;
  /** Suggestion order within its platform: 1 is the default. */
  readonly rank: number;
  readonly note: string;
}

/** The engine builds we provision, with digests read from `api.github.com`. */
export const ENGINE_VARIANTS: readonly EngineVariant[] = [
  {
    id: 'win-cpu', label: 'Windows · CPU', os: 'win32',
    file: 'crispasr-windows-x86_64-cpu.zip', bytes: 8_659_961,
    sha256: '1d8c853d102671f4036ccf4da8573a6d9ed3d45ae4530aa07573760a4bc93dc1',
    gpu: 'none', archive: 'zip', binary: 'crispasr.exe', rank: 1,
    note: '8.3 MB，任何 x86_64 机器都能跑；合成比 GPU 慢，但装得快、不会卡在网络上的那一步',
  },
  {
    id: 'win-vulkan', label: 'Windows · Vulkan（N/A/Intel 均可）', os: 'win32',
    file: 'crispasr-windows-x86_64-vulkan.zip', bytes: 37_251_389,
    sha256: '659e6cc1d3d0c7d65e1ce2df61efd7295c5b017e8a95c4d340c20ba70793d9cc',
    gpu: 'vulkan', archive: 'zip', binary: 'crispasr.exe', rank: 2,
    note: '35.5 MB 就拿到 GPU 加速，不挑显卡；代理下约 3–5 分钟',
  },
  {
    id: 'win-cuda', label: 'Windows · CUDA（自包含，693 MB）', os: 'win32',
    file: 'crispasr-windows-x86_64-cuda.zip', bytes: 726_216_766,
    sha256: '4d14ce34cbc089259e897bed369214f6f920efa31e3236845bb6c7464ed7fba0',
    gpu: 'cuda12', archive: 'zip', binary: 'crispasr.exe', rank: 3,
    note: '最快，也只有 GitHub 一个来源：国内链路要跑一小时上下，建议手动下载后指路径',
  },
  {
    id: 'win-cuda-non-cuda', label: 'Windows · CUDA 引擎本体（不含 cuBLAS，139 MB）', os: 'win32',
    file: 'crispasr-windows-x86_64-cuda-non-cuda.zip', bytes: 146_032_254,
    sha256: '86436374a54825f3969416cdbec62e5f92fd646ae69f921402d7893624a7a7d1',
    gpu: 'cuda12', archive: 'zip', binary: 'crispasr.exe', rank: 4,
    note: '只给已经有 CUDA 运行库的机器：缺 cublas/cudart 三个 dll 就起不来，所以排在自包含版之后',
  },
  {
    id: 'win-cpu-legacy', label: 'Windows · CPU（老指令集，无 AVX2）', os: 'win32',
    file: 'crispasr-windows-x86_64-cpu-legacy.zip', bytes: 8_111_242,
    sha256: 'fb0b8555343daf434533e53d4eca2d10726f991f5014008e50af64607f184bd1',
    gpu: 'none', archive: 'zip', binary: 'crispasr.exe', rank: 5,
    note: '十三年前的 CPU、或 CPU 版报非法指令时换这个',
  },
  {
    id: 'mac-cpu', label: 'macOS · Apple Silicon', os: 'darwin',
    file: 'crispasr-macos.tar.gz', bytes: 17_047_196,
    sha256: '0a494b48759ce9756cb0e0fcf72c0beed4c00335f8ae081e571c93d480a500f9',
    gpu: 'none', archive: 'tar.gz', binary: 'crispasr', rank: 1,
    note: '16.3 MB；这是上游唯一的 macOS 包，是否带 Metal 未经实测，所以按 CPU 版对待',
  },
  {
    id: 'linux-cpu', label: 'Linux · x86_64 CPU', os: 'linux',
    file: 'crispasr-linux-x86_64.tar.gz', bytes: 40_360_545,
    sha256: '8c0547c07e900f9587fc68a947e4e37938745e6a8ecf6aa9e876cf3a98d18e0f',
    gpu: 'none', archive: 'tar.gz', binary: 'crispasr', rank: 1,
    note: '38.5 MB',
  },
  {
    id: 'linux-vulkan', label: 'Linux · Vulkan', os: 'linux',
    file: 'crispasr-linux-x86_64-vulkan.tar.gz', bytes: 74_286_719,
    sha256: '8eb99a0c7dde45aecf707a39aef84733df84af4d7f4531813cdaa898d0b5d59a',
    gpu: 'vulkan', archive: 'tar.gz', binary: 'crispasr', rank: 2,
    note: '70.8 MB，需要可用的 Vulkan 驱动',
  },
];

/** Look one engine build up by id. */
export function engineVariantById(id: string | undefined): EngineVariant | undefined {
  return id === undefined ? undefined : ENGINE_VARIANTS.find((variant) => variant.id === id);
}

/**
 * Whether an origin can be resumed against.
 *
 * A Range request is answered relative to the body the origin serves *itself*:
 * the upstream and a byte-for-byte mirror continue where we stopped, while a
 * prefix accelerator resumes into its landing page or its own copy of a moved
 * release. Splicing those bytes onto a good prefix only shows up at the digest,
 * after the whole transfer has been paid for — so a proxy always restarts.
 */
export function servesCanonicalBytes(kind: OriginKind): boolean {
  return kind === 'official' || kind === 'mirror';
}

/** A model file the engine loads, pinned by digest from the HF `lfs.sha256`. */
export interface ModelAsset {
  /** The role the file plays in one synthesis. */
  readonly role: 'talker' | 'codec';
  readonly repo: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly quant: string;
  readonly label: string;
  readonly default: boolean;
  /**
   * The `--backend` token this talker needs. It is part of the model's identity,
   * not a free setting: the 1.7B line is registered under its own backend name,
   * so picking the model picks the backend with it. Verified against
   * `crispasr --list-backends-json` (107 backends; `qwen3-tts-customvoice` and
   * `qwen3-tts-1.7b-customvoice` carry the same capability set).
   */
  readonly backend: string;
  /** What the user gains or loses by switching to this one, in one line. */
  readonly note: string;
  /**
   * Whether the engine's own speaker list applies. Both CustomVoice ports share
   * the nine baked speakers, but the note field is where a future port with a
   * different list would say so.
   */
  readonly voices?: string;
}

/**
 * The model catalogue. Deliberately narrow: every entry here is a talker the
 * plugin's command shape (`--voice <speaker>`) can drive. `cstr` also publishes
 * `*-base` (voice cloning from a reference clip) and `*-voicedesign` (describe a
 * voice instead of picking one) — different backends with different inputs, so
 * they are not "another model to select" and stay out until they are wired and
 * heard.
 */
export const MODEL_ASSETS: readonly ModelAsset[] = [
  {
    role: 'talker', repo: `${MODEL_ORG}/qwen3-tts-0.6b-customvoice-GGUF`,
    file: 'qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf', bytes: 967_980_192,
    sha256: '5227dcbc4df7c5533341d111cc469fa491a48e722b23dd10f553181b52dff2d9',
    quant: 'q8_0', label: 'CustomVoice 0.6B（9 音色）', default: true,
    backend: 'qwen3-tts-customvoice',
    note: '默认档：923 MB，实测 CPU 也接近实时（rtf≈1.0），有 GPU 更快',
    voices: '9 个内置音色，含北京话 dylan / 四川话 eric',
  },
  {
    role: 'talker', repo: `${MODEL_ORG}/qwen3-tts-1.7b-customvoice-GGUF`,
    file: 'qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf', bytes: 2_042_225_952,
    sha256: '3985813e21a3f27407110ba3afcd8f12ebc19734a5160ec31992637cd62aa67e',
    quant: 'q8_0', label: 'CustomVoice 1.7B（9 音色）', default: false,
    backend: 'qwen3-tts-1.7b-customvoice',
    note: '1.95 GB，音质与韵律更稳；需要 --backend 一起换，插件会自动配对',
    voices: '9 个内置音色（同 0.6B 一套）',
  },
  {
    role: 'talker', repo: `${MODEL_ORG}/qwen3-tts-1.7b-customvoice-GGUF`,
    file: 'qwen3-tts-12hz-1.7b-customvoice-f16.gguf', bytes: 3_838_977_216,
    sha256: '567af3bb58af4fa2fbffa4b00f5599b76638975cb811097d147ae57634d0f2e8',
    quant: 'f16', label: 'CustomVoice 1.7B f16', default: false,
    backend: 'qwen3-tts-1.7b-customvoice',
    note: '3.66 GB，比 q8_0 大一倍而提升有限；显存也要 4 GB 以上才划算',
    voices: '9 个内置音色（同 0.6B 一套）',
  },
  {
    role: 'codec', repo: `${MODEL_ORG}/qwen3-tts-tokenizer-12hz-GGUF`,
    file: 'qwen3-tts-tokenizer-12hz-q8_0.gguf', bytes: 290_623_616,
    sha256: 'f6d22c592c456092682796435a34e26af4a0932e162402d0a17780137358d55b',
    quant: 'q8_0', label: 'Tokenizer 12Hz q8_0', default: true,
    backend: 'qwen3-tts-customvoice', note: '语音编码器，不能缺；277 MB',
  },
  {
    role: 'codec', repo: `${MODEL_ORG}/qwen3-tts-tokenizer-12hz-GGUF`,
    file: 'qwen3-tts-tokenizer-12hz.gguf', bytes: 358_453_280,
    sha256: '70dc95dbfdd9aa5d9d406236ff771d061bf17b0cda02a72513953355606e719b',
    quant: 'f16', label: 'Tokenizer 12Hz f16', default: false,
    backend: 'qwen3-tts-customvoice', note: '342 MB，比 q8_0 慢，音质差别小',
  },
];

/** The talkers a user may choose, largest benefit first. */
export function talkerOptions(): ModelAsset[] {
  return MODEL_ASSETS.filter((asset) => asset.role === 'talker');
}

/** The default talker + codec pair — what a fresh install needs. */
export function defaultModels(): { readonly talker: ModelAsset; readonly codec: ModelAsset } {
  const pick = (role: ModelAsset['role']): ModelAsset =>
    MODEL_ASSETS.find((asset) => asset.role === role && asset.default === true)
    ?? MODEL_ASSETS.find((asset) => asset.role === role) as ModelAsset;
  return { talker: pick('talker'), codec: pick('codec') };
}

/** The choices the 下载源 dropdown exposes. */
export type SourcePolicy = 'auto' | 'cn' | 'official' | 'custom';
/** Which family a candidate belongs to, for reporting. */
export type OriginKind = 'official' | 'mirror' | 'proxy' | 'custom';

/** One concrete URL to try, with the origin label the UI shows. */
export interface Candidate {
  readonly url: string;
  readonly origin: string;
  readonly kind: OriginKind;
}

/** User-selected download source (persisted, not plugin config). */
export interface SourceSettings {
  readonly policy: SourcePolicy;
  /** GitHub acceleration prefix, e.g. `https://gh-proxy.com/`. */
  readonly proxyPrefix?: string;
  /** HF endpoint override, e.g. `https://hf-mirror.com`. */
  readonly hfEndpoint?: string;
  /** GitHub endpoint override — a company-internal release mirror goes here. */
  readonly ghEndpoint?: string;
}

/** `auto` is the default: probe, then keep whichever answered. */
export const DEFAULT_SOURCE: SourceSettings = { policy: 'auto' };

/**
 * How a proxy rewrites the request:
 * - `prefix`: prepend the proxy URL to the canonical URL (`gh-proxy.com/<url>`).
 * - `replace-host`: keep the path, swap the host (`<proxy>/<path>`) — what the
 *   `gh-proxy` upstream documents, and the only form that reaches *sibling*
 *   assets like `…/releases/download/<tag>/x.sha256`, which a prefix proxy
 *   answers with its own landing page.
 */
export type ProxyMode = 'prefix' | 'replace-host';

/**
 * The proxy presets that answered on the measured link, fastest first.
 * Community accelerators come and go — several popular ones were dead at the
 * time of writing — so `candidatesFor` always ends at the canonical URL and the
 * UI lets a user name their own.
 */
export const GH_PROXY_PRESETS: readonly { readonly id: string; readonly prefix: string; readonly mode: ProxyMode }[] = [
  { id: 'gh-proxy.com', prefix: 'https://gh-proxy.com/', mode: 'prefix' },
  { id: 'ghproxy.link', prefix: 'https://ghproxy.link/', mode: 'replace-host' },
  { id: 'ghproxy.net', prefix: 'https://ghproxy.net/', mode: 'prefix' },
  { id: 'gh-proxy.org', prefix: 'https://gh-proxy.org/', mode: 'prefix' },
];

/** The HF endpoints `auto` races, mirror first (the official host timed out). */
export const HF_ENDPOINT_PRESETS: readonly { readonly id: string; readonly host: string }[] = [
  { id: 'hf-mirror.com', host: 'https://hf-mirror.com' },
  { id: 'huggingface.co', host: HUGGINGFACE_HOST },
];

/** The canonical GitHub release URL for one engine build. */
export function engineUrl(variant: EngineVariant, tag: string = ENGINE_TAG): string {
  return `${GITHUB_HOST}/${ENGINE_REPO}/releases/download/${tag}/${variant.file}`;
}

/** The canonical HF resolve URL for one model file. */
export function modelUrl(asset: ModelAsset): string {
  return `${HUGGINGFACE_HOST}/${asset.repo}/resolve/main/${asset.file}`;
}

/** Rewrite a canonical `https://host/...` URL onto `host`, or null if unrelated. */
export function rewriteHost(url: string, from: string, to: string): string | null {
  if (!url.startsWith(`${from}/`)) return null;
  return `${to.replace(/\/+$/, '')}${url.slice(from.length)}`;
}

function withPrefix(prefix: string, url: string): string {
  return `${prefix.replace(/\/+$/, '')}/${url}`;
}

/** Swap the host of a canonical URL for a `replace-host` proxy's own. */
function withHost(prefix: string, url: string): string | null {
  const match = /^(https?:\/\/[^/]+)(\/.*)$/.exec(url);
  const base = /^(https?:\/\/[^/]+)\/?$/.exec(prefix.replace(/\/+$/, ''));
  if (match === null || base === null) return null;
  return `${base[1]}${match[2]}`;
}

/** Apply one proxy to a canonical URL, honouring how that family expects to be rewritten. */
function proxied(preset: { readonly prefix: string; readonly mode: ProxyMode }, url: string): string {
  if (preset.mode === 'replace-host') return withHost(preset.prefix, url) ?? withPrefix(preset.prefix, url);
  return withPrefix(preset.prefix, url);
}

function normalizePrefix(prefix: string | undefined): string | undefined {
  const trimmed = prefix?.trim() ?? '';
  if (trimmed === '') return undefined;
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : undefined;
}

/**
 * The ordered candidates for one canonical URL.
 *
 * The invariant the UI and the downloader both rely on: the list is never
 * empty, and the canonical official URL is always its last element, so a dead
 * mirror (or a dead proxy family) can never be what stops an install.
 */
export function candidatesFor(url: string, source: SourceSettings = DEFAULT_SOURCE, mode: ProxyMode = 'prefix'): Candidate[] {
  const policy = source.policy;
  const out: Candidate[] = [];
  const push = (candidate: Candidate | null): void => {
    if (candidate === null) return;
    if (out.some((entry) => entry.url === candidate.url)) return;
    out.push(candidate);
  };

  const isHuggingFace = url.startsWith(`${HUGGINGFACE_HOST}/`);
  if (isHuggingFace) {
    const endpoint = normalizePrefix(source.hfEndpoint);
    if (policy === 'custom') push(endpoint !== undefined ? { url: rewriteHost(url, HUGGINGFACE_HOST, endpoint) ?? url, origin: 'custom', kind: 'custom' } : null);
    if (policy !== 'official') {
      for (const preset of HF_ENDPOINT_PRESETS) {
        if (preset.host === HUGGINGFACE_HOST) continue;
        push({ url: rewriteHost(url, HUGGINGFACE_HOST, preset.host) ?? url, origin: preset.id, kind: 'mirror' });
      }
    }
  } else {
    const isGitHub = url.startsWith(`${GITHUB_HOST}/`);
    const ghEndpoint = normalizePrefix(source.ghEndpoint);
    if (ghEndpoint !== undefined) {
      // An endpoint swap keeps the path, so it works for sibling assets too;
      // it is skipped for the canonical host itself, which would duplicate it.
      if (isGitHub && ghEndpoint !== GITHUB_HOST) {
        push({ url: withHost(ghEndpoint, url) ?? url, origin: 'custom', kind: 'custom' });
      } else if (!isGitHub) {
        push({ url: proxied({ prefix: ghEndpoint, mode }, url), origin: 'custom', kind: 'custom' });
      }
    }
    if (policy === 'custom') {
      const prefix = normalizePrefix(source.proxyPrefix);
      if (prefix !== undefined) push({ url: proxied({ prefix, mode }, url), origin: 'custom', kind: 'custom' });
    }
    if (policy !== 'official') {
      for (const preset of GH_PROXY_PRESETS) push({ url: proxied(preset, url), origin: preset.id, kind: 'proxy' });
    }
  }
  // The official URL closes the list under every policy — including `custom`,
  // where a stale user prefix must degrade to the upstream, not to nothing.
  push({ url, origin: isHuggingFace ? 'huggingface.co' : new URL(url).host, kind: 'official' });
  return out;
}

/** What the machine looks like, as far as the plugin can tell without a shell. */
export interface DeviceHint {
  readonly os: string;
  readonly arch: string;
  /** From `crispasr --diagnostics`; `unknown` until the engine exists. */
  readonly gpu: 'none' | 'vulkan' | 'cuda12' | 'unknown';
  readonly vramMb?: number;
}

/** Anything above this is not something to quietly start on a residential proxy link. */
export const MANUAL_HINT_BYTES = 100_000_000;

/** Whether a download this large should steer the user toward 手动下载. */
export function manualRecommended(bytes: number): boolean {
  return bytes > MANUAL_HINT_BYTES;
}

/**
 * The engine builds worth offering for a machine, most-correct first.
 *
 * Two rules, in this order: never offer a build the machine cannot run (an
 * unconfirmed box never sees the 693 MB CUDA archive — that is not a thing to
 * install on a guess), and among what can run prefer the accelerator the
 * machine actually has, then the manifest's own rank. This answers "which is
 * right"; {@link recommendedVariant} answers "which will actually arrive".
 */
export function suggestVariants(hint: DeviceHint): EngineVariant[] {
  const wants: readonly GpuRequirement[] = hint.gpu === 'cuda12'
    ? ['cuda12', 'vulkan', 'none']
    : hint.gpu === 'vulkan'
      ? ['vulkan', 'none']
      : ['none', 'vulkan'];
  return ENGINE_VARIANTS
    .filter((variant) => variant.os === hint.os && wants.includes(variant.gpu))
    .slice()
    .sort((left, right) => {
      const byWant = wants.indexOf(left.gpu) - wants.indexOf(right.gpu);
      if (byWant !== 0) return byWant;
      if (left.rank !== right.rank) return left.rank - right.rank;
      return left.bytes - right.bytes;
    });
}

/**
 * The default pick: the best build that fits the transfer ceiling.
 *
 * The ceiling is {@link MANUAL_HINT_BYTES} — the same number that marks a
 * download as "hand this to a browser instead" — so the rule has one moving
 * part and says something coherent out loud: **what we install by default is
 * never something we would tell the user to download manually.** On the measured
 * link the 693 MB CUDA archive took anything from 25 minutes to 4 hours at the
 * same lane count, so a default that picked it was a coin flip on the first run.
 *
 * This does not hide the faster build: `suggestVariants` still lists CUDA first
 * among what the machine can run, and its note carries the measured cost, so
 * choosing it is one deliberate click rather than a surprise.
 *
 * Pass a larger `budgetBytes` when the caller knows the link can carry it (a
 * metered-off server, a LAN mirror), and the ceiling stops applying.
 */
export function recommendedVariant(hint: DeviceHint, budgetBytes: number = MANUAL_HINT_BYTES): EngineVariant | undefined {
  const options = suggestVariants(hint);
  return options.find((variant) => variant.bytes <= budgetBytes) ?? options[0];
}

/** One thing the runner still has to fetch. */
export interface PlanStep {
  readonly id: 'engine' | 'talker' | 'codec';
  readonly label: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly url: string;
  readonly file: string;
  readonly manualRecommended: boolean;
}

/** What is already on disk, keyed by step id. */
export type Installed = Partial<Record<PlanStep['id'], { readonly bytes: number; readonly sha256?: string }>>;

/**
 * The work list: every asset the plan needs, minus what is already in place.
 * An entry counts as installed only when its byte size matches, so a truncated
 * `.part`-style casualty is re-fetched rather than trusted.
 */
export function buildPlan(input: {
  readonly variant: EngineVariant;
  readonly talker: ModelAsset;
  readonly codec: ModelAsset;
  readonly installed: Installed;
}): PlanStep[] {
  const steps: PlanStep[] = [
    {
      id: 'engine', label: `引擎 ${ENGINE_TAG} · ${input.variant.label}`,
      bytes: input.variant.bytes, sha256: input.variant.sha256, url: engineUrl(input.variant),
      file: input.variant.file, manualRecommended: manualRecommended(input.variant.bytes),
    },
    {
      id: 'talker', label: `Talker ${input.talker.quant}`,
      bytes: input.talker.bytes, sha256: input.talker.sha256, url: modelUrl(input.talker),
      file: input.talker.file, manualRecommended: manualRecommended(input.talker.bytes),
    },
    {
      id: 'codec', label: `Codec ${input.codec.quant}`,
      bytes: input.codec.bytes, sha256: input.codec.sha256, url: modelUrl(input.codec),
      file: input.codec.file, manualRecommended: manualRecommended(input.codec.bytes),
    },
  ];
  return steps.filter((step) => {
    const have = input.installed[step.id];
    if (have === undefined) return true;
    if (have.bytes !== step.bytes) return true;
    return have.sha256 !== undefined && have.sha256 !== step.sha256;
  });
}

/** The sum of a work list, for the "这需要下多少" line. */
export function planBytes(steps: readonly PlanStep[]): number {
  return steps.reduce((total, step) => total + step.bytes, 0);
}

/** `1.2 GB` / `8.3 MB` — the unit a user reasons in. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** `约 4 分钟` — from bytes and an assumed throughput, for the pre-flight line. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '不到 1 分钟';
  if (seconds < 60) return `约 ${Math.round(seconds)} 秒`;
  const minutes = seconds / 60;
  if (minutes < 60) return `约 ${Math.round(minutes)} 分钟`;
  return `约 ${(minutes / 60).toFixed(1)} 小时`;
}

/** Seconds a download of `bytes` takes at `bytesPerSecond` (0 = unknown). */
export function estimateSeconds(bytes: number, bytesPerSecond: number): number {
  if (bytesPerSecond <= 0) return Number.POSITIVE_INFINITY;
  return bytes / bytesPerSecond;
}
