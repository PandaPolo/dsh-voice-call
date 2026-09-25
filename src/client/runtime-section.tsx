/**
 * The 运行环境 section: the "点几个按钮" half of provisioning.
 *
 * Three rows — engine, talker, codec — each showing what it is, how big, where
 * it came from, and what to do when it failed. The section renders only what the
 * server reports: it never learns a URL, a size or a digest from the page, and
 * its selects carry identifiers the manifest resolves.
 *
 * All of the *content* (labels, percentages, byte strings, the button's own
 * wording) comes from `runtime-model.ts`, which is unit-tested; this file is
 * layout only. Two things are deliberately shown before the user commits: the
 * total bytes still to fetch, and the selected build's note — a 693 MB CUDA
 * archive and an 8.3 MB CPU archive are different decisions, and hiding that
 * behind one button is how a plugin ends up looking broken.
 *
 * @module dsh-voice-call/client/runtime-section
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  adoptProvision, cancelProvision, cleanupGroups, connectProvisionEvents, fetchDiskUsage,
  fetchProvisionState, previewProvision, startProvision,
} from './provision-api.ts';
import type { DiskUsage, ProvisionSelection, ProvisionState } from './provision-api.ts';
import {
  cleanupAction, cleanupSummary, defaultSelection, formatBytes, isDefaultSelection, pendingSteps,
  runtimeAction, runtimeNotice, runtimeRows, usageLine,
} from './runtime-model.ts';

/** The 运行环境 section; renders nothing when the host exposes no routes. */
export function RuntimeSection(props: { readonly disabled: boolean }): ReactNode {
  const [state, setState] = useState<ProvisionState | undefined>(undefined);
  const [selection, setSelection] = useState<ProvisionSelection>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [usage, setUsage] = useState<DiskUsage | undefined>(undefined);
  const [cleaning, setCleaning] = useState(false);
  const [picked, setPicked] = useState<readonly string[]>([]);

  useEffect(() => {
    let alive = true;
    void fetchProvisionState().then((found) => {
      if (!alive || found === undefined) return;
      setState(found);
      // The server's selection, not a locally derived one: it has read the root,
      // and the card has to start from the same place it will be charged from.
      setSelection(found.catalogue.selection);
    });
    // The stream owns updates from here: a run started elsewhere, or resumed
    // after a reload, shows up without this card asking for it.
    const disconnect = connectProvisionEvents((view) => {
      setState((prev) => (prev === undefined ? prev : { ...prev, view }));
    });
    return () => {
      alive = false;
      disconnect();
    };
  }, []);

  // The rows describe the plan the server last read. Moving a dropdown changes
  // the plan, so it has to be re-read — otherwise the card shows one build's
  // status under another build's name, which is the same lie in a new place.
  // Only these three fields pick different files; the source and the prefix do
  // not change what is on disk.
  const identity = `${selection.variantId}|${selection.talkerFile}|${selection.codecQuant}`;
  useEffect(() => {
    if (state === undefined || state.view.phase === 'preparing') return;
    let alive = true;
    void previewProvision(selection).then((ack) => {
      const view = ack.view;
      if (alive && view !== undefined) setState((prev) => (prev === undefined ? prev : { ...prev, view }));
    });
    return () => {
      alive = false;
    };
  }, [identity]);

  // A failed download is the moment the manual route stops being an expert's
  // option, so the fold that holds it opens itself. Nobody should have to guess
  // that 高级选项 is where the escape hatch lives.
  const failedSeen = state?.view.steps.some((step) => step.status === 'failed' || step.status === 'cancelled') ?? false;
  useEffect(() => {
    if (failedSeen) setAdvanced(true);
  }, [failedSeen]);

  // What the root costs, re-measured whenever a run changes it. The walk is a few
  // dozen stats, and the alternative — asking only when the button is pressed —
  // leaves a button that cannot say what it will free.
  const phase = state?.view.phase;
  useEffect(() => {
    let alive = true;
    void fetchDiskUsage().then((found) => {
      if (alive && found !== undefined) setUsage(found);
    });
    return () => {
      alive = false;
    };
  }, [phase, state?.view.remainingBytes]);

  if (state === undefined) return null;
  const { catalogue, view } = state;
  const rows = runtimeRows(view);
  const auto = isDefaultSelection(selection, catalogue.selection);
  const action = runtimeAction(view, busy, catalogue.usableFromConfig, auto);
  const configNotice = runtimeNotice(view, catalogue.usableFromConfig);
  const selected = catalogue.variants.find((entry) => entry.id === selection.variantId)
    ?? catalogue.variants.find((entry) => entry.id === catalogue.selection.variantId);
  // The talker carries the engine backend with it, so the pair is shown as one
  // choice rather than as a model and a flag the user must keep in step.
  const selectedTalker = catalogue.models.find((entry) => entry.role === 'talker' && entry.file === selection.talkerFile)
    ?? catalogue.models.find((entry) => entry.role === 'talker' && entry.file === catalogue.selection.talkerFile);
  const locked = props.disabled || busy || view.phase === 'preparing';
  const pending = pendingSteps(view);
  const clean = cleanupAction(usage, view.phase === 'preparing');

  const patch = (over: Partial<ProvisionSelection>): void => {
    setSelection((prev) => ({ ...prev, ...over }));
  };

  const install = async (): Promise<void> => {
    setBusy(true);
    setNotice('');
    const ack = await startProvision(selection);
    setBusy(false);
    if (ack.ok === false) setNotice(ack.message ?? '宿主拒绝了这次装配');
  };

  const cancel = async (): Promise<void> => {
    setBusy(true);
    await cancelProvision();
    setBusy(false);
  };

  /** Verify whatever the user dropped into the plugin's own download dir. */
  const verifyDropped = async (): Promise<void> => {
    setBusy(true);
    const targets = pending.length > 0 ? pending : view.steps;
    const results: string[] = [];
    for (const step of targets) {
      const ack = await adoptProvision(step.id, selection);
      results.push(`${step.id}：${ack.message ?? (ack.ok === true ? '已接管' : '无结果')}`);
    }
    setNotice(results.join(' · '));
    setBusy(false);
  };

  const openClean = async (): Promise<void> => {
    const found = await fetchDiskUsage();
    if (found === undefined) {
      setNotice('宿主没有报告磁盘占用');
      return;
    }
    setUsage(found);
    setPicked(defaultSelection(found, catalogue.usableFromConfig));
    setCleaning(true);
    setNotice('');
  };

  const confirmClean = async (): Promise<void> => {
    setBusy(true);
    const reply = await cleanupGroups(picked, true);
    setBusy(false);
    setCleaning(false);
    setNotice(reply.message ?? '清理未完成');
    const refreshed = await fetchDiskUsage();
    if (refreshed !== undefined) setUsage(refreshed);
  };

  return (
    <div className="dsvc-rt">
      <style>{RUNTIME_STYLES}</style>
      <div className="dsvc-rt-head">
        <span className="dsvc-set-label">运行环境</span>
        <span className="dsvc-rt-phase" data-phase={view.phase}>{view.summary}</span>
      </div>
      <p className="dsvc-rt-device">{catalogue.device}</p>
      {configNotice !== '' && <p className="dsvc-rt-hint">{configNotice}</p>}

      {/* One press, and it sits first: the device probe has already chosen the
          build, so nothing here needs a decision before it can be made. The byte
          total rides in the label, which is the one number worth showing early. */}
      <div className="dsvc-rt-actions">
        {action.cancelling ? (
          <button type="button" className="dsvc-rt-button" onClick={() => void cancel()}>{action.label}</button>
        ) : (
          <button type="button" className="dsvc-rt-button dsvc-rt-primary" disabled={action.disabled}
            onClick={() => void install()}>{action.label}</button>
        )}
      </div>

      {rows.map((row) => (
        <div className="dsvc-rt-step" key={row.id} data-status={row.statusText}>
          <div className="dsvc-rt-line">
            <span className="dsvc-rt-name">{row.name}</span>
            <span className="dsvc-rt-meta">{row.totalLabel} · {row.statusText}</span>
          </div>
          {row.showBar && (
            <>
              <span className="dsvc-rt-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.percent}>
                <span style={{ width: `${row.percent}%` }} />
              </span>
              <span className="dsvc-rt-progress">
                {[`${row.receivedLabel} / ${row.totalLabel}`, row.originLabel, row.rateLabel, row.etaLabel]
                  .filter((part) => part !== '')
                  .join(' · ')}
              </span>
            </>
          )}
          {row.showAdvice && <span className="dsvc-rt-advice">{row.advice}</span>}
        </div>
      ))}

      {/* Everything that is a real choice, rather than a confirmation, is behind
          this line — and it unfolds itself when a download fails, because that is
          the one moment the manual route stops being an expert's option. */}
      <details className="dsvc-set-more" open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}>
        <summary>高级选项</summary>
        <div className="dsvc-rt-controls">
          <label className="dsvc-rt-field">
            <span>模型</span>
            <select value={selectedTalker?.file ?? ''} disabled={locked}
              onChange={(event) => patch({ talkerFile: event.currentTarget.value })}>
              {catalogue.models.filter((entry) => entry.role === 'talker').map((entry) => (
                <option key={entry.file} value={entry.file}>{entry.label} · {entry.bytes}</option>
              ))}
            </select>
          </label>
          <label className="dsvc-rt-field">
            <span>引擎版本</span>
            <select value={selected?.id ?? ''} disabled={locked}
              onChange={(event) => patch({ variantId: event.currentTarget.value })}>
              {catalogue.variants.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.offered}>
                  {option.label} · {formatBytes(option.bytes)}{option.offered ? '' : `（${option.whyNot}）`}
                </option>
              ))}
            </select>
          </label>
          <label className="dsvc-rt-field">
            <span>Codec 量化</span>
            <select value={selection.codecQuant ?? ''} disabled={locked}
              onChange={(event) => patch({ codecQuant: event.currentTarget.value })}>
              {catalogue.models.filter((entry) => entry.role === 'codec').map((entry) => (
                <option key={entry.quant} value={entry.quant}>{entry.quant} · {entry.bytes}</option>
              ))}
            </select>
          </label>
          <label className="dsvc-rt-field">
            <span>下载源</span>
            <select value={selection.policy ?? 'auto'} disabled={locked}
              onChange={(event) => patch({ policy: event.currentTarget.value })}>
              {catalogue.sources.map((entry) => (
                <option key={entry.policy} value={entry.policy}>{entry.label}</option>
              ))}
            </select>
          </label>
        </div>

        {selection.policy === 'custom' && (
          <label className="dsvc-rt-field dsvc-rt-wide">
            <span>加速前缀（例 https://gh-proxy.com/）</span>
            <input type="text" value={selection.proxyPrefix ?? ''} disabled={locked}
              placeholder="https://gh-proxy.com/"
              onChange={(event) => patch({ proxyPrefix: event.currentTarget.value })} />
          </label>
        )}

        {selectedTalker !== undefined && (
          <p className="dsvc-rt-hint">
            {selectedTalker.note}
            {selectedTalker.backend !== '' ? ` 后端 ${selectedTalker.backend}。` : ''}
          </p>
        )}
        {view.phase !== 'preparing' && pending.length > 0 && selected !== undefined && (
          <p className="dsvc-rt-hint">{selected.note}</p>
        )}

        <div className="dsvc-rt-actions">
          <button type="button" className="dsvc-rt-button" disabled={locked}
            onClick={() => void verifyDropped()}>校验手动放置的文件</button>
        </div>
        <p className="dsvc-rt-hint">
          手动放置：把下载好的文件放进 <code>{catalogue.dropDir}</code>，再点上面的校验。校验不过的文件不会被采用。
        </p>
      </details>

      {clean.visible ? (
        <CleanPanel usage={usage} open={cleaning} picked={picked} busy={busy}
          trigger={clean.label} note={usageLine(usage)} disabled={clean.disabled}
          onOpen={() => void openClean()} onConfirm={() => void confirmClean()} onClose={() => setCleaning(false)}
          onPick={(next) => setPicked(next)} />
      ) : null}
      {notice !== '' && <p className="dsvc-set-error">{notice}</p>}
    </div>
  );
}

/**
 * The clean affordance and its confirmation.
 *
 * Its own component so the offline preview can render the real thing: this is
 * the one control in the plugin that destroys data, and "what does it look like
 * when it is open" should be answerable without booting the app.
 *
 * Closed, it is a row of its own with the footprint on the left — the number is
 * the reason someone goes looking for this control, so it sits where the eye
 * lands instead of inside a label nobody reads.
 */
export function CleanPanel(props: {
  readonly usage: DiskUsage | undefined;
  readonly open: boolean;
  readonly picked: readonly string[];
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly trigger: string;
  readonly note: string;
  readonly onOpen: () => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly onPick: (next: readonly string[]) => void;
}): ReactNode {
  const { usage, open, picked } = props;
  if (!open) {
    return (
      <div className="dsvc-rt-foot">
        <span className="dsvc-rt-foot-note">{props.note}</span>
        <button type="button" className="dsvc-rt-button dsvc-rt-clean-button" disabled={props.disabled} onClick={props.onOpen}>
          {props.trigger}
        </button>
      </div>
    );
  }
  return (
    <div className="dsvc-rt-clean dsvc-rt-clean-open">
      <div className="dsvc-rt-groups" role="group" aria-label="要清理的内容">
        {(usage?.groups ?? []).map((group) => (
          <label className="dsvc-rt-group" key={group.id} data-empty={group.present ? undefined : ''}>
            <input type="checkbox" disabled={!group.present} checked={picked.includes(group.id)}
              onChange={(event) => props.onPick(event.currentTarget.checked
                ? [...picked, group.id]
                : picked.filter((id) => id !== group.id))} />
            <span>{group.label}</span>
            <em>{group.present ? formatBytes(group.bytes) : '没有'}</em>
          </label>
        ))}
      </div>
      <p className="dsvc-rt-hint">{usage === undefined ? '' : cleanupSummary(usage, picked)}</p>
      {/* The scope sentence, in the panel that authorises the deletion: the fear
          this button answers is "will it also take the engine I set up myself",
          and the answer has to be visible at the moment of the click. */}
      <p className="dsvc-rt-hint">
        只删 <code>{usage?.root ?? ''}</code> 里的东西。你在配置里自己写的路径（比如 <code>D:\crispasr</code>）
        不在这个目录里，也不会被碰。
      </p>
      <div className="dsvc-rt-actions">
        <button type="button" className="dsvc-rt-button dsvc-rt-danger" disabled={props.busy || picked.length === 0}
          onClick={props.onConfirm}>确认清理</button>
        <button type="button" className="dsvc-rt-button" disabled={props.busy} onClick={props.onClose}>取消</button>
      </div>
    </div>
  );
}

const RUNTIME_STYLES = `
.dsvc-rt {
  /* ---------- token layer ----------
     The same five names the settings card defines, declared here as well. The
     section is only ever rendered inside that card, so it could have leaned on
     its stylesheet — but a component whose colours come from a sibling's style
     block loses them the moment the two are ordered differently or one is
     deduplicated, and it loses them quietly: white button, white text. Host
     token first, literal behind it, so this block is also correct alone. */
  --dsvc-set-fg: var(--dsw-alias-label-primary, #0f1115);
  --dsvc-set-fg-2: var(--dsw-alias-label-secondary, #61666b);
  --dsvc-set-line: var(--dsw-alias-border-l2, #0000001a);
  --dsvc-set-bg: var(--dsw-alias-bg-layer-2, #ffffff);
  --dsvc-set-accent: var(--dsw-alias-link, #4176e6);
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 0 2px; border-top: 1px solid var(--dsvc-set-line, #0000001a);
  color: var(--dsvc-set-fg, inherit); font: inherit;
}
/* The host owns this attribute and puts it on <body>; matching any ancestor
   keeps the section correct inside a dark container that is not the body. */
[data-ds-dark-theme] .dsvc-rt {
  --dsvc-set-fg: var(--dsw-alias-label-primary, #f9fafb);
  --dsvc-set-fg-2: var(--dsw-alias-label-secondary, #cfd3d6);
  --dsvc-set-line: var(--dsw-alias-border-l2, #ffffff1f);
  --dsvc-set-bg: var(--dsw-alias-bg-layer-2, #2c2c2e);
  --dsvc-set-accent: var(--dsw-alias-link, #679efe);
}
.dsvc-rt-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsvc-rt-phase { font-size: 12px; color: var(--dsvc-set-fg-2, #61666b); }
.dsvc-rt-phase[data-phase="failed"] { color: var(--dsw-alias-state-error-primary, #d13438); }
.dsvc-rt-phase[data-phase="ready"] { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.dsvc-rt-device { font-size: 12px; color: var(--dsvc-set-fg-2, #61666b); margin: 0; }
.dsvc-rt-step { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
.dsvc-rt-line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsvc-rt-name { font-size: 13px; }
.dsvc-rt-meta { font-size: 12px; color: var(--dsvc-set-fg-2, #61666b); }
.dsvc-rt-bar {
  display: block; height: 4px; border-radius: 999px; overflow: hidden;
  background: var(--dsvc-set-line, #0000001a);
}
.dsvc-rt-bar > span { display: block; height: 100%; background: var(--dsvc-set-accent, #4176e6); }
.dsvc-rt-progress, .dsvc-rt-hint, .dsvc-rt-advice { font-size: 12px; color: var(--dsvc-set-fg-2, #61666b); margin: 0; }
.dsvc-rt-advice { color: var(--dsw-alias-state-error-primary, #d13438); }
.dsvc-rt-controls { display: flex; flex-wrap: wrap; gap: 10px; }
/* Inside the fold, the flex parent's gap no longer reaches: a details element is
   one child of it, so its own contents need their own rhythm. */
.dsvc-set-more > .dsvc-rt-controls,
.dsvc-set-more > .dsvc-rt-field,
.dsvc-set-more > .dsvc-rt-hint,
.dsvc-set-more > .dsvc-rt-actions { margin-top: 9px; }
.dsvc-set-more > .dsvc-rt-hint:first-of-type { margin-top: 4px; }
.dsvc-rt-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dsvc-set-fg-2, #61666b); }
.dsvc-rt-field select, .dsvc-rt-field input {
  font: inherit; font-size: 13px; color: var(--dsvc-set-fg, inherit);
  background: var(--dsvc-set-bg, #fff); border: 1px solid var(--dsvc-set-line, #0000001a);
  border-radius: 8px; padding: 5px 9px; min-width: 150px;
}
.dsvc-rt-wide { flex: 1 1 100%; }
.dsvc-rt-wide input { min-width: 0; width: 100%; }
.dsvc-rt-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.dsvc-rt-button {
  font: inherit; font-size: 13px; cursor: pointer;
  color: var(--dsvc-set-fg, inherit); background: var(--dsvc-set-bg, #fff);
  border: 1px solid var(--dsvc-set-line, #0000001a); border-radius: 8px; padding: 6px 12px;
}
.dsvc-rt-primary { border-color: var(--dsvc-set-accent, #4176e6); color: var(--dsvc-set-accent, #4176e6); }
.dsvc-rt-button:disabled { opacity: .55; cursor: default; }
.dsvc-rt-button:focus-visible { outline: 2px solid var(--dsvc-set-accent, #4176e6); outline-offset: 1px; }

/* ---------- the clean panel ----------
   Its own band at the bottom of the section, divided from the rows above: this
   is the control that answers "how much is this taking, and how do I take it
   back", and it was a grey underlined link nobody could find. Once open it earns
   a border and a red confirm, because at that point it is about to delete
   something. */
.dsvc-rt-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--dsvc-set-line, #0000001a);
}
.dsvc-rt-foot-note { font-size: 12px; color: var(--dsvc-set-fg-2, #61666b); font-variant-numeric: tabular-nums; }
.dsvc-rt-clean-button { border-color: var(--dsvc-set-line, #0000001a); }
.dsvc-rt-clean-button:hover:not(:disabled) {
  color: var(--dsw-alias-state-error-primary, #d13438);
  border-color: var(--dsw-alias-state-error-primary, #d13438);
}
.dsvc-rt-clean-open {
  display: flex; flex-direction: column; gap: 8px;
  margin-top: 4px; padding: 11px 12px; border-radius: 10px;
  border: 1px solid #d1343833;
  background: #d1343808;
}
.dsvc-rt-groups { display: flex; flex-direction: column; gap: 6px; }
.dsvc-rt-group { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.dsvc-rt-group input { accent-color: var(--dsw-alias-state-error-primary, #d13438); }
.dsvc-rt-group span { flex: 1; }
.dsvc-rt-group em { font-style: normal; font-size: 12px; color: var(--dsvc-set-fg-2, #61666b); font-variant-numeric: tabular-nums; }
.dsvc-rt-group[data-empty] span, .dsvc-rt-group[data-empty] em { opacity: .5; }
.dsvc-rt-danger {
  color: var(--dsw-alias-state-error-primary, #d13438);
  border-color: var(--dsw-alias-state-error-primary, #d13438);
}
.dsvc-rt-danger:hover:not(:disabled) { background: #d1343814; }
`;
