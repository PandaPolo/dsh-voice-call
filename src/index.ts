/**
 * dsh-voice-call — the agent's voice, offered. Fork of dsh-voice that adds
 * the call domain: `offer_call` rings the human with what the agent wants to
 * say, and nothing plays until the human answers 接听/拒接/稍后. Local-first:
 * audio is plain files under `~/.dsh/voice/`, synthesis runs on the local
 * CrispASR engine with the Qwen3-TTS CustomVoice model (9 baked speakers).
 *
 * One bundle, one plugin (plus the web client half that renders the
 * `voice/note` audio cards):
 * - `offer_call({ text, voice? })` — the call domain: ring → human answers →
 *   accepted calls synthesize on a background job, rejected/deferred calls
 *   return the human's decision to the agent.
 * - `transcribe({ source: {file|record}, to? })` — STT (from dsh-voice).
 * - `speak({ text, voice?, rate? })` — direct TTS on a background job
 *   (from dsh-voice; the crispasr backend is the local default here).
 * - `readReplies` + `/voice` — per-session narration toggle.
 * - `callMode: ask | card | direct | off` — how calls ring the human; `card`
 *   rings the v0.2 call-card UI (ring animation, caller identity) over the
 *   `/voice/call` web routes, with the v0.1 prompt as its fallback.
 *
 * Upgrade-ready contracts (reserved, not implemented in v0.1):
 * `src/rpc/contract.ts` (call-card UI endpoints), `src/domain/voicemail.ts`
 * (voicemail + read receipts), `voice/call.read` / `voice/call.voicemail`
 * event types.
 *
 * @module dsh-voice-call
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-shell';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-questions';
import z from '@deepseek-ai/schemastery';
import { AudioStore, confineAudioInput, resolveAudioDir } from './audio.ts';
import { CallBoard } from './callcard/board.ts';
import { installCallCardRoutes } from './callcard/web.ts';
import { DEFAULT_PALETTE, PALETTE_IDS } from './client/palettes.ts';
import { DEFAULT_TONE, TONE_IDS } from './client/tones.ts';
import { createRecordFn, createSttBackend, createTtsBackend } from './backends/index.ts';
import { probeCrispasr } from './backends/probe.ts';
import { AskUserRingChannel, DirectRingChannel, type RingChannel } from './channels/ring.ts';
import { CallCardRingChannel } from './channels/callcard.ts';
import { registerVoiceCommand } from './command.ts';
import { installVoicePersona } from './persona.ts';
import { installReadReplies, ReadRepliesToggle } from './read-replies.ts';
import { voiceConfigSource } from './settings.ts';
import { provisionLayout } from './provision/layout.ts';
import { readInstalledModels, readProvisionedEngine, withProvisionedEngine } from './provision/engine.ts';
import type { InstalledModels, ProvisionedEngine } from './provision/engine.ts';
import { DEFAULT_SOURCE, defaultModels, recommendedVariant } from './provision/manifest.ts';
import { ProvisionRunner } from './provision/state.ts';
import type { PrepareRequest } from './provision/state.ts';
import { detectDevice, unknownDevice } from './provision/detect.ts';
import { installProvisionRoutes } from './provision/web.ts';
import { createUnpacker } from './provision/unpack.ts';
import { makeShellRunner } from './backends/runner.ts';
import { applyOfferCallTool, buildOfferCallDeps } from './tools/offer-call.ts';
import { applySpeakTool, buildSpeakDeps } from './tools/speak.ts';
import { applyTranscribeTool, buildTranscribeDeps } from './tools/transcribe.ts';
import { resolveConfig, type VoiceConfig } from './types.ts';
import type { VoiceConfigInput } from './types.ts';
import { WaitingQuestionNudge } from './waiting/nudge.ts';
import { installAudioRoute } from './web.ts';

/** Cordis plugin name (also the config key under `plugins:`). */
export const name = 'dsh-voice-call';

/** Services required before the plugin can mount. */
export const inject = ['tools', 'userQuestions', 'jobs'] as const;

/** The `voice-speak` background job kind owned by this plugin. */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'voice-speak': 'voice-speak';
  }
}

/**
 * Plugin config (all fields optional — defaults match the documented behavior).
 *
 * A field marked `.volatile()` is editable in the host's configuration surface
 * without remounting the plugin: the loader hands it to `apply()` as a live
 * reference, and `voiceConfigSource` detaches it on every read, so a change
 * reaches the next tool call. Marked fields are exactly the ones whose effect is
 * already read per call — the engine paths, `audioDir` and the durable-event
 * switch would need a reload to take effect, so they stay unmarked and the host
 * refuses form writes to them.
 */
export const Config = z.object({
  stt: z.object({
    backend: z.union(['whisper-local', 'openai', 'macos', 'fake']),
    model: z.string(),
    whisperLocal: z.object({ bin: z.string(), model: z.string() }),
    openai: z.object({ baseUrl: z.string(), apiKeyEnv: z.string().role('credential-ref') }),
  }),
  tts: z.object({
    backend: z.union(['say', 'piper', 'edge-tts', 'fake', 'crispasr']),
    voice: z.string().volatile(),
    rate: z.number().min(1).max(600).volatile(),
    piper: z.object({ bin: z.string(), model: z.string() }),
    edgeTts: z.object({ voice: z.string() }),
    crispasr: z.object({ bin: z.string(), model: z.string(), codec: z.string(), backend: z.string() }),
  }),
  readReplies: z.boolean().default(false),
  // Session-log durability for voice events. MUST stay off on harness builds
  // without plugin-event support (rc.6 refuses unknown event types on history
  // load — an appended voice/* event poisons the session log).
  durableEvents: z.boolean().default(false),
  callMode: z.union(['ask', 'card', 'direct', 'off']).default('ask').volatile(),
  callCard: z.object({
    callerName: z.string(),
    ringTimeoutMs: z.number().min(1000).max(600_000).volatile(),
    // These three are pure presentation, read by the card on every render, so they
    // are the fields the settings card can change and have take effect on the very
    // next ring — the ringtone with it, because 静音 while it is sounding has to
    // reach the same element the toggle writes.
    theme: z.union(['system', 'light', 'dark']).default('system').volatile(),
    palette: z.union(PALETTE_IDS).default(DEFAULT_PALETTE).volatile(),
    ringtone: z.boolean().default(true).volatile(),
    // Which of the bundled ringtones the above plays. A union over the table the
    // settings card draws its dropdown from, so an id the UI offers is the only
    // kind of id the profile can hold — and the route never resolves a path from
    // it, it looks the id up in `src/client/tones.ts`.
    tone: z.union(TONE_IDS).default(DEFAULT_TONE).volatile(),
  }),
  // Experimental, off by default: escalate a host question nobody answers into
  // a ringing card. `nudgeAfterMinutes` is the cold-deck patience; the host has
  // no timeout of its own, so this number is the only clock the feature has.
  // EXPERIMENTAL, off by default. `nudgeAfterMinutes` is the cold-deck patience;
  // the host has no timeout on a question at all, so this number is the only
  // clock the feature has. NOT `.volatile()` on the object itself: cordis
  // rejects a volatile field inside an enclosing volatile field ("volatile
  // fields require a fixed object path"), and it rejects it by refusing to
  // activate the whole plugin — see test/plugin-config.test.ts.
  experimental: z.object({
    nudgeWaitingQuestions: z.boolean().default(false).volatile(),
    nudgeAfterMinutes: z.number().min(1).max(30).default(5).volatile(),
  }),
  audioDir: z.string(),
  // Reserved for v0.3 — accepted now so configs written against v0.1 keep loading.
  voicemail: z.object({ enabled: z.boolean() }),
  readReceipts: z.object({ enabled: z.boolean() }),
});

/** Mount the plugin: settings, tools, narration, call domain, persona, command, web route. */
export function apply(ctx: Context, rawConfig: VoiceConfigInput): void {
  // Settings: the effective config is re-resolved on every read, which is what
  // carries a volatile field edited in the settings UI into the next tool call.
  const current = voiceConfigSource(rawConfig);

  // Audio store: plain files under audioDir; the log carries refs only.
  // `audioDir` is not a volatile field, so the root is fixed for this fiber.
  const audioRoot = resolveAudioDir(current().audioDir);
  // The engine's shell calls span several roots (binary, GGUF models, the audio
  // dir) that no confined sandbox mode covers, and the Windows ACL runner is
  // unusable when the temp dir sits inside the workspace — so the policy is
  // explicit, and shared by synthesis *and* provisioning.
  const fullAccessPolicy = { mode: 'danger-full-access' as const, workspaceRoot: process.cwd() };

  // Provisioning: the voice root doubles as the install root, so one folder
  // holds the audio, the engine, the models and `provision.json`. `provisioned`
  // is re-read at mount and whenever a run lands on a terminal phase; the
  // backend layer sees it merged *under* the config, which is what keeps a
  // hand-written `tts.crispasr` path in front of anything the plugin installs.
  const provisionRoot = provisionLayout(audioRoot);
  let deviceReport = unknownDevice();
  const provisionRunner = new ProvisionRunner({
    layout: provisionRoot,
    unpack: createUnpacker(makeShellRunner(ctx, fullAccessPolicy)),
  });
  let provisioned: ProvisionedEngine | undefined;
  let installedModels: InstalledModels = {};
  const shellRun = makeShellRunner(ctx, fullAccessPolicy);
  /**
   * Start a read that runs behind the mount and report what it could not do.
   *
   * These used to be bare `void promise` calls, which is how a rejection reaches
   * Node as an unhandled rejection — and Node's default for that is to end the
   * process, taking the whole host down over one unreadable directory. The
   * fallback is already the honest one (the card says 未探测到设备 rather than
   * guessing), so what is missing here is only the record of why.
   */
  const background = (label: string, run: () => Promise<unknown>): void => {
    void run().catch((error: unknown) => ctx.logger.warn(`dsh-voice-call: ${label}`, error));
  };
  /**
   * Ask the engine what it can run. The binary we ask is the one the plugin
   * would actually use — provisioned root last, hand-configured path first — so
   * a user whose CUDA build lives in `D:\crispasr` is offered the CUDA archive,
   * not a greyed-out list.
   */
  const detect = async (): Promise<void> => {
    const configured = current().tts.crispasr?.bin;
    const bin = configured !== undefined && configured !== '' ? configured : provisioned?.bin;
    deviceReport = await detectDevice(shellRun, bin ?? 'crispasr');
  };
  background('device detection failed', detect);
  const refreshProvisioned = (): Promise<void> => readProvisionedEngine(provisionRoot).then(async (engine) => {
    provisioned = engine;
    // Read separately from the engine above: a *half*-provisioned root is not an
    // engine, but the models it does hold are still the ones on disk, and the
    // plan must believe the disk.
    installedModels = await readInstalledModels(provisionRoot);
    await detect();
    // The device line arrives after the routes are mounted, and a first read on a
    // fresh root has to guess. Re-inspect once the engine has answered, so the
    // card stops describing a build nobody chose — but only while nothing has
    // actually run: re-reading after a failure would overwrite the step that
    // failed with a plain `未安装` and throw away the reason.
    const before = provisionRunner.snapshot().phase;
    const request = provisionRequest();
    if (request !== undefined && (before === 'unknown' || before === 'unprepared') && !provisionRunner.busy) {
      background('provision re-inspection failed', () => provisionRunner.inspect(request));
    }
  });
  background('reading the provisioned root failed', refreshProvisioned);
  let lastPhase = provisionRunner.snapshot().phase;
  provisionRunner.subscribe((view) => {
    if (view.phase === lastPhase) return;
    lastPhase = view.phase;
    // A freshly installed engine can answer questions the previous one could
    // not, so the device line is re-read with it.
    if (view.phase !== 'preparing') background('re-reading the provisioned root failed', refreshProvisioned);
  });
  const provisionRequest = (): PrepareRequest | undefined => {
    // The installed build wins; a fresh root asks the manifest what this machine
    // should get. No selectable build (an architecture we do not ship) means
    // provisioning stays out of the way rather than offering something broken.
    const variant = provisioned?.variant ?? recommendedVariant(deviceReport);
    if (variant === undefined) return undefined;
    const pair = defaultModels();
    return {
      variant,
      talker: installedModels.talker ?? pair.talker,
      codec: installedModels.codec ?? pair.codec,
      // An engine the config already names is not work to pay for: the row stays
      // visible, but the plan stops putting 693 MB behind the default button.
      engineFromConfig: probeCrispasr(current()),
      source: DEFAULT_SOURCE,
    };
  };
  // The call-card board: the host half of the v0.2 card UI. The web routes
  // stream its state to connected clients; with no webserver (headless) it
  // simply never gains subscribers and the card channel falls back to the
  // v0.1 prompt channel.
  const callBoard = new CallBoard();
  let disposeRoute: (() => void) | undefined;
  const mountRoute = (): void => {
    disposeRoute?.();
    disposeRoute = installAudioRoute(ctx, audioRoot);
  };
  // Web routes mount via ctx.inject: the webserver fiber boots in parallel
  // with this plugin, so a plain ctx.get('webServer') in apply() races and
  // silently registers nothing (the harness's own web-app waits the same
  // way). In headless compositions the service never appears and the
  // callback simply never fires.
  ctx.inject(['webServer'], () => {
    mountRoute();
    installCallCardRoutes(ctx, callBoard, () => {
      const { theme, palette, ringtone, tone } = current().callCard;
      return { theme, palette, ringtone, tone };
    });
    if (provisionRequest() !== undefined) {
      installProvisionRoutes(
        ctx, provisionRunner, provisionRoot,
        () => provisionRequest() as PrepareRequest,
        () => deviceReport,
        () => probeCrispasr(withProvisionedEngine(current(), provisioned)),
      );
    }
  });
  const audioStore = (): AudioStore => new AudioStore(audioRoot);
  const audioPath = (): string => audioStore().pathFor(`voice-speak-${speakSeq()}`, 'wav');

  // Experimental (spike): escalate a host question nobody answers into a card.
  // The ask is a suspended promise with no timer anywhere in the harness, and
  // the agent parked on it cannot escalate itself, so the clock lives here.
  // `tools/execute` wraps the tool BODY — the thing that awaits the human —
  // which is why this does not have to win the registration race against the
  // `user-questions/request` bridge in dsh-api-remotes. Attention only: the
  // card never answers, and every path takes it back down.
  const waitingNudge = new WaitingQuestionNudge({
    board: callBoard,
    callerName: () => current().callCard.callerName,
    voice: () => current().tts.voice ?? 'default',
    delayMs: () => (current().experimental.nudgeWaitingQuestions
      ? current().experimental.nudgeAfterMinutes * 60_000
      : 0),
    // 接听 says one sentence about what is waiting, through the same speak
    // pipeline the `speak` tool uses — resolved per call so the backend the
    // human just configured (or just broke) is the one that speaks.
    speak: (agent) => buildSpeakDeps(ctx, {
      tts: createTtsBackend(backendDeps()),
      audioPath,
      durableEvents: () => current().durableEvents,
    }, { agent: agent as Agent | undefined }),
  });
  ctx.on('tools/execute', (exec, next) => waitingNudge.wrap({
    name: exec.name,
    callId: exec.callId,
    arguments: exec.arguments,
    // The live agent itself, not a projection: the speak pipeline built for an
    // accepted nudge reads `agent.session.id` and `agent.inject(...)`. Passing
    // `{ id }` here threw inside the card's answer waiter — which runs inside
    // the web request handler — and took the whole host down with it.
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  }, next));

  // Backends: created per call so config changes reach the next tool call.
  const backendDeps = () => ({ ctx, config: withProvisionedEngine(current(), provisioned), policy: fullAccessPolicy });
  const agentFor = (session: { readonly id: string }): Agent | undefined => {
    const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined;
    return agents?.get(session.id);
  };

  applyTranscribeTool(ctx, {
    makeDeps: (exec) => buildTranscribeDeps(ctx, {
      stt: createSttBackend(backendDeps()),
      record: createRecordFn(backendDeps()),
      commit: (file, name, extra) => audioStore().commit(file, name, extra),
      // The model names a file; the store decides whether this deployment may
      // read it. Without this line the name went straight to the backend and
      // then into a copy inside the directory the web route serves.
      confine: (file) => confineAudioInput(audioRoot, file),
      durableEvents: () => current().durableEvents,
    }, exec),
  });

  applySpeakTool(ctx, {
    makeDeps: (exec) => buildSpeakDeps(ctx, {
      tts: createTtsBackend(backendDeps()),
      audioPath,
      durableEvents: () => current().durableEvents,
    }, exec),
  });

  // The call domain: the ring channel follows callMode (ask → human prompt,
  // card → the v0.2 call-card UI with the v0.1 prompt as fallback,
  // direct → immediate accept; off → refused).
  const askChannel = (): RingChannel => new AskUserRingChannel((request) => ctx.userQuestions.ask({
    questions: request.questions,
    ...(request.agent !== undefined ? { agent: request.agent } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  }));
  const ringChannel = (): RingChannel => {
    const mode = current().callMode;
    if (mode === 'direct') return new DirectRingChannel();
    if (mode === 'card') {
      return new CallCardRingChannel({
        board: callBoard,
        callerName: () => current().callCard.callerName,
        ringTimeoutMs: () => current().callCard.ringTimeoutMs,
        fallback: askChannel(),
      });
    }
    return askChannel();
  };

  applyOfferCallTool(ctx, {
    makeDeps: (exec) => buildOfferCallDeps(ctx, {
      ring: ringChannel(),
      callMode: () => current().callMode,
      durableEvents: () => current().durableEvents,
      speak: buildSpeakDeps(ctx, {
        tts: createTtsBackend(backendDeps()),
        audioPath,
        durableEvents: () => current().durableEvents,
      }, exec),
    }, exec),
  });

  // The voice persona: tells the agent it has a voice and how to use it.
  installVoicePersona(ctx, () => current().callMode);

  // Narration: per-session toggle, off unless configured or /voice on.
  const toggle = new ReadRepliesToggle(current().readReplies);
  installReadReplies(ctx, toggle, (session) => buildSpeakDeps(ctx, {
    tts: createTtsBackend(backendDeps()),
    audioPath,
    durableEvents: () => current().durableEvents,
  }, { agent: agentFor(session) }));

  registerVoiceCommand(ctx, {
    readReplies: () => toggle.enabled,
    setReadReplies: (enabled) => toggle.set(enabled),
    statusLine: () => {
      const config = withProvisionedEngine(current(), provisioned);
      const engine = config.tts.crispasr;
      const local = engine !== undefined && engine.bin !== ''
        ? provisioned !== undefined && engine.bin === provisioned.bin ? `已装配 ${provisioned.variant.id}` : '指向手动配置的引擎'
        : '未装配（可在插件页一键安装）';
      return `stt: ${config.stt.backend ?? 'auto'} · tts: ${config.tts.backend ?? 'auto'} · readReplies: ${toggle.enabled ? 'on' : 'off'} · 本地引擎: ${local}`;
    },
    callMode: () => current().callMode,
    configLine: () => `audioDir: ${audioRoot}\n  engine: ${provisioned?.bin ?? '(未装配)'}\n  手动放置到: ${provisionRoot.downloadDir()}`,
    speakDeps: (session) => buildSpeakDeps(ctx, {
      tts: createTtsBackend(backendDeps()),
      audioPath,
      durableEvents: () => current().durableEvents,
    }, { agent: agentFor(session) }),
  });
}

let seq = 0;
function speakSeq(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}
