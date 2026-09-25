/**
 * Renderer test: the `voice-note` node builds the expected audio-card
 * `node.data` from a logged `voice/note` event, degrades to a
 * transcript-only card when the audio ref is missing, and stays pure over
 * replay (the same event always yields the same card, no I/O).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConversationLocation, ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { locationOf, transcriptOnlyCard, viewData, voiceNoteDefinition } from '../src/client/definition.ts';
import type { VoiceNoteState } from '../src/client/definition.ts';
import { audioUrlOf } from '../src/client/types.ts';
import type { VoiceNoteEventData } from '../src/client/types.ts';

function voiceNoteEvent(data: VoiceNoteEventData, seq = 42): { type: 'voice/note'; seq: number; time: number; data: VoiceNoteEventData } {
  return { type: 'voice/note', seq, time: 1723600000000, data };
}

/** One of our events as the matcher receives it: same payload, the engine's own
 *  branded sequence number, which a test literal cannot mint. */
const logged = (event: ReturnType<typeof voiceNoteEvent>): Parameters<typeof voiceNoteDefinition.match>[0] => event as Parameters<typeof voiceNoteDefinition.match>[0];

function startMatch(event: ReturnType<typeof voiceNoteEvent>): ConversationMatch {
  return {
    event: event as never,
    role: 'start',
    location: { kind: 'turn', turn: { turn: 2, start: undefined, end: undefined, status: 'open', steps: [], data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) } } } as ConversationLocation,
  };
}

function contextFor(event: ReturnType<typeof voiceNoteEvent>): ConversationNodeContext<VoiceNoteState> {
  // `ConversationMatch` is the union over the roles, and a node's `start` slot
  // takes only the opening one — the annotation on the helper says the union
  // because that is what the literal widens to.
  const match = startMatch(event) as Extract<ConversationMatch, { role: 'start' }>;
  const state = voiceNoteDefinition.start({ key: 'voice-note', kind: 'voice-note', id: event.data.noteId, matches: [match], start: match, state: undefined, current: new Map() }, match, { previous: () => undefined });
  return {
    key: 'voice-note',
    kind: 'voice-note',
    id: event.data.noteId,
    matches: [match],
    start: match,
    state,
    current: new Map(),
  };
}

describe('voice-note Definition', () => {
  const event = voiceNoteEvent({
    noteId: 'voice-abc123',
    turn: 2,
    step: 1,
    audioRef: { path: '/Users/me/.dsh/voice/voice-in-abc.m4a', mime: 'audio/mp4', durationMs: 3200 },
    transcript: 'run the tests',
    direction: 'in',
    backend: 'macos',
  });

  it('matches only voice/note events and extracts the stable note id', () => {
    assert.deepEqual(voiceNoteDefinition.match(logged(event)), { id: 'voice-abc123', role: 'start' });
    assert.equal(voiceNoteDefinition.match({ type: 'user/message', seq: 1, time: 0, data: {} } as never), null);
  });

  it('builds the expected audio-card node.data from a logged event', () => {
    const ctx = contextFor(event);
    const node = voiceNoteDefinition.buildViewNode!(ctx);
    assert.ok(node !== null);
    assert.equal(node.kind, 'voice-note');
    assert.equal(node.target, 'chat');
    assert.equal(node.id, 'voice-abc123');
    assert.equal(node.key, 'voice-note');
    // `anchorSeq` and `visibility` are fields this plugin adds to its own view
    // node; the host's declared node type stops at what it consumes itself, so
    // the two reads are named once here instead of cast at each assertion.
    const card = node as typeof node & { anchorSeq: number; visibility: string };
    assert.equal(card.anchorSeq, 42);
    assert.equal(card.visibility, 'visible');
    const data = node.data as VoiceNoteState;
    assert.equal(data.noteId, 'voice-abc123');
    assert.equal(data.direction, 'in');
    assert.equal(data.transcript, 'run the tests');
    assert.equal(data.backend, 'macos');
    assert.equal(data.durationMs, 3200);
    assert.deepEqual(data.audioRef, { path: '/Users/me/.dsh/voice/voice-in-abc.m4a', mime: 'audio/mp4', durationMs: 3200 });
  });

  it('stays pure over replay: identical events yield identical cards', () => {
    const a = voiceNoteDefinition.buildViewNode!(contextFor(event));
    const b = voiceNoteDefinition.buildViewNode!(contextFor(event));
    // The location carries engine-owned live objects; the card payload and
    // every durable field must be byte-identical across replays.
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    assert.deepEqual(a?.data, b?.data);
  });

  it('degrades to a transcript-only card when the audio ref is dropped', () => {
    const ctx = contextFor(event);
    const node = voiceNoteDefinition.buildViewNode!(ctx) as { data: VoiceNoteState };
    const degraded = transcriptOnlyCard(viewData(node.data));
    assert.equal(degraded.audioRef, null);
    assert.equal(degraded.transcript, 'run the tests');
    assert.equal(degraded.noteId, 'voice-abc123');
    // The degraded card is still JSON-safe for replay.
    assert.deepEqual(JSON.parse(JSON.stringify(degraded)).audioRef, null);
  });

  it('publishes step location data for the owning step', () => {
    const ctx = contextFor(event);
    // The host hands a node the scope's previously published data so it can
    // diff against it; this card is static, so `null` is both what the first call
    // gets and all this one looks at.
    const loc = voiceNoteDefinition.buildLocationData!(ctx, 'step', null);
    assert.deepEqual(loc, {
      kind: 'step',
      turn: 2,
      step: 1,
      key: 'voice-note',
      value: {
        noteId: 'voice-abc123',
        direction: 'in',
        transcript: 'run the tests',
        backend: 'macos',
        audioRef: { path: '/Users/me/.dsh/voice/voice-in-abc.m4a', mime: 'audio/mp4', durationMs: 3200 },
        durationMs: 3200,
      },
    });
  });

  it('resolves the location from the start match', () => {
    const ctx = contextFor(event);
    const loc = locationOf(ctx);
    assert.equal(loc.kind, 'turn');
  });
});

describe('audio URL derivation (pure presenter helper)', () => {
  it('derives the same-origin route from a store path', () => {
    assert.equal(audioUrlOf('/Users/me/.dsh/voice/voice-in-abc.m4a'), '/voice/audio/voice-in-abc.m4a');
    assert.equal(audioUrlOf('/tmp/with space/x.m4a'), '/voice/audio/x.m4a');
    assert.equal(audioUrlOf('voice-in-abc.m4a'), '/voice/audio/voice-in-abc.m4a');
  });
});
