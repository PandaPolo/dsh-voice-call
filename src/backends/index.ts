/**
 * The dsh-voice-backends module: backend interfaces, the pure selection
 * resolver, availability probes, and every backend implementation (fake,
 * whisper-local, openai, macos, say, piper, edge-tts).
 *
 * Following the seam pattern, `dsh-voice` (tools + node) depends on this
 * module — it owns backend selection and the fake backend, so the tool layer
 * never talks to a concrete audio pipeline.
 *
 * @module dsh-voice/backends
 */
export type { SttBackend, SttBackendId, SttOutcome, TtsBackend, TtsBackendId, SynthesizeResult } from './types.ts';
export { selectSttBackend, selectTtsBackend, AUTO_STT_ORDER, AUTO_TTS_ORDER, type BackendProbes, type BackendSelection } from './selection.ts';
export { probeBackends, probeOnPath, probeFile, probeSay, probeSwift, probeWhisper, probeMic, probeCrispasr, type LiveProbes } from './probe.ts';
export { FakeSttBackend, FakeTtsBackend } from './fake.ts';
export { WhisperLocalSttBackend } from './whisper-local.ts';
export { OpenAiSttBackend } from './openai.ts';
export { MacosSttBackend, recordWithMacos } from './macos.ts';
export { SayTtsBackend } from './say.ts';
export { PiperTtsBackend } from './piper.ts';
export { EdgeTtsBackend } from './edge-tts.ts';
export { CrispasrTtsBackend, CUSTOMVOICE_SPEAKERS, isCustomVoiceSpeaker, crispasrCommand, buildCommandLine, quoteForShell, invokeForShell, type CustomVoiceSpeaker } from './crispasr.ts';
export { createSttBackend, createTtsBackend, createRecordFn, type BackendDeps } from './factory.ts';
export { shq } from './quote.ts';
