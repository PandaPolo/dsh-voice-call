/**
 * The call card's appearance presets.
 *
 * A preset is not a colour: it is the accent trio (solid, wash, glow) plus the
 * ink that sits on the solid, for BOTH theme halves, because the light card and
 * the dark card need opposite ends of the same hue — the light card paints white
 * text on the accent, the dark card paints near-black. So each entry carries a
 * `light` and a `dark` token set and the card picks by theme.
 *
 * The invariant is contrast, not taste: every `(accent, ink)` pair in this table
 * clears WCAG AA for normal text (4.5:1), which `test/palettes.test.ts` enforces
 * so a future preset cannot quietly break it. `azure` is the card's original
 * palette and the default, so an untouched install renders exactly as before.
 *
 * It lives under `client/` because it is view data — the browser draws the card
 * and the settings swatches from it — and the client bundle's tsconfig keeps its
 * rootDir at `src/client`. The server reads only `PALETTE_IDS` (for the config
 * union) and `DEFAULT_PALETTE`/`paletteById` (for the resolved default), so the
 * one-way dependency is the schema mirroring what the view offers.
 *
 * @module dsh-voice-call/client/palettes
 */

/** A preset's token values for one theme half. */
export interface PaletteTokens {
  /** The solid accent: the answer button, the active ring, the voice badge. */
  readonly accent: string;
  /** The soft fill behind a selected or hovered accent-tinted surface. */
  readonly wash: string;
  /** The pulsing ring's outer glow, as an 8-digit hex with alpha. */
  readonly glow: string;
  /** The text/icon colour drawn ON TOP of {@link accent}. */
  readonly ink: string;
}

/** One named preset, with a Chinese label for the settings card. */
export interface Palette {
  readonly id: PaletteId;
  readonly label: string;
  readonly light: PaletteTokens;
  readonly dark: PaletteTokens;
  /**
   * True for the preset that paints nothing and inherits the host's own accent
   * tokens. Its {@link light}/{@link dark} values are what those tokens usually
   * resolve to — shown on the settings card's swatch, never emitted as CSS — so
   * they are the host's colour, not a promise this plugin makes, and the AA
   * invariant in test/palettes.test.ts applies to the tuned presets only.
   */
  readonly followsHost?: boolean;
}

/** The preset ids the `callCard.palette` config accepts. */
export type PaletteId = 'host' | 'azure' | 'teal' | 'amethyst' | 'ember' | 'rose' | 'graphite';

/** The card's supported themes; `system` follows the host's own attribute. */
export type CardTheme = 'system' | 'light' | 'dark';

/** The preset shown when the profile says nothing. */
export const DEFAULT_PALETTE: PaletteId = 'host';

/** The theme mode shown when the profile says nothing. */
export const DEFAULT_THEME: CardTheme = 'system';

export const PALETTES: readonly Palette[] = [
  {
    // The card as shipped before presets existed: every accent token reads the
    // host's own design token, so the card is the same colour family as whatever
    // palette the host is wearing. Emits no CSS at all (see paletteStyles).
    id: 'host',
    label: '跟随宿主',
    followsHost: true,
    light: { accent: '#4176e6', wash: '#e4edfd', glow: '#4176e64d', ink: '#ffffff' },
    dark: { accent: '#679efe', wash: '#34415b', glow: '#679efe4d', ink: '#0f1115' },
  },
  {
    // The host's usual blue, but pinned: white label text on #4176e6 is 4.24:1,
    // under WCAG AA for normal text, so this preset is the same hue one step
    // deeper (4.84:1). Choosing it trades following the host's palette live for
    // a contrast guarantee.
    id: 'azure',
    label: '靛蓝',
    light: { accent: '#3d6dd4', wash: '#e4edfd', glow: '#4176e64d', ink: '#ffffff' },
    dark: { accent: '#679efe', wash: '#34415b', glow: '#679efe4d', ink: '#0f1115' },
  },
  {
    id: 'teal',
    label: '玄青',
    light: { accent: '#0e6a70', wash: '#dff0f0', glow: '#12808a4d', ink: '#ffffff' },
    dark: { accent: '#57c2c8', wash: '#1f3f42', glow: '#57c2c84d', ink: '#0f1115' },
  },
  {
    id: 'amethyst',
    label: '紫檀',
    light: { accent: '#6748c4', wash: '#ebe6fb', glow: '#7b5cd64d', ink: '#ffffff' },
    dark: { accent: '#a996f0', wash: '#33295a', glow: '#a996f04d', ink: '#0f1115' },
  },
  {
    id: 'ember',
    label: '暮橙',
    light: { accent: '#a55113', wash: '#fbeee0', glow: '#c2621a4d', ink: '#ffffff' },
    dark: { accent: '#e8a765', wash: '#4a3520', glow: '#e8a7654d', ink: '#0f1115' },
  },
  {
    id: 'rose',
    label: '胭脂',
    light: { accent: '#ab2f5b', wash: '#fbe6ec', glow: '#c93a6b4d', ink: '#ffffff' },
    dark: { accent: '#f08fae', wash: '#4d2532', glow: '#f08fae4d', ink: '#0f1115' },
  },
  {
    id: 'graphite',
    label: '石墨',
    light: { accent: '#3f4a5a', wash: '#e9ecf1', glow: '#4a57684d', ink: '#ffffff' },
    dark: { accent: '#aab4c2', wash: '#333a45', glow: '#aab4c24d', ink: '#0f1115' },
  },
];

/** @param id - a palette id, tolerant of an unknown/absent config value. */
export function paletteById(id: string | undefined): Palette {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0]!;
}

/** The ids of {@link PALETTES}, for a config schema union. */
export const PALETTE_IDS = PALETTES.map((palette) => palette.id) as readonly PaletteId[];

const srgb = (channel: number): number => {
  const scaled = channel / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};

/**
 * WCAG relative luminance of a `#rgb`/`#rrggbb` colour.
 * @param hex - the colour, with or without alpha suffixes beyond 8 digits.
 */
export function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const full = digits.length === 3 ? digits.replaceAll(/./g, (c) => c + c) : digits.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
  return 0.2126 * srgb(r!) + 0.7152 * srgb(g!) + 0.0722 * srgb(b!);
}

/**
 * WCAG contrast ratio between two colours.
 * @param a - the first colour, as hex.
 * @param b - the second colour, as hex.
 * @returns the ratio, 1 (identical) to 21 (black on white).
 */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/* ------------------------------------------------------------------ *
 * The card's token layer, generated.
 *
 * `CARD_STYLES` asks for these names; this file owns their values. Two axes
 * meet here and they must not fight:
 *
 * - **theme** — `跟随系统` reads the host's own `--dsw-alias-*` tokens (the card
 *   is then the same colour family as whatever palette the host wears, live);
 *   a *pinned* theme cannot use those tokens at all, because the host only
 *   re-points them under `body[data-ds-dark-theme]`, so pinning emits literal
 *   values instead. The overlay resolves `system` against the host attribute
 *   and only ever sets `data-dsvc-theme` when the user pinned a half.
 * - **palette** — a preset sets the four accent *inputs*
 *   (`--dsvc-palette-accent|wash|glow|ink`) that the theme blocks below fall
 *   back through, so one preset covers both halves without a specificity war.
 *
 * `host` is the preset that paints nothing and keeps the host tokens.
 * ------------------------------------------------------------------ */

/** Every non-accent token, per theme half. `host` is the `--dsw-alias-*` read. */
export interface ThemeTokens {
  readonly fg: string;
  readonly fg2: string;
  readonly fg3: string;
  readonly line: string;
  readonly surface: string;
  readonly fill: string;
  readonly fillHover: string;
  readonly ink: string;
  readonly hangup: string;
  readonly hangupWash: string;
  readonly topline: string;
  readonly shadow: string;
}

/** One theme half: the host-token reading and the literal it stands for. */
export interface ThemeTier {
  readonly host: ThemeTokens;
  readonly literal: ThemeTokens;
}

export const THEME_TIERS: Record<'light' | 'dark', ThemeTier> = {
  light: {
    host: {
      fg: 'var(--dsw-alias-label-primary, #0f1115)',
      fg2: 'var(--dsw-alias-label-secondary, #61666b)',
      fg3: 'var(--dsw-alias-label-tertiary, #81858c)',
      line: 'var(--dsw-alias-border-l2, #0000001a)',
      surface: 'var(--dsw-alias-bg-layer-2, #ffffff)',
      fill: 'var(--dsw-alias-interactive-bg-active, #2631481a)',
      fillHover: 'var(--dsw-alias-interactive-bg-hover-accent, #26314824)',
      ink: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      hangup: 'var(--dsw-alias-state-error-primary, #ec1313)',
      hangupWash: 'var(--dsw-alias-interactive-bg-hover-danger, #ec13130d)',
      topline: 'inset 0 1px 0 #ffffff',
      shadow: '0 14px 34px -10px #0f11152e, 0 2px 6px #0f111514',
    },
    literal: {
      fg: '#0f1115', fg2: '#61666b', fg3: '#81858c', line: '#0000001a', surface: '#ffffff',
      fill: '#2631481a', fillHover: '#26314824', ink: '#ffffff',
      hangup: '#ec1313', hangupWash: '#ec13130d', topline: 'inset 0 1px 0 #ffffff',
      shadow: '0 14px 34px -10px #0f11152e, 0 2px 6px #0f111514',
    },
  },
  dark: {
    host: {
      fg: 'var(--dsw-alias-label-primary, #f9fafb)',
      fg2: 'var(--dsw-alias-label-secondary, #cfd3d6)',
      fg3: 'var(--dsw-alias-label-tertiary, #adb2b8)',
      line: 'var(--dsw-alias-border-l2, #ffffff1f)',
      surface: 'var(--dsw-alias-bg-layer-2, #2c2c2e)',
      fill: 'var(--dsw-alias-interactive-bg-active, #ffffff24)',
      fillHover: 'var(--dsw-alias-interactive-bg-hover-accent, #ffffff3d)',
      ink: 'var(--dsw-alias-label-primary-foreground, #0f1115)',
      hangup: 'var(--dsw-alias-state-error-primary, #f25a5a)',
      hangupWash: 'var(--dsw-alias-interactive-bg-hover-danger, #f25a5a26)',
      topline: 'inset 0 1px 0 #ffffff12',
      shadow: '0 18px 44px -12px #000000a6',
    },
    literal: {
      fg: '#f9fafb', fg2: '#cfd3d6', fg3: '#adb2b8', line: '#ffffff1f', surface: '#2c2c2e',
      fill: '#ffffff24', fillHover: '#ffffff3d', ink: '#0f1115',
      hangup: '#f25a5a', hangupWash: '#f25a5a26', topline: 'inset 0 1px 0 #ffffff12',
      shadow: '0 18px 44px -12px #000000a6',
    },
  },
};

/** The accent trio's host reading, per half — the fallback under a preset. */
export const HOST_ACCENT: Record<'light' | 'dark', PaletteTokens> = {
  light: {
    accent: 'var(--dsw-alias-link, #4176e6)',
    wash: 'var(--dsw-alias-state-business-tertiary, #e4edfd)',
    glow: '#4176e64d',
    ink: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  },
  dark: {
    accent: 'var(--dsw-alias-link, #679efe)',
    wash: 'var(--dsw-alias-state-business-tertiary, #34415b)',
    glow: '#679efe4d',
    ink: 'var(--dsw-alias-label-primary-foreground, #0f1115)',
  },
};

/** One `--dsvc-*` declaration block for a theme half. */
export function themeDecls(half: 'light' | 'dark', useHost: boolean): string {
  const tier = THEME_TIERS[half];
  const t = useHost ? tier.host : tier.literal;
  // The accent always reads through the palette inputs first, so a preset wins
  // in both modes and `host` (which sets none) falls through to this value.
  const accent = HOST_ACCENT[half];
  return `  --dsvc-fg: ${t.fg};
  --dsvc-fg-2: ${t.fg2};
  --dsvc-fg-3: ${t.fg3};
  --dsvc-line: ${t.line};
  --dsvc-surface: ${t.surface};
  --dsvc-fill: ${t.fill};
  --dsvc-fill-hover: ${t.fillHover};
  --dsvc-accent: var(--dsvc-palette-accent, ${accent.accent});
  --dsvc-accent-wash: var(--dsvc-palette-wash, ${accent.wash});
  --dsvc-accent-ink: var(--dsvc-palette-ink, ${accent.ink});
  --dsvc-accent-glow: var(--dsvc-palette-glow, ${accent.glow});
  --dsvc-hangup: ${t.hangup};
  --dsvc-hangup-wash: ${t.hangupWash};
  --dsvc-topline: ${t.topline};
  --dsvc-shadow: ${t.shadow};`;
}

/** The four accent inputs a preset contributes for one half. */
function paletteDecls(palette: Palette, half: 'light' | 'dark'): string {
  const t = palette[half];
  return `  --dsvc-palette-accent: ${t.accent};
  --dsvc-palette-wash: ${t.wash};
  --dsvc-palette-glow: ${t.glow};
  --dsvc-palette-ink: ${t.ink};`;
}

/**
 * The palette layer for one preset, both theme halves.
 *
 * Emitted in full (not just for the chosen preset) so a card already on screen
 * repaints the instant the settings card writes a new value — the attribute on
 * the stack is the only thing that changes.
 */
export function paletteStyles(): string {
  return PALETTES.filter((palette) => palette.followsHost !== true)
    .map((palette) => `.dsvc-stack[data-dsvc-palette="${palette.id}"] {
${paletteDecls(palette, 'light')}}
body[data-ds-dark-theme] .dsvc-stack[data-dsvc-palette="${palette.id}"]:not([data-dsvc-theme="light"]),
.dsvc-stack[data-dsvc-palette="${palette.id}"][data-dsvc-theme="dark"] {
${paletteDecls(palette, 'dark')}}`)
    .join('\n');
}
