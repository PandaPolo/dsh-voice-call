/**
 * The ringtone library: what the 铃声 dropdown offers and which file each entry
 * plays.
 *
 * Same shape as {@link ./palettes.ts} — a table the view draws and the server
 * reads the ids of, because the one thing that must not drift is the set of
 * acceptable values: the config schema takes its union from `TONE_IDS`, the route
 * resolves a requested id through `toneById` (which falls back rather than
 * trusting the caller), and `test/tones.test.ts` checks every entry against the
 * bytes on disk in both directions. A tone id is never a path: the route maps it
 * to a constant from this table and nothing else, so `?tone=../../package.json`
 * gets the default ringtone instead of the package manifest.
 *
 * Every file here is synthesized by `scripts/gen-ringtone-candidates.mjs` from
 * recipes in this repository. Nothing is third-party audio: a messenger's ringtone
 * is someone's trademark, and the plugin would then be shipping a sound it cannot
 * prove the provenance of. Each entry is 3.0–4.2 s of 22.05 kHz mono 16-bit WAV
 * (133–185 kB), and all eleven are matched to the same loudness window, so picking
 * one is a judgement about the sound rather than about which one is louder.
 *
 * @module dsh-voice-call/client/tones
 */

/** One ringtone the user can choose. */
export interface Tone {
  readonly id: ToneId;
  /** The label in the dropdown — a few characters, no sentence. */
  readonly label: string;
  /** Why anyone would pick this one, shown for the chosen entry only. */
  readonly hint: string;
  /** Relative to the package's `assets/` directory. A constant, never user input. */
  readonly file: string;
}

/** The ids `callCard.tone` accepts. */
export type ToneId =
  | 'classic'
  | 'felt-piano'
  | 'nylon-guitar'
  | 'marimba'
  | 'music-box'
  | 'kalimba'
  | 'singing-bowl'
  | 'hummed-third'
  | 'rhodes-swell'
  | 'bamboo-flute'
  | 'minor-chime';

/** What an untouched install rings with — the sound shipped since v0.3. */
export const DEFAULT_TONE: ToneId = 'classic';

export const TONES: readonly Tone[] = [
  { id: 'classic', label: '下行拨弦', hint: '插件一直自带的那条：C5·A4·G4·E4 下行拨弦，木质、不金属。', file: 'ringtone.wav' },
  { id: 'felt-piano', label: '毡音钢琴', hint: '闷、木质，像隔壁房间随手弹了四下。最不像设备在响。', file: 'ringtones/felt-piano.wav' },
  { id: 'nylon-guitar', label: '尼龙弦吉他', hint: '真实拨弦物理模型，越往后越暗，不是越往后越尖。', file: 'ringtones/nylon-guitar.wav' },
  { id: 'marimba', label: '马林巴', hint: '短、圆、带木框的嗡声。最不温柔，也最难被忽略。', file: 'ringtones/marimba.wav' },
  { id: 'music-box', label: '八音盒', hint: '高把位一路弱下去。是玩具的金属，不是大厅的金属。', file: 'ringtones/music-box.wav' },
  { id: 'kalimba', label: '拇指琴', hint: '两个音高差 6‰ 的缓慢拍频，听起来是活的。', file: 'ringtones/kalimba.wav' },
  { id: 'singing-bowl', label: '颂钵', hint: '4.2 秒的单音加五度，几乎不算旋律。最不着急的一条。', file: 'ringtones/singing-bowl.wav' },
  { id: 'hummed-third', label: '低吟两音', hint: '带揉弦的正弦，像闭着嘴「嗯——」两声。最不像提示音。', file: 'ringtones/hummed-third.wav' },
  { id: 'rhodes-swell', label: '电钢琴渐强', hint: '0.22 秒起音的 Am7，像有人把音量推上来。最不「叮」。', file: 'ringtones/rhodes-swell.wav' },
  { id: 'bamboo-flute', label: '竹笛下行', hint: '持续揉弦的气声，三个音收下去。没有打击感。', file: 'ringtones/bamboo-flute.wav' },
  { id: 'minor-chime', label: '小铃叮咚', hint: '金属泛音、有叮咚感，只是往下走且是小三度。如果这条仍然像车站广播，问题在金属本身。', file: 'ringtones/minor-chime.wav' },
];

/** @param id - a tone id, tolerant of an unknown or absent config value. */
export function toneById(id: string | undefined): Tone {
  return TONES.find((tone) => tone.id === id) ?? TONES[0]!;
}

/** The ids of {@link TONES}, for the config schema union. */
export const TONE_IDS = TONES.map((tone) => tone.id) as readonly ToneId[];
