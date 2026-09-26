/**
 * The plugin's own config schema, validated the way the host validates it.
 *
 * `dsh web` resolves a plugin's `Config` through `Config['~standard'].validate`
 * (cordis `resolveConfig`, cordis/lib/index.js) and a failure there is not a
 * warning: the entry does not activate at all, so the plugin is dead for the
 * session. Nothing in this suite used to mount that path — every schema test
 * covered *tool parameter* schemas — which is how a `.volatile()` on an
 * enclosing object shipped and killed the whole plugin on start:
 *
 *   $.experimental.nudgeWaitingQuestions volatile fields require a fixed object
 *   path without an enclosing volatile field
 *
 * So this file asserts the rule on the real `Config`, and asserts the rule
 * itself with a two-line schema, because a guard that cannot fail is not a
 * guard: the host checks volatile paths while validating, from the schema shape
 * alone, with no user config involved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import z from '@deepseek-ai/schemastery';
import { Config } from '../src/index.ts';
import { resolveConfig } from '../src/types.ts';

/** The host's own validation entry point. */
function issuesOf(schema: unknown, config: unknown): string[] {
  const result = (schema as {
    '~standard': { validate: (value: unknown) => { issues?: readonly { message: string }[] } };
  })['~standard'].validate(config);
  assert.equal('then' in result, false, 'the host rejects async config validation');
  return (result.issues ?? []).map((issue) => issue.message);
}

/** The plugin's config, as the host would resolve it for a live profile. */
const validate = (config: unknown): string[] => issuesOf(Config, config);

describe('plugin config schema', () => {
  it('the host rule this file guards really exists', () => {
    // A volatile leaf inside a volatile object is what shipped by accident, and
    // it must fail here exactly as it failed in `dsh web`.
    const nested = z.object({
      experimental: z.object({ a: z.boolean().default(false).volatile() }).default({}).volatile(),
    });
    assert.ok(issuesOf(nested, {}).some((message) => message.includes('enclosing volatile field')),
      'the assertion below is worthless unless the host really rejects this shape');
    // Same leaf, object not volatile: accepted.
    const leaf = z.object({
      experimental: z.object({ a: z.boolean().default(false).volatile() }),
    });
    assert.deepEqual(issuesOf(leaf, {}), []);
  });

  it('activates for a profile that never mentions any of it', () => {
    assert.deepEqual(validate({}), []);
  });

  it('activates with an empty experimental block', () => {
    assert.deepEqual(validate({ experimental: {} }), []);
  });

  it('keeps the experimental patience inside the range the card offers', () => {
    assert.deepEqual(validate({ experimental: { nudgeAfterMinutes: 1 } }), []);
    assert.deepEqual(validate({ experimental: { nudgeAfterMinutes: 30 } }), []);
    assert.ok(validate({ experimental: { nudgeAfterMinutes: 0 } }).length > 0);
    assert.ok(validate({ experimental: { nudgeAfterMinutes: 31 } }).length > 0);
  });

  it('defaults the nudge off, so nobody gets a surprise card', () => {
    const resolved = resolveConfig(undefined);
    assert.equal(resolved.experimental.nudgeWaitingQuestions, false);
    assert.equal(resolved.experimental.nudgeAfterMinutes, 5);
    assert.deepEqual(resolveConfig({ experimental: { nudgeAfterMinutes: 1 } }).experimental, {
      nudgeWaitingQuestions: false,
      nudgeAfterMinutes: 1,
    });
  });
});
