/**
 * Palette units: the contrast invariant the preset table promises, and the
 * shape of the CSS generated from it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PALETTES, contrastRatio, paletteById, paletteStyles } from '../src/client/palettes.ts';

describe('call-card palettes', () => {
  it('keeps every tuned preset at WCAG AA for the text drawn on its accent', () => {
    for (const palette of PALETTES.filter((entry) => entry.followsHost !== true)) {
      for (const half of ['light', 'dark'] as const) {
        const tokens = palette[half];
        const ratio = contrastRatio(tokens.accent, tokens.ink);
        assert.ok(ratio >= 4.5, `${palette.id}/${half}: ${tokens.ink} on ${tokens.accent} is ${ratio.toFixed(2)}:1, under AA`);
      }
    }
  });

  it('ids are unique and the lookup falls back instead of throwing', () => {
    assert.equal(new Set(PALETTES.map((palette) => palette.id)).size, PALETTES.length);
    assert.equal(paletteById('nonsense').id, 'host');
    assert.equal(paletteById(undefined).id, 'host');
  });

  it('emits one light and one dark rule per preset, and none for the host preset', () => {
    const css = paletteStyles();
    const tuned = PALETTES.filter((palette) => palette.followsHost !== true);
    for (const palette of tuned) {
      assert.match(css, new RegExp(`\\.dsvc-stack\\[data-dsvc-palette="${palette.id}"\\]`));
    }
    assert.ok(!css.includes('data-dsvc-palette="host"'), 'the host preset must paint nothing');
    assert.equal((css.match(/--dsvc-palette-accent:/g) ?? []).length, tuned.length * 2);
  });
});
