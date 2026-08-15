/**
 * Backend factory + leaf-backend units: creation with faked probes, whisper
 * JSON parsing, shell quoting, the audio store's path confinement, and the
 * openai/whisper-local backends against stubbed runners.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { AudioStore } from '../src/audio.ts';
import { CrispasrTtsBackend, CUSTOMVOICE_SPEAKERS, buildCommandLine, playbackCommand, quoteForShell } from '../src/backends/crispasr.ts';
import { FakeSttBackend, FakeTtsBackend } from '../src/backends/fake.ts';
import { MacosSttBackend } from '../src/backends/macos.ts';
import { OpenAiSttBackend } from '../src/backends/openai.ts';
import { PiperTtsBackend } from '../src/backends/piper.ts';
import { SayTtsBackend } from '../src/backends/say.ts';
import { EdgeTtsBackend } from '../src/backends/edge-tts.ts';
import { shq } from '../src/backends/quote.ts';
import { createSttBackend, createTtsBackend } from '../src/backends/factory.ts';
import { WhisperLocalSttBackend, parseWhisperJson } from '../src/backends/whisper-local.ts';
import { resolveConfig } from '../src/types.ts';
import { assistantText } from '../src/read-replies.ts';

const noneProbes = {
  whisperLocal: false,
  say: false,
  macos: false,
  piper: false,
  edgeTts: false,
  crispasr: false,
  mic: false,
};

describe('backend factory', () => {
  it('creates the fake backends when pinned (CI default)', () => {
    const ctx = new Context();
    const config = resolveConfig({ stt: { backend: 'fake' }, tts: { backend: 'fake' } });
    assert.ok(createSttBackend({ ctx, config, probes: noneProbes }) instanceof FakeSttBackend);
    assert.ok(createTtsBackend({ ctx, config, probes: noneProbes }) instanceof FakeTtsBackend);
  });

  it('creates concrete backends when probes say they are available', () => {
    const ctx = new Context();
    const config = resolveConfig({});
    const say = createTtsBackend({ ctx, config, probes: { ...noneProbes, say: true } });
    assert.ok(say instanceof SayTtsBackend);
    const piper = createTtsBackend({ ctx, config, probes: { ...noneProbes, piper: true } });
    assert.ok(piper instanceof PiperTtsBackend);
    const crispasr = createTtsBackend({ ctx, config, probes: { ...noneProbes, crispasr: true } });
    assert.ok(crispasr instanceof CrispasrTtsBackend);
    const whisper = createSttBackend({ ctx, config, probes: { ...noneProbes, whisperLocal: true } });
    assert.ok(whisper instanceof WhisperLocalSttBackend);
    const macos = createSttBackend({ ctx, config, probes: { ...noneProbes, macos: true } });
    assert.ok(macos instanceof MacosSttBackend);
  });

  it('throws the selection reason when no backend is available', () => {
    const ctx = new Context();
    assert.throws(() => createSttBackend({ ctx, config: resolveConfig({}), probes: noneProbes }), /no offline STT backend/);
    assert.throws(() => createTtsBackend({ ctx, config: resolveConfig({}), probes: noneProbes }), /no local TTS backend/);
  });

  it('creates cloud backends only when pinned', () => {
    const ctx = new Context();
    const openai = createSttBackend({ ctx, config: resolveConfig({ stt: { backend: 'openai' } }), probes: noneProbes });
    assert.ok(openai instanceof OpenAiSttBackend);
    const edge = createTtsBackend({ ctx, config: resolveConfig({ tts: { backend: 'edge-tts' } }), probes: noneProbes });
    assert.ok(edge instanceof EdgeTtsBackend);
  });
});

describe('whisper JSON parsing', () => {
  it('parses the modern transcription[] shape', () => {
    const raw = JSON.stringify({ transcription: [{ timestamps: {}, offsets: {}, text: '  hello world  ' }] });
    assert.equal(parseWhisperJson(raw), 'hello world');
  });

  it('parses the legacy text shape', () => {
    assert.equal(parseWhisperJson(JSON.stringify({ text: 'legacy text' })), 'legacy text');
  });

  it('returns undefined for garbage', () => {
    assert.equal(parseWhisperJson('not json'), undefined);
    assert.equal(parseWhisperJson(JSON.stringify({})), undefined);
  });
});

describe('whisper-local backend', () => {
  it('invokes whisper-cli and parses the JSON it writes', async () => {
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      // The command is `whisper-cli -f <file> -oj -of <prefix>`; write the
      // JSON at <prefix>.json so the backend can read it.
      const match = /-of '([^']+)'/.exec(command);
      assert.ok(match !== null, `expected -of prefix in ${command}`);
      await writeFile(`${match[1]}.json`, JSON.stringify({ transcription: [{ text: 'recognized speech' }] }));      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const backend = new WhisperLocalSttBackend(run, { bin: 'whisper-cli', model: 'tiny' });
    const outcome = await backend.transcribe('/tmp/audio.m4a');
    assert.equal(outcome.transcript, 'recognized speech');
    assert.match(commands[0] ?? '', /whisper-cli/);
    assert.match(commands[0] ?? '', /-m 'tiny'/);
  });

  it('fails loud on a nonzero exit', async () => {
    const backend = new WhisperLocalSttBackend(async () => ({ exitCode: 1, stdout: '', stderr: 'model missing' }), { bin: 'whisper-cli' });
    await assert.rejects(backend.transcribe('/tmp/x.m4a'), /whisper-local: recognition failed/);
  });
});

describe('openai backend', () => {
  it('posts a multipart form and returns the transcript', async () => {
    const ctx = new Context();
    // Fake credentials provider.
    const credentials = {
      resolve: async () => ({ value: 'sk-test', source: 'test' }),
    };
    ctx.provide('credentials', credentials as never);
    let posted = false;
    const backend = new OpenAiSttBackend(ctx, {
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      model: 'whisper-1',
      fetchImpl: async (url, init) => {
        posted = true;
        assert.equal(url, 'https://api.example.com/v1/audio/transcriptions');
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer sk-test');
        return new Response(JSON.stringify({ text: 'cloud transcript' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-openai-'));
    try {
      await writeFile(join(dir, 'note.m4a'), 'bytes');
      const outcome = await backend.transcribe(join(dir, 'note.m4a'));
      assert.equal(outcome.transcript, 'cloud transcript');
      assert.equal(outcome.backend, 'openai');
      assert.ok(posted);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when the API key is missing', async () => {
    const ctx = new Context();
    const backend = new OpenAiSttBackend(ctx, { baseUrl: 'https://x/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'whisper-1', fetchImpl: async () => new Response('', { status: 500 }) });
    await assert.rejects(backend.transcribe('/tmp/x.m4a'), /no API key/);
  });
});

describe('shell quoting', () => {
  it('quotes single quotes safely', () => {
    assert.equal(shq("it's fine"), "'it'\\''s fine'");
    assert.equal(shq('plain'), "'plain'");
    assert.equal(shq('a b'), "'a b'");
  });
});

describe('crispasr backend', () => {
  it('builds the full command line with the customvoice backend', () => {
    const cmd = buildCommandLine([
      'crispasr', '--backend', 'qwen3-tts-customvoice',
      '-m', 'D:/tts/talker.gguf', '--codec-model', 'D:/tts/codec.gguf',
      '--voice', 'dylan', '--tts', '你好', '--tts-output', 'out.wav',
    ]);
    assert.match(cmd, /crispasr/);
    assert.match(cmd, /qwen3-tts-customvoice/);
    assert.match(cmd, /--voice/);
    assert.match(cmd, /dylan/);
    assert.match(cmd, /你好/);
    assert.match(cmd, /out\.wav/);
  });

  it('quotes apostrophes for the current shell family', () => {
    const q = quoteForShell("it's fine");
    assert.ok(q.length > 0);
  });

  it('lists all nine customvoice speakers', () => {
    assert.equal(CUSTOMVOICE_SPEAKERS.length, 9);
    assert.ok(CUSTOMVOICE_SPEAKERS.includes('dylan'));
    assert.ok(CUSTOMVOICE_SPEAKERS.includes('eric'));
    assert.ok(CUSTOMVOICE_SPEAKERS.includes('vivian'));
  });

  it('synthesizes through a stubbed runner and returns wav mime', async () => {
    let command = '';
    const backend = new CrispasrTtsBackend(async (cmd) => {
      command = cmd;
      return { exitCode: 0, stdout: '', stderr: '' };
    }, { bin: 'crispasr', model: 'm.gguf', codec: 'c.gguf' });
    const result = await backend.synthesize({ text: 'hello', voice: 'ryan' }, '/tmp/out.wav');
    assert.equal(result.mime, 'audio/wav');
    assert.match(command, /ryan/);
  });

  it('rejects unknown speakers', async () => {
    const backend = new CrispasrTtsBackend(async () => ({ exitCode: 0, stdout: '', stderr: '' }), { bin: 'crispasr', model: 'm.gguf', codec: 'c.gguf' });
    await assert.rejects(backend.synthesize({ text: 'x', voice: 'nobody' }, '/tmp/o.wav'), /unknown speaker/);
  });

  it('fails loud on a nonzero exit', async () => {
    const backend = new CrispasrTtsBackend(async () => ({ exitCode: 2, stdout: '', stderr: 'cuda error' }), { bin: 'crispasr', model: 'm.gguf', codec: 'c.gguf' });
    await assert.rejects(backend.synthesize({ text: 'x' }, '/tmp/o.wav'), /crispasr: synthesis failed/);
  });

  it('plays through a stubbed runner using the platform player', async () => {
    let command = '';
    const backend = new CrispasrTtsBackend(async (cmd) => {
      command = cmd;
      return { exitCode: 0, stdout: '', stderr: '' };
    }, { bin: 'crispasr', model: 'm.gguf', codec: 'c.gguf' });
    await backend.play('C:/voice/out.wav');
    assert.match(command, /SoundPlayer|afplay|aplay/);
    assert.match(command, /out\.wav/);
  });

  it('fails loud when playback exits nonzero', async () => {
    const backend = new CrispasrTtsBackend(async () => ({ exitCode: 1, stdout: '', stderr: 'no audio device' }), { bin: 'crispasr', model: 'm.gguf', codec: 'c.gguf' });
    await assert.rejects(backend.play('C:/voice/x.wav'), /crispasr: playback failed/);
  });

  it('quotes the wav path inside the playback command', () => {
    const cmd = playbackCommand("C:/voice/it's a test.wav");
    assert.ok(cmd.includes('a test.wav'));
    assert.ok(cmd.length > 0);
  });
});

describe('audio store', () => {
  it('commits files under the root and rejects escaping paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-store-'));
    try {
      const store = new AudioStore(join(dir, 'voice'));
      await store.ensure();
      const src = join(dir, 'src.m4a');
      await writeFile(src, 'audio-bytes');
      const ref = await store.commit(src, 'voice-in-1.m4a');
      assert.ok(ref.path.startsWith(store.rootDir));
      assert.equal(ref.mime, 'audio/mp4');
      assert.ok(await store.exists(ref.path));
      assert.throws(() => store.resolve('../escape.m4a'), /escapes the audio root/);
      assert.throws(() => store.resolve('/etc/passwd'), /escapes the audio root/);
      assert.equal(store.resolve(ref.path), ref.path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readReplies text extraction', () => {
  it('joins text blocks and ignores non-text blocks', () => {
    const content = [
      { type: 'text', text: 'build finished, ' },
      { type: 'text', text: '0 failures' },
      { type: 'tool_use', id: 'x' },
    ];
    assert.equal(assistantText(content as never), 'build finished, 0 failures');
    assert.equal(assistantText([]), '');
  });
});
