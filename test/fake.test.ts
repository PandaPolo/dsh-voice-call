/**
 * Fake backend (text-to-text): the fake STT/TTS backends map a fixture
 * "audio" file to fixed transcript text and back, so the whole tool path
 * (transcribe pipeline + speak job) runs with no mic and no network — the
 * default in CI.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { JobId, JobStart } from '@deepseek-ai/dsh-jobs';
import { FakeSttBackend, FakeTtsBackend, fakeTranscriptFrom } from '../src/backends/fake.ts';
import { runTranscribe, type TranscribeDeps } from '../src/tools/transcribe.ts';
import { startSpeakJob, type SpeakDeps } from '../src/tools/speak.ts';
import type { AudioRef, VoiceNoteData } from '../src/types.ts';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-fake-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('fake STT backend', () => {
  it('maps a JSON fixture file to fixed transcript text', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'fixture.m4a');
      await writeFile(file, JSON.stringify({ transcript: 'build finished, zero failures' }), 'utf8');
      const outcome = await new FakeSttBackend().transcribe(file);
      assert.equal(outcome.transcript, 'build finished, zero failures');
      assert.equal(outcome.backend, 'fake');
    });
  });

  it('derives transcript text from the basename for hand-made fixtures', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'fixture-check-tests.m4a');
      await writeFile(file, 'any bytes', 'utf8');
      assert.equal(await fakeTranscriptFrom(file), 'fixture check tests');
    });
  });

  it('round-trips through the fake TTS (speak then transcribe)', async () => {
    await withTempDir(async (dir) => {
      const dest = join(dir, 'out.json');
      const tts = new FakeTtsBackend();
      const result = await tts.synthesize({ text: 'the build passed' }, dest);
      assert.match(result.mime, /json/);
      const raw = JSON.parse(await readFile(dest, 'utf8')) as { transcript: string };
      assert.equal(raw.transcript, 'the build passed');
      const stt = new FakeSttBackend();
      const outcome = await stt.transcribe(dest);
      assert.equal(outcome.transcript, 'the build passed');
    });
  });
});

describe('transcribe pipeline with the fake backend', () => {
  it('transcribes a file, commits the audio, appends voice/note, and delivers the user message', async () => {
    await withTempDir(async (dir) => {
      const fixture = join(dir, 'voice-note.m4a');
      await writeFile(fixture, JSON.stringify({ transcript: 'run the tests' }), 'utf8');
      const notes: VoiceNoteData[] = [];
      const delivered: string[] = [];
      let committed: AudioRef | undefined;

      const deps: TranscribeDeps = {
        stt: new FakeSttBackend(),
        record: async () => { throw new Error('record should not be called for file input'); },
        commit: async (file, name) => {
          committed = { path: join(dir, name), mime: 'audio/mp4' };
          return committed;
        },
        appendNote: (note) => notes.push(note),
        deliverToPeer: async () => undefined,
        deliverUserMessage: (transcript, noteId) => delivered.push(`${noteId}:${transcript}`),
        coords: () => ({ turn: 3, step: 2 }),
        now: () => 1723600000000,
      };

      const output = await runTranscribe(deps, { source: { file: fixture } });
      assert.equal(output.transcript, 'run the tests');
      assert.equal(output.backend, 'fake');
      assert.equal(output.durationMs, undefined);
      assert.ok(committed !== undefined);
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.direction, 'in');
      assert.equal(notes[0]?.transcript, 'run the tests');
      assert.equal(notes[0]?.turn, 3);
      assert.equal(notes[0]?.step, 2);
      assert.equal(notes[0]?.audioRef.path, committed?.path);
      assert.equal(delivered.length, 1);
      assert.ok(delivered[0]?.endsWith(':run the tests'));
    });
  });

  it('records when asked, then transcribes the recorded file', async () => {
    await withTempDir(async (dir) => {
      const recorded = join(dir, 'rec.m4a');
      await writeFile(recorded, JSON.stringify({ transcript: 'check the logs' }), 'utf8');
      const notes: VoiceNoteData[] = [];
      const deps: TranscribeDeps = {
        stt: new FakeSttBackend(),
        record: async (seconds) => {
          assert.equal(seconds, 4);
          return { file: recorded, durationMs: 4000 };
        },
        commit: async (file, name) => ({ path: join(dir, name), mime: 'audio/mp4' }),
        appendNote: (note) => notes.push(note),
        deliverToPeer: async () => undefined,
        deliverUserMessage: () => {},
        coords: () => ({ turn: 1, step: 1 }),
        now: () => 1723600000000,
      };
      const output = await runTranscribe(deps, { source: { record: { seconds: 4 } } });
      assert.equal(output.transcript, 'check the logs');
      assert.equal(output.durationMs, 4000);
      assert.equal(notes[0]?.audioRef.path.includes('voice-in-'), true);
    });
  });

  it('delivers to a crosstalk peer when `to` is given instead of injecting a user message', async () => {
    await withTempDir(async (dir) => {
      const fixture = join(dir, 'note.m4a');
      await writeFile(fixture, JSON.stringify({ transcript: 'hello other session' }), 'utf8');
      const delivered: string[] = [];
      const deps: TranscribeDeps = {
        stt: new FakeSttBackend(),
        record: async () => { throw new Error('unused'); },
        commit: async (file, name) => ({ path: join(dir, name), mime: 'audio/mp4' }),
        appendNote: () => {},
        deliverToPeer: async (to, transcript) => {
          delivered.push(`${to}:${transcript}`);
          return { messageId: 'msg-1', peer: to };
        },
        deliverUserMessage: () => { throw new Error('user message should not be delivered when to is set'); },
        coords: () => ({ turn: 2, step: 1 }),
        now: () => 1723600000000,
      };
      const output = await runTranscribe(deps, { source: { file: fixture }, to: 'peer-a' });
      assert.deepEqual(delivered, ['peer-a:hello other session']);
      assert.deepEqual(output.deliveredTo, { messageId: 'msg-1', peer: 'peer-a' });
    });
  });
});

describe('speak job with the fake backend', () => {
  it('synthesizes to a file, appends an outbound note, and completes the job', async () => {
    await withTempDir(async (dir) => {
      const dest = join(dir, 'voice-speak-x.m4a');
      const notes: VoiceNoteData[] = [];
      let started: JobStart | undefined;

      const deps: SpeakDeps = {
        tts: new FakeTtsBackend(),
        startJob: (spec) => {
          started = spec;
          return spec.kind as unknown as JobId;
        },
        audioPath: () => dest,
        appendNote: (note) => notes.push(note),
        injectFailure: () => { throw new Error('should not fail'); },
        coords: () => ({ turn: 5, step: 1 }),
        now: () => 1723600000000,
      };

      const handle = startSpeakJob(deps, { text: 'build finished', voice: 'Samantha' });
      const outcome = await handle.settled;
      assert.equal(outcome.status, 'completed');
      assert.equal(started?.kind, 'voice-speak');
      assert.match(started?.label ?? '', /build finished/);
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.direction, 'out');
      assert.equal(notes[0]?.transcript, 'build finished');
      assert.equal(notes[0]?.audioRef.path, dest);
      assert.equal(notes[0]?.backend, 'fake');
      const written = JSON.parse(await readFile(dest, 'utf8')) as { transcript: string };
      assert.equal(written.transcript, 'build finished');
    });
  });

  it('injects a failure note instead of throwing when synthesis fails', async () => {
    await withTempDir(async (dir) => {
      const injected: string[] = [];
      const failing: SpeakDeps = {
        tts: {
          id: 'fake',
          synthesize: async () => { throw new Error('synthesis exploded'); },
          play: async () => {},
        },
        startJob: (spec) => spec.kind as unknown as JobId,
        audioPath: () => join(dir, 'out.m4a'),
        appendNote: () => {},
        injectFailure: (message) => injected.push(message),
        coords: () => ({ turn: 1, step: 1 }),
        now: () => 1723600000000,
      };
      const handle = startSpeakJob(failing, { text: 'boom' });
      const outcome = await handle.settled;
      assert.equal(outcome.status, 'failed');
      assert.match(outcome.detail ?? '', /synthesis exploded/);
      assert.deepEqual(injected, ['synthesis exploded']);
    });
  });
});
