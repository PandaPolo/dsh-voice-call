/**
 * The settings card: this plugin's contribution to the host's plugin page.
 *
 * The host owns the page; a bundle adds its own configuration through the
 * `plugins.bundle.config` slot, keyed by package name, and is handed
 * `PluginConfigViewProps` — `{ view, form }`, where `form` carries the accepted
 * values for the plugin's own `Config` and a revision-checked `mutate`. Nothing
 * here declares a schema: the fields listed below are exactly the ones
 * `src/index.ts` marks `.volatile()`, which is what makes them writable at all
 * (the host refuses a form write to a non-volatile path).
 *
 * `view` is `'summary'` when the page shows the bundle as a one-liner and
 * `'page'` when the user opens it; the form only makes sense in the latter, and
 * the summary keeps to text so it cannot disturb the row's own layout.
 *
 * Styling is deliberately plain: host tokens with literals behind them, the same
 * contract the call card uses, so the card reads correctly in light, dark and
 * whatever palette the host is wearing without depending on a primitives package
 * this bundle does not currently import.
 *
 * @module dsh-voice-call/client/settings
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PALETTES, paletteById } from './palettes.ts';
import { DEFAULT_TONE, TONES, toneById } from './tones.ts';
import { RINGTONE_VOLUME, ringtoneUrl } from './ringtone.ts';
import { setAppearance } from './appearance.ts';
import { RuntimeSection } from './runtime-section.tsx';

/** The package name the host keys this bundle's config card by. */
export const BUNDLE_NAME = 'dsh-voice-call';

/** The crispasr CustomVoice speaker tokens, with the two dialect voices noted. */
const VOICES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'aiden', label: 'aiden' },
  { id: 'dylan', label: 'dylan（北京话）' },
  { id: 'eric', label: 'eric（四川话）' },
  { id: 'ono_anna', label: 'ono_anna' },
  { id: 'ryan', label: 'ryan' },
  { id: 'serena', label: 'serena' },
  { id: 'sohee', label: 'sohee' },
  { id: 'uncle_fu', label: 'uncle_fu' },
  { id: 'vivian', label: 'vivian' },
];

/** The call modes, mirroring the `callMode` union in the server schema. */
const CALL_MODES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'card', label: '来电卡片' },
  { id: 'ask', label: '弹窗询问' },
  { id: 'direct', label: '直接接听' },
  { id: 'off', label: '关闭来电' },
];

/** The theme modes, mirroring `callCard.theme`. */
const THEMES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '强制浅色' },
  { id: 'dark', label: '强制深色' },
];

/** One path-addressed edit, structurally (`SettingsPathOpView`). */
type FieldOp = { op: 'set'; path: readonly string[]; value: unknown };

/** The snapshot shape this card reads, structurally (`ConfigFormSnapshot`). */
export interface ConfigFormSnapshotLike {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly value: Record<string, unknown> | undefined;
  readonly revision?: number;
}

/** The host's form handle, as this card uses it (structural by necessity). */
interface ConfigFormLike {
  readonly state: ConfigFormSnapshotLike;
  mutate(ops: readonly FieldOp[], expectedRevision?: number): Promise<boolean>;
}

/**
 * The per-entry form from `ctx.configForms.get(entryId)` — `ConfigForm`'s face
 * this card actually uses.
 *
 * This, not the slot's `form` prop, is how the card gets write access on
 * 0.1.7-rc.2: the host renders `plugins.bundle.config` with owner props of only
 * `{ view: 'page' }` (dsh-client-ui-plugin-manager `lib/client.js:1973`), while
 * `plugins.row.config` and `plugins.item` do receive a `form`. The service is
 * the same one those pages derive from, so taking it directly costs nothing and
 * keeps the card on the page where the user expects to find it.
 */
export interface ConfigFormHandle {
  getSnapshot(): ConfigFormSnapshotLike;
  mutate(ops: readonly FieldOp[], expectedRevision?: number): Promise<boolean>;
  subscribe(listener: () => void): () => void;
}

/** What the host passes a `plugins.bundle.config` contribution. */
export interface BundleConfigProps {
  readonly view?: 'summary' | 'page';
  readonly form?: ConfigFormLike;
  /** Supplied by this bundle through the slot's `inject` face. */
  readonly configForm?: ConfigFormHandle;
}

/** Read one nested field out of the projected config value. */
function field(form: ConfigFormLike | undefined, ...path: string[]): unknown {
  let node: unknown = form?.state.value;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * The card's editable values, read out of the host's projection.
 *
 * A field the profile never set arrives as `undefined` rather than the schema
 * default, so each control falls back to the value the server documents — the
 * same literals `resolveConfig` uses, kept here only for display.
 */
interface CardValues {
  readonly voice: string;
  readonly rate: number;
  readonly callMode: string;
  readonly ringTimeoutMs: number;
  readonly theme: string;
  readonly palette: string;
  readonly ringtone: boolean;
  readonly tone: string;
  readonly nudgeWaiting: boolean;
  readonly nudgeAfterMinutes: number;
}

const FALLBACK: CardValues = {
  voice: 'dylan',
  rate: 180,
  callMode: 'ask',
  ringTimeoutMs: 30_000,
  theme: 'system',
  palette: 'host',
  ringtone: true,
  tone: DEFAULT_TONE,
  nudgeWaiting: false,
  nudgeAfterMinutes: 5,
};

/**
 * 语速 as three choices. The engine takes a words-per-minute number, but a
 * number is not a decision a person can make without hearing the difference, and
 * 1–600 invited exactly the "should it be 190 or 210?" second-guessing the card
 * should not create. These are the three settings the backend sounds distinct at.
 */
const SPEEDS = [
  { value: 150, label: '慢' },
  { value: 180, label: '中' },
  { value: 220, label: '快' },
] as const;

/** The nearest preset to a stored rate, so a hand-written 200 shows as 快. */
function speedOf(rate: number): number {
  let best: number = SPEEDS[0].value;
  for (const speed of SPEEDS) {
    if (Math.abs(speed.value - rate) < Math.abs(best - rate)) best = speed.value;
  }
  return best;
}

const SPEED_OPTIONS: readonly { readonly id: string; readonly label: string }[] =
  SPEEDS.map((speed) => ({ id: String(speed.value), label: speed.label }));

/** Whether to ring at all. The volume is the system's, the tone is `TONE_OPTIONS`. */
const RINGTONE_OPTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'on', label: '响铃' },
  { id: 'off', label: '静音' },
];

/** The tone dropdown, drawn from the table the server resolves ids against. */
const TONE_OPTIONS: readonly { readonly id: string; readonly label: string }[] =
  TONES.map((tone) => ({ id: tone.id, label: tone.label }));

/**
 * EXPERIMENTAL: whether a question nobody answers should ring the card at all.
 * Off unless opened — a card that appears unexplained is worse than a question
 * that waits quietly.
 */
const NUDGE_OPTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'on', label: '开' },
  { id: 'off', label: '关' },
];

/**
 * How long to wait before ringing. Presets rather than a number box: the
 * question is "how long am I usually gone?", and 5 vs 6 minutes is not a
 * decision anyone can make cold. The server accepts 1–30.
 */
const NUDGE_WAITS = [
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
  { value: 30, label: '30 分钟' },
] as const;

const NUDGE_WAIT_OPTIONS: readonly { readonly id: string; readonly label: string }[] =
  NUDGE_WAITS.map((wait) => ({ id: String(wait.value), label: wait.label }));

/** The nearest preset to a stored patience, so a hand-written 7 shows as 5 分钟. */
function waitOf(minutes: number): number {
  let best: number = NUDGE_WAITS[0].value;
  for (const wait of NUDGE_WAITS) {
    if (Math.abs(wait.value - minutes) < Math.abs(best - minutes)) best = wait.value;
  }
  return best;
}

function readValues(form: ConfigFormLike | undefined): CardValues {
  return {
    voice: (field(form, 'tts', 'voice') as string | undefined) ?? FALLBACK.voice,
    rate: (field(form, 'tts', 'rate') as number | undefined) ?? FALLBACK.rate,
    callMode: (field(form, 'callMode') as string | undefined) ?? FALLBACK.callMode,
    ringTimeoutMs: (field(form, 'callCard', 'ringTimeoutMs') as number | undefined) ?? FALLBACK.ringTimeoutMs,
    theme: (field(form, 'callCard', 'theme') as string | undefined) ?? FALLBACK.theme,
    palette: (field(form, 'callCard', 'palette') as string | undefined) ?? FALLBACK.palette,
    ringtone: (field(form, 'callCard', 'ringtone') as boolean | undefined) ?? FALLBACK.ringtone,
    tone: (field(form, 'callCard', 'tone') as string | undefined) ?? FALLBACK.tone,
    nudgeWaiting: (field(form, 'experimental', 'nudgeWaitingQuestions') as boolean | undefined) ?? FALLBACK.nudgeWaiting,
    nudgeAfterMinutes: (field(form, 'experimental', 'nudgeAfterMinutes') as number | undefined) ?? FALLBACK.nudgeAfterMinutes,
  };
}

/** One labelled row: the label sits left, the control right, like the host's own. */
function Row(props: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="dsvc-set-row">
      <span className="dsvc-set-label">{props.label}</span>
      <span className="dsvc-set-control">{props.children}</span>
    </div>
  );
}

/** A select over a fixed option list. */
function Choice(props: {
  readonly value: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly disabled: boolean;
  readonly onPick: (id: string) => void;
}): ReactNode {
  return (
    <select className="dsvc-set-select" value={props.value} disabled={props.disabled}
      onChange={(event) => props.onPick(event.currentTarget.value)}>
      {props.options.map((option) => (
        <option key={option.id} value={option.id}>{option.label}</option>
      ))}
    </select>
  );
}

/** The palette picker: six swatches, the chosen one ringed. */
function PalettePicker(props: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onPick: (id: string) => void;
}): ReactNode {
  return (
    <span className="dsvc-set-swatches">
      {PALETTES.map((palette) => (
        <button key={palette.id} type="button" className="dsvc-swatch" title={palette.label}
          aria-label={palette.label} aria-pressed={palette.id === props.value} disabled={props.disabled}
          data-active={palette.id === props.value ? '' : undefined}
          style={{ background: palette.light.accent, borderColor: paletteById(props.value).id === palette.id ? palette.light.accent : 'transparent' }}
          onClick={() => props.onPick(palette.id)} />
      ))}
    </span>
  );
}

/**
 * The tone picker: one dropdown, one 试听, and one line about the tone currently
 * chosen. Eleven sounds do not fit a settings card as eleven buttons, and a
 * person who knows what they want can open a dropdown as fast as they can scan a
 * grid — but the hint has to be *outside* the closed dropdown, because "小铃叮咚"
 * does not tell you whether it is the one that sounds like a train station.
 */
function ToneRow(props: {
  readonly value: string;
  readonly disabled: boolean;
  /** The tone being auditioned right now, or '' for none. */
  readonly auditioning: string;
  readonly onPick: (id: string) => void;
  readonly onAudition: (id: string) => void;
}): ReactNode {
  const tone = toneById(props.value);
  return (
    <div className="dsvc-set-tone">
      <Row label="铃声">
        <select className="dsvc-set-select" value={tone.id} disabled={props.disabled}
          onChange={(event) => props.onPick(event.currentTarget.value)}>
          {TONE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        <button type="button" className="dsvc-set-audition" disabled={props.disabled}
          aria-pressed={props.auditioning === tone.id}
          title={`以来电卡片的音量试听「${tone.label}」`}
          onClick={() => props.onAudition(tone.id)}>
          {props.auditioning === tone.id ? '停下' : '试听'}
        </button>
      </Row>
      <p className="dsvc-set-hint">{tone.hint}</p>
    </div>
  );
}

/**
 * The settings card.
 * @param props - `view` and the host-owned `form`, per `plugins.bundle.config`.
 */
const LOADING: ConfigFormSnapshotLike = { status: 'loading', value: undefined };

export function VoiceCallSettingsCard(props: BundleConfigProps): ReactNode {
  const handle = props.configForm;
  // The mirror folds every accepted write — and every other page's write — back
  // in, so the card holds the host's snapshot instead of caching values of its
  // own: one source of truth, and no bookkeeping about what was saved.
  const [snapshot, setSnapshot] = useState<ConfigFormSnapshotLike>(
    () => handle?.getSnapshot() ?? props.form?.state ?? LOADING,
  );
  useEffect(() => {
    if (handle === undefined) return undefined;
    setSnapshot(handle.getSnapshot());
    return handle.subscribe(() => setSnapshot(handle.getSnapshot()));
  }, [handle]);
  const form: ConfigFormLike | undefined = props.form ?? (handle === undefined ? undefined : {
    state: snapshot,
    mutate: (ops, expected) => handle.mutate(ops, expected),
  });
  const [draft, setDraft] = useState<CardValues>(() => readValues(form));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 试听 holds one element, not one per click: two of them would play a chord,
  // and nothing teaches the difference between two tones like hearing them at
  // the same time and being unable to tell which was which. It loops and it is
  // stopped on unmount for the same reason — a preview that outlives the card
  // keeps ringing in a page that no longer shows any way to stop it.
  const player = useRef<HTMLAudioElement | null>(null);
  const [auditioning, setAuditioning] = useState('');
  const stopAudition = (): void => {
    player.current?.pause();
    player.current = null;
    setAuditioning('');
  };
  const audition = (tone: string): void => {
    if (auditioning === tone) {
      stopAudition();
      return;
    }
    const Ctor = window.Audio;
    if (Ctor === undefined) return;
    player.current?.pause();
    const element = new Ctor(ringtoneUrl(tone));
    element.loop = true;
    // The level the card uses, so what is chosen here is what gets lived with.
    // The browser's own ceiling still applies: this is a preview at call volume,
    // not a volume control.
    element.volume = RINGTONE_VOLUME;
    player.current = element;
    setAuditioning(tone);
    // Autoplay policy: the click is the activation, so this normally starts. If it
    // does not, the button must not lie about being stopped — hence the catch.
    void element.play().catch(() => stopAudition());
  };
  useEffect(() => () => stopAudition(), []);

  // A snapshot the host accepted replaces whatever the controls are showing, so
  // a rejected write cannot leave a value on screen that was never stored.
  useEffect(() => {
    if (form?.state.status === 'ready') setDraft(readValues(form));
  }, [form?.state.status, form?.state.value]);

  const values = form?.state.status === 'ready' ? draft : readValues(form);
  const disabled = form === undefined || form.state.status !== 'ready' || busy;

  // 静音 deletes the row the stop button lived in, so a tone that was being
  // auditioned would otherwise keep looping with nothing left on screen to stop it.
  useEffect(() => {
    if (!values.ringtone) stopAudition();
  }, [values.ringtone]);

  const write = async (ops: readonly FieldOp[]): Promise<void> => {
    if (form === undefined) return;
    setBusy(true);
    setError('');
    const ok = await form.mutate(ops, form.state.revision).catch(() => false);
    setBusy(false);
    if (!ok) {
      setError('写入被宿主拒绝（配置可能已被别处改动），请重新打开本页。');
      return;
    }
    // Repaint a card that is already on screen without waiting for the host's
    // next snapshot: the overlay reads the same store this write just landed in.
    const next = readValues(form);
    setAppearance({
      theme: opsTheme(ops) ?? next.theme,
      palette: opsPalette(ops) ?? next.palette,
      ringtone: opsRingtone(ops) ?? next.ringtone,
      tone: opsTone(ops) ?? next.tone,
    });
  };

  // No form means the host is not handing this entry's config to contributions
  // at all — showing disabled controls underneath a message saying to edit the
  // file would only be noise.
  if (form === undefined) {
    return (
      <div className="dsvc-set">
        <style>{SETTINGS_STYLES}</style>
        <p className="dsvc-set-note">
          宿主没有把配置表单交给这张卡片，暂时只能改 profile 的 <code>voice</code> 配置块。
        </p>
      </div>
    );
  }

  if (props.view === 'summary') {
    const speed = SPEEDS.find((option) => option.value === speedOf(values.rate))?.label ?? values.rate;
    return <span className="dsvc-set-summary">音色 {values.voice} · {speed}速 · {paletteById(values.palette).label}</span>;
  }

  return (
    <div className="dsvc-set">
      <style>{SETTINGS_STYLES}</style>
      {form.state.status === 'unavailable' && (
        <p className="dsvc-set-note">这个连接不保存配置改动（内存模式），下面的开关只对本次运行有效。</p>
      )}
      <Row label="音色">
        <Choice value={values.voice} options={VOICES} disabled={disabled}
          onPick={(voice) => void write([{ op: 'set', path: ['tts', 'voice'], value: voice }])} />
      </Row>
      <Row label="语速">
        <Choice value={String(speedOf(values.rate))} options={SPEED_OPTIONS} disabled={disabled}
          onPick={(rate) => void write([{ op: 'set', path: ['tts', 'rate'], value: Number(rate) }])} />
      </Row>
      <Row label="来电方式">
        <Choice value={values.callMode} options={CALL_MODES} disabled={disabled}
          onPick={(callMode) => void write([{ op: 'set', path: ['callMode'], value: callMode }])} />
      </Row>
      <Row label="来电铃声">
        <Choice value={values.ringtone ? 'on' : 'off'} options={RINGTONE_OPTIONS} disabled={disabled}
          onPick={(mode) => void write([{ op: 'set', path: ['callCard', 'ringtone'], value: mode === 'on' }])} />
      </Row>
      {/* Picking a tone auditions it: one dropdown that stays shut, and one sound
          that says more than any label. It hides with 静音 rather than going grey,
          because a tone for a ring that will not sound is not a choice. */}
      {values.ringtone
        ? (
            <ToneRow value={values.tone} disabled={disabled} auditioning={auditioning}
              onAudition={audition}
              onPick={(tone) => {
                audition(tone);
                void write([{ op: 'set', path: ['callCard', 'tone'], value: tone }]);
              }} />
          )
        : null}
      {/* Seven rows, all of them visible. A fold over three cosmetic choices was
          the previous shape, and it cost more than it saved: the controls were
          harder to find than they were to show, and the card still had to be
          scrolled to reach 运行环境 anyway. */}
      <Row label="铃声持续时间">
        <input className="dsvc-set-number" type="number" min={10} max={600} step={5}
          value={Math.round(values.ringTimeoutMs / 1000)} disabled={disabled}
          onChange={(event) => setDraft((prev) => ({ ...prev, ringTimeoutMs: Number(event.target.value) * 1000 }))}
          onBlur={(event) => void write([{ op: 'set', path: ['callCard', 'ringTimeoutMs'], value: Number(event.target.value) * 1000 }])} />
      </Row>
      {/* EXPERIMENTAL. A question the model asked is a promise the harness makes
          to nobody: it waits with no timeout at all, and the agent parked on it
          cannot escalate, so "I forgot I had a question out" is unfixable from
          inside the conversation. This row is the one thing that says it out
          loud — and it only rings a card. Answering still happens in the chat. */}
      <Row label="等问题振铃（实验性新功能）">
        <Choice value={values.nudgeWaiting ? 'on' : 'off'} options={NUDGE_OPTIONS} disabled={disabled}
          onPick={(mode) => void write([{ op: 'set', path: ['experimental', 'nudgeWaitingQuestions'], value: mode === 'on' }])} />
      </Row>
      {values.nudgeWaiting
        ? (
            <>
              <Row label="冷场多久后振铃">
                <Choice value={String(waitOf(values.nudgeAfterMinutes))} options={NUDGE_WAIT_OPTIONS} disabled={disabled}
                  onPick={(wait) => void write([{ op: 'set', path: ['experimental', 'nudgeAfterMinutes'], value: Number(wait) }])} />
              </Row>
              <p className="dsvc-set-note">
                只提醒，不代你回答：到点弹一张来电卡片说有问题等你，你回到对话里选哪个都一样算数，卡片会自己收掉。
              </p>
            </>
          )
        : null}
      <Row label="卡片主题">
        <Choice value={values.theme} options={THEMES} disabled={disabled}
          onPick={(theme) => void write([{ op: 'set', path: ['callCard', 'theme'], value: theme }])} />
      </Row>
      <Row label="配色">
        <PalettePicker value={values.palette} disabled={disabled}
          onPick={(palette) => void write([{ op: 'set', path: ['callCard', 'palette'], value: palette }])} />
      </Row>
      <RuntimeSection disabled={disabled} />
      <p className="dsvc-set-note">
        音色与语速对下一句生效；铃声、主题与配色对已经在屏幕上的来电卡片立即生效。
      </p>
      {error !== '' && <p className="dsvc-set-error">{error}</p>}
    </div>
  );
}

/** The theme a just-accepted write set, if it set one. */
function opsTheme(ops: readonly FieldOp[]): string | undefined {
  const hit = ops.find((op) => op.path.join('.') === 'callCard.theme');
  return hit?.value as string | undefined;
}

/** The palette a just-accepted write set, if it set one. */
function opsPalette(ops: readonly FieldOp[]): string | undefined {
  const hit = ops.find((op) => op.path.join('.') === 'callCard.palette');
  return hit?.value as string | undefined;
}

/** The ringtone flag a just-accepted write set, if it set one. */
function opsRingtone(ops: readonly FieldOp[]): boolean | undefined {
  const hit = ops.find((op) => op.path.join('.') === 'callCard.ringtone');
  return typeof hit?.value === 'boolean' ? hit.value : undefined;
}

/** The tone a just-accepted write set, if it set one. */
function opsTone(ops: readonly FieldOp[]): string | undefined {
  const hit = ops.find((op) => op.path.join('.') === 'callCard.tone');
  return hit?.value as string | undefined;
}

const SETTINGS_STYLES = `
.dsvc-set {
  --dsvc-set-fg: var(--dsw-alias-label-primary, #0f1115);
  --dsvc-set-fg-2: var(--dsw-alias-label-secondary, #61666b);
  --dsvc-set-line: var(--dsw-alias-border-l2, #0000001a);
  --dsvc-set-bg: var(--dsw-alias-bg-layer-2, #ffffff);
  --dsvc-set-accent: var(--dsw-alias-link, #4176e6);
  /* The ink that sits ON the accent, which the host already keys to its own
     theme: white on the light accent, near-black on the dark one. Without it the
     filled 试听 pill would put white on #679efe in dark mode — 2.6:1, unreadable. */
  --dsvc-set-on-accent: var(--dsw-alias-label-primary-foreground, #ffffff);
  display: flex; flex-direction: column; gap: 2px;
  color: var(--dsvc-set-fg); font: inherit;
}
body[data-ds-dark-theme] .dsvc-set {
  --dsvc-set-fg: var(--dsw-alias-label-primary, #f9fafb);
  --dsvc-set-fg-2: var(--dsw-alias-label-secondary, #cfd3d6);
  --dsvc-set-line: var(--dsw-alias-border-l2, #ffffff1f);
  --dsvc-set-bg: var(--dsw-alias-bg-layer-2, #2c2c2e);
  --dsvc-set-accent: var(--dsw-alias-link, #679efe);
  --dsvc-set-on-accent: var(--dsw-alias-label-primary-foreground, #0f1115);
}
.dsvc-set-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 9px 0; border-bottom: 1px solid var(--dsvc-set-line);
}
.dsvc-set-label { font-size: 13px; color: var(--dsvc-set-fg); }
.dsvc-set-control { display: flex; align-items: center; gap: 8px; }
.dsvc-set-select, .dsvc-set-number {
  font: inherit; font-size: 13px; color: var(--dsvc-set-fg);
  background: var(--dsvc-set-bg); border: 1px solid var(--dsvc-set-line);
  border-radius: 8px; padding: 5px 9px;
}
.dsvc-set-number { width: 84px; text-align: right; }
.dsvc-set-select:focus-visible, .dsvc-set-number:focus-visible, .dsvc-swatch:focus-visible {
  outline: 2px solid var(--dsvc-set-accent); outline-offset: 1px;
}
.dsvc-set-swatches { display: flex; gap: 7px; }
/* The tone row: a dropdown and a button read as one control because they do one
   job — the button is how you find out what the dropdown's words mean. */
.dsvc-set-tone .dsvc-set-row { margin-bottom: 0; }
.dsvc-set-tone { margin-top: 2px; }
.dsvc-set-audition {
  margin-left: 8px;
  padding: 3px 10px;
  font: inherit; font-size: 12px; line-height: 1.4;
  color: var(--dsvc-set-fg);
  background: transparent;
  border: 1px solid var(--dsvc-set-line, #0000001a);
  border-radius: 999px;
  cursor: pointer;
}
.dsvc-set-audition:hover:not(:disabled) { border-color: var(--dsvc-set-accent, #4176e6); }
/* A preview that is currently making sound says so with the accent and a filled
   pill, not with a moving box: 停下 in blue is legible at a glance, a pulsing
   outline next to a dropdown is decoration. */
.dsvc-set-audition[aria-pressed='true'] {
  color: var(--dsvc-set-on-accent, #ffffff);
  background: var(--dsvc-set-accent, #4176e6);
  border-color: var(--dsvc-set-accent, #4176e6);
}
.dsvc-set-hint { font-size: 12px; line-height: 1.5; color: var(--dsvc-set-fg-2); margin: 4px 0 0; }
/* ---------- the fold ----------
   The settings rows no longer use it, but 运行环境's 高级选项 does, and its
   stylesheet is this one: a disclosure rather than a section, with a chevron as
   the only decoration — the host's own type scale carries the rest. */
.dsvc-set-more { margin-top: 6px; }
.dsvc-set-more > summary {
  cursor: pointer; list-style: none;
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--dsvc-set-fg-2); padding: 6px 0;
}
.dsvc-set-more > summary::-webkit-details-marker { display: none; }
.dsvc-set-more > summary::before {
  content: ''; width: 5px; height: 5px; flex: none;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg) translate(-1px, -1px);
  transition: transform 160ms ease;
}
.dsvc-set-more[open] > summary::before { transform: rotate(45deg) translate(-1px, 1px); }
.dsvc-set-more > summary:hover { color: var(--dsvc-set-accent); }
.dsvc-set-more > summary:focus-visible {
  outline: 2px solid var(--dsvc-set-accent); outline-offset: 2px; border-radius: 4px;
}
.dsvc-set-more > .dsvc-set-row:last-child { border-bottom: 0; }
.dsvc-swatch {
  width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
  border: 2px solid transparent; box-shadow: inset 0 0 0 1px #00000022;
  padding: 0;
}
.dsvc-swatch[data-active] { box-shadow: 0 0 0 2px var(--dsvc-set-bg), 0 0 0 4px currentColor; }
.dsvc-swatch:disabled { cursor: default; opacity: 0.5; }
.dsvc-set-note { font-size: 12px; line-height: 1.5; color: var(--dsvc-set-fg-2); margin: 10px 0 0; }
.dsvc-set-note code { font-size: 11px; }
.dsvc-set-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #ec1313); margin: 8px 0 0; }
.dsvc-set-summary { font-size: 12px; color: var(--dsw-alias-label-secondary, #61666b); }
`;
