/**
 * The `durableEvents` gate: voice session-log events must stay OFF by default
 * because rc.6's session loader refuses logs containing unknown event types
 * (an appended voice/* event would permanently poison history loading).
 * These tests lock in: config default false, config passthrough true, and
 * the append functions no-op when the flag is off.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendVoiceCall } from '../src/events/call.ts';
import { appendVoiceNote } from '../src/session-events.ts';
import { resolveConfig } from '../src/types.ts';
import type { VoiceCallData, VoiceNoteData } from '../src/types.ts';

const callData: VoiceCallData = {
  callId: 'call-test-1',
  turn: 0,
  step: 0,
  transcript: 'hello',
  voice: 'dylan',
  decision: 'accepted',
  version: 1,
};

const noteData: VoiceNoteData = {
  noteId: 'voice-test-1',
  turn: 0,
  step: 0,
  audioRef: { path: 'C:/tmp/x.wav', mime: 'audio/wav', durationMs: 1000 },
  transcript: 'hello',
  direction: 'out',
  backend: 'fake',
};

function fakeSession(appended: unknown[]): { append(type: string, data: unknown): void } {
  return { append: (type, data) => { appended.push({ type, data }); } };
}

describe('durableEvents config', () => {
  it('defaults to false (rc.6 has no plugin-event registration surface)', () => {
    assert.equal(resolveConfig(undefined).durableEvents, false);
    assert.equal(resolveConfig({}).durableEvents, false);
    assert.equal(resolveConfig({ readReplies: true, callMode: 'ask' }).durableEvents, false);
  });

  it('honors an explicit true', () => {
    assert.equal(resolveConfig({ durableEvents: true }).durableEvents, true);
  });
});

describe('voice event appends respect the durableEvents gate', () => {
  it('appendVoiceCall is a no-op when disabled', () => {
    const appended: unknown[] = [];
    appendVoiceCall({} as never, fakeSession(appended) as never, callData, false);
    assert.equal(appended.length, 0);
  });

  it('appendVoiceCall appends when enabled', () => {
    const appended: unknown[] = [];
    appendVoiceCall({} as never, fakeSession(appended) as never, callData, true);
    assert.equal(appended.length, 1);
    assert.equal((appended[0] as { type: string }).type, 'voice/call');
  });

  it('appendVoiceNote is a no-op when disabled', () => {
    const appended: unknown[] = [];
    appendVoiceNote({} as never, fakeSession(appended) as never, noteData, false);
    assert.equal(appended.length, 0);
  });

  it('appendVoiceNote appends when enabled', () => {
    const appended: unknown[] = [];
    appendVoiceNote({} as never, fakeSession(appended) as never, noteData, true);
    assert.equal(appended.length, 1);
    assert.equal((appended[0] as { type: string }).type, 'voice/note');
  });

  it('never throws for a missing session, enabled or not', () => {
    assert.doesNotThrow(() => appendVoiceCall({} as never, undefined, callData, true));
    assert.doesNotThrow(() => appendVoiceNote({} as never, undefined, noteData, true));
  });
});
