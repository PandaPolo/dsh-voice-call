/**
 * Live availability probes for backend selection. Probes are filesystem/PATH
 * checks only — no shell, no network — so they are deterministic and cheap.
 *
 * @module dsh-voice/backends/probe
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceConfig } from '../types.ts';
import type { BackendProbes } from './selection.ts';

/** Whether `name` resolves on PATH as an executable file. */
export function probeOnPath(name: string): boolean {
  const path = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(':').filter((entry) => entry !== '')) {
    for (const ext of exts) {
      try {
        const candidate = join(dir, `${name}${ext}`);
        if (existsSync(candidate) && statSync(candidate).isFile()) return true;
      } catch {
        // unreadable directory entry — keep scanning
      }
    }
  }
  return false;
}

/** Whether a configured binary path exists as a file. */
export function probeFile(bin: string | undefined): boolean {
  if (bin === undefined || bin === '') return false;
  try {
    return existsSync(bin);
  } catch {
    return false;
  }
}

/** Whether the macOS `say` backend is available. */
export function probeSay(): boolean {
  return process.platform === 'darwin' && probeOnPath('say');
}

/** Whether the macOS SFSpeechRecognizer shim can run (darwin + swift). */
export function probeSwift(): boolean {
  return process.platform === 'darwin' && probeOnPath('swift');
}

/** Whether a whisper.cpp binary is reachable (configured or on PATH). */
export function probeWhisper(config: VoiceConfig): boolean {
  const configured = config.stt.whisperLocal?.bin;
  if (configured !== undefined && configured !== '') return probeFile(configured);
  return probeOnPath('whisper-cli') || probeOnPath('whisper');
}

/** Whether a mic recording path exists (ffmpeg avfoundation or swift shim). */
export function probeMic(): boolean {
  if (process.platform !== 'darwin') return false;
  return probeOnPath('ffmpeg') || probeOnPath('swift');
}

/** Whether the local CrispASR engine is fully configured: bin + talker + codec. */
export function probeCrispasr(config: VoiceConfig): boolean {
  const engine = config.tts.crispasr;
  if (engine === undefined) return false;
  return probeFile(engine.bin) && probeFile(engine.model) && probeFile(engine.codec);
}

/** Probe every backend for the current machine + config. */
export function probeBackends(config: VoiceConfig): BackendProbes {
  return {
    whisperLocal: probeWhisper(config),
    say: probeSay(),
    macos: probeSwift(),
    piper: probeFile(config.tts.piper?.bin) || probeOnPath('piper'),
    edgeTts: probeOnPath('edge-tts'),
    crispasr: probeCrispasr(config),
    mic: probeMic(),
  };
}

/** Convenience alias so callers don't reach into node:fs. */
export type LiveProbes = BackendProbes;
