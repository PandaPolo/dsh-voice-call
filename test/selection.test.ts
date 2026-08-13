/**
 * Backend selection: given config + faked availability probes, the resolver
 * picks the expected backend and falls back in order; a pinned cloud backend
 * is chosen only when configured; no offline backend yields a clear reason.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUTO_STT_ORDER, AUTO_TTS_ORDER, selectSttBackend, selectTtsBackend } from '../src/backends/selection.ts';
import type { BackendProbes } from '../src/backends/selection.ts';

function probes(partial: Partial<BackendProbes>): BackendProbes {
  return {
    whisperLocal: false,
    say: false,
    macos: false,
    piper: false,
    edgeTts: false,
    mic: false,
    ...partial,
  };
}

describe('STT backend selection', () => {
  it('falls back whisper-local → macos in order', () => {
    assert.equal(selectSttBackend({}, probes({ whisperLocal: true, macos: true })).kind === 'ok' ? (selectSttBackend({}, probes({ whisperLocal: true, macos: true })) as { id: string }).id : '', 'whisper-local');
    const withMacos = selectSttBackend({}, probes({ macos: true })) as { kind: 'ok'; id: string };
    assert.equal(withMacos.id, 'macos');
  });

  it('respects the documented auto order', () => {
    assert.deepEqual(AUTO_STT_ORDER, ['whisper-local', 'macos']);
  });

  it('picks a pinned backend even without probes', () => {
    const pinned = selectSttBackend({ backend: 'openai' }, probes({})) as { kind: 'ok'; id: string };
    assert.equal(pinned.id, 'openai');
    const fake = selectSttBackend({ backend: 'fake' }, probes({})) as { kind: 'ok'; id: string };
    assert.equal(fake.id, 'fake');
  });

  it('never auto-selects a cloud backend', () => {
    const result = selectSttBackend({}, probes({ whisperLocal: false, macos: false }));
    assert.equal(result.kind, 'none');
    if (result.kind === 'none') assert.match(result.reason, /whisper-local/);
  });

  it('reports a reason mentioning the missing offline backends', () => {
    const result = selectSttBackend({}, probes({}));
    assert.equal(result.kind, 'none');
    if (result.kind === 'none') {
      assert.match(result.reason, /configure stt\.backend/);
      assert.match(result.reason, /"fake" for tests/);
    }
  });
});

describe('TTS backend selection', () => {
  it('defaults to say when available, else piper', () => {
    const say = selectTtsBackend({}, probes({ say: true })) as { kind: 'ok'; id: string };
    assert.equal(say.id, 'say');
    const piper = selectTtsBackend({}, probes({ piper: true })) as { kind: 'ok'; id: string };
    assert.equal(piper.id, 'piper');
    assert.deepEqual(AUTO_TTS_ORDER, ['say', 'piper']);
  });

  it('never auto-selects edge-tts (cloud)', () => {
    const result = selectTtsBackend({}, probes({ edgeTts: true }));
    assert.equal(result.kind, 'none');
  });

  it('picks edge-tts only when explicitly configured', () => {
    const pinned = selectTtsBackend({ backend: 'edge-tts' }, probes({})) as { kind: 'ok'; id: string };
    assert.equal(pinned.id, 'edge-tts');
  });

  it('reports a reason when no local TTS exists', () => {
    const result = selectTtsBackend({}, probes({}));
    assert.equal(result.kind, 'none');
    if (result.kind === 'none') assert.match(result.reason, /say or piper/);
  });
});
