/**
 * The call card's live appearance state, shared between the two browser halves
 * of this plugin: the settings card (which writes it) and the ring overlay
 * (which renders it).
 *
 * Both halves are mounted by the same client bundle in the same page, so this
 * is a module-level store rather than an event bus or a fetch per ring. The
 * overlay seeds it once from `GET /voice/call/state` — the server's resolved
 * config is the source of truth for a fresh page — and the settings card pushes
 * each accepted write in, so changing the palette recolours a card that is
 * already on screen.
 *
 * @module dsh-voice-call/client/appearance
 */
import { paletteById, type CardTheme, type PaletteId } from './palettes.ts';
import { DEFAULT_TONE, toneById, type ToneId } from './tones.ts';

/** The card's presentation, as the host resolves it. */
export interface Appearance {
  readonly theme: CardTheme;
  readonly palette: PaletteId;
  readonly ringtone: boolean;
  readonly tone: ToneId;
}

/** What the card falls back to before the host's state arrives. */
const FALLBACK: Appearance = { theme: 'system', palette: 'azure', ringtone: true, tone: DEFAULT_TONE };

let current: Appearance = FALLBACK;
const listeners = new Set<() => void>();

/** @returns the appearance the overlay should render right now. */
export function getAppearance(): Appearance {
  return current;
}

/** A wire value: anything the server's resolved config says, unvalidated here. */
export interface AppearanceInput {
  readonly theme?: string;
  readonly palette?: string;
  readonly ringtone?: boolean;
  readonly tone?: string;
}

const THEMES: readonly CardTheme[] = ['system', 'light', 'dark'];

/**
 * Replace the appearance and notify, ignoring a value that changes nothing.
 * Both fields arrive over the wire (the state snapshot) or from the settings
 * card, so an unknown id falls back to the defaults rather than painting a card
 * with no accent.
 * @param next - the theme/palette/ringtone/tone quad to adopt.
 */
export function setAppearance(next: AppearanceInput): void {
  const merged: Appearance = {
    theme: THEMES.includes(next.theme as CardTheme) ? (next.theme as CardTheme) : current.theme,
    palette: paletteById(next.palette).id,
    // Absent means "the host does not have this option", which is the old
    // default behaviour: ring.
    ringtone: typeof next.ringtone === 'boolean' ? next.ringtone : current.ringtone,
    // Absent means "this write was not about the tone" — a snapshot from an
    // older server says nothing about which ringtone the user picked, and
    // resolving it to `classic` here would quietly undo their choice.
    tone: next.tone === undefined ? current.tone : toneById(next.tone).id,
  };
  if (merged.theme === current.theme && merged.palette === current.palette
    && merged.ringtone === current.ringtone && merged.tone === current.tone) return;
  current = merged;
  for (const listener of listeners) listener();
}

/**
 * Subscribe to appearance changes.
 * @param listener - invoked after every accepted change.
 * @returns the disposer removing the listener.
 */
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
