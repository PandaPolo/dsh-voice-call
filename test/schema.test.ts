/**
 * Arg-schema units: `transcribe`'s exact-one `{file|record}` union and
 * `speak`'s optional `voice`/`rate` validate and reject correctly through
 * the same validator the registry runs before `execute`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateArgs } from '@deepseek-ai/dsh-tools';
import { transcribeParameters } from '../src/tools/transcribe.ts';
import { speakParameters } from '../src/tools/speak.ts';

describe('transcribe parameter schema', () => {
  it('accepts exactly one of {file} | {record}', () => {
    assert.deepEqual(validateArgs(transcribeParameters, { source: { file: '/tmp/note.m4a' } }), []);
    assert.deepEqual(validateArgs(transcribeParameters, { source: { record: {} } }), []);
    assert.deepEqual(validateArgs(transcribeParameters, { source: { record: { seconds: 3 } } }), []);
    assert.deepEqual(validateArgs(transcribeParameters, { source: { file: '/tmp/note.m4a' }, to: 'peer-1' }), []);
  });

  it('rejects both branches at once (exact-one)', () => {
    const errors = validateArgs(transcribeParameters, { source: { file: '/tmp/note.m4a', record: { seconds: 3 } } });
    assert.ok(errors.length > 0, `expected rejection, got: ${JSON.stringify(errors)}`);
  });

  it('rejects an empty source and a missing source', () => {
    assert.ok(validateArgs(transcribeParameters, { source: {} }).length > 0);
    assert.ok(validateArgs(transcribeParameters, {}).length > 0);
  });

  it('rejects unknown source keys', () => {
    const errors = validateArgs(transcribeParameters, { source: { file: '/tmp/x.m4a', tee: 'nope' } });
    assert.ok(errors.length > 0, `expected rejection, got: ${JSON.stringify(errors)}`);
  });

  it('rejects non-string file paths', () => {
    assert.ok(validateArgs(transcribeParameters, { source: { file: 42 } }).length > 0);
  });
});

describe('speak parameter schema', () => {
  it('requires text and tolerates optional voice/rate', () => {
    assert.deepEqual(validateArgs(speakParameters, { text: 'build finished' }), []);
    assert.deepEqual(validateArgs(speakParameters, { text: 'hi', voice: 'Samantha', rate: 180 }), []);
    assert.ok(validateArgs(speakParameters, {}).length > 0);
    assert.ok(validateArgs(speakParameters, { text: 7 }).length > 0);
    assert.ok(validateArgs(speakParameters, { text: 'hi', rate: 'fast' }).length > 0);
  });
});
