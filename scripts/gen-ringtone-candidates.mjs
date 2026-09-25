/**
 * Ten ringtone candidates plus the one currently shipped, so they can be
 * compared on the same page: `node scripts/gen-ringtone-candidates.mjs`
 * writes `design/ringtones/*.wav` + a `design/ringtones/index.html` player, and
 * copies the ten real candidates to `assets/ringtones/<id>.wav` — which is what
 * the settings card's 铃声 dropdown plays (`src/client/tones.ts` names the ids,
 * and this script refuses to finish if the two lists disagree).
 *
 * The `design/` directory itself never ships: it is not in the `files` list in
 * package.json. `classic` still comes from `scripts/gen-ringtone.mjs`, so an
 * untouched install keeps the sound it has always had.
 *
 * The set is deliberately spread across timbre families (wood, string, metal,
 * air, voice, pad) rather than ten volumes of the same pluck, because "温柔" is
 * not one sound. What every recipe avoids is the transport-PA recipe that got
 * the previous version rejected: an ascending major triad, struck as a block,
 * with metallic inharmonic shimmer. Figures fall, chords are minor, and every
 * file is mixed to the same peak, so the choice is about the sound and not about
 * who grabbed it first — but see TARGET_LOUD in ringtone-kit.mjs for the equal-
 * loudness attempt that made seven of these inaudible, which is why the peaks
 * match and the windows do not.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbfs, encode, hz, loudWindow, render, SAMPLE_RATE, TARGET_PEAK } from './ringtone-kit.mjs';

const FELT = [
  { multiple: 1, gain: 1, decay: 1.5 },
  { multiple: 2, gain: 0.25, decay: 3.4 },
  { multiple: 3, gain: 0.09, decay: 5.2 },
  { multiple: 4, gain: 0.03, decay: 7 },
];
const MARIMBA = [
  { multiple: 1, gain: 1, decay: 3.2 },
  { multiple: 2, gain: 0.12, decay: 6 },
  // The 4:1 partial is what makes a bar instrument sound like wood in a frame.
  { multiple: 3.94, gain: 0.3, decay: 9 },
];
const BOX = [
  { multiple: 1, gain: 1, decay: 2.4 },
  { multiple: 2, gain: 0.34, decay: 5 },
  { multiple: 3.01, gain: 0.1, decay: 8 },
];
const KALIMBA = [
  { multiple: 1, gain: 1, decay: 2.2 },
  { multiple: 2, gain: 0.2, decay: 4.5 },
  { multiple: 3, gain: 0.06, decay: 7 },
];
const BOWL = [
  { multiple: 1, gain: 1, decay: 0.45 },
  { multiple: 2.76, gain: 0.5, decay: 1.05 },
  { multiple: 5.4, gain: 0.16, decay: 1.9 },
];
const AIR = [
  { multiple: 1, gain: 1, decay: 1.1 },
  { multiple: 2, gain: 0.14, decay: 2.6 },
  { multiple: 3, gain: 0.04, decay: 5 },
];
const RHODES = [
  { multiple: 1, gain: 1, decay: 1.3 },
  { multiple: 2, gain: 0.5, decay: 1.8 },
  { multiple: 3, gain: 0.22, decay: 2.3 },
  { multiple: 4, gain: 0.1, decay: 3 },
  { multiple: 5, gain: 0.05, decay: 3.6 },
];
const CHIME = [
  { multiple: 1, gain: 1, decay: 1 },
  { multiple: 2, gain: 0.45, decay: 2.2 },
  { multiple: 2.99, gain: 0.2, decay: 3.4 },
  { multiple: 4.28, gain: 0.07, decay: 4.8 },
  { multiple: 5.45, gain: 0.03, decay: 6.2 },
];
/** The shipped asset's voice, kept here so the control row is the same sound. */
const SHIPPED = [
  { multiple: 1, gain: 1, decay: 1.7 },
  { multiple: 2, gain: 0.3, decay: 3.1 },
  { multiple: 3, gain: 0.11, decay: 4.6 },
  { multiple: 4, gain: 0.04, decay: 6.2 },
];

const note = (at, midi, vel = 1, extra = {}) => ({ at, freq: hz(midi), vel, ...extra });

export const CANDIDATES = [
  {
    id: '01-felt-piano', name: '毡音钢琴 · 四个音往下走',
    trait: '木质、闷、像有人在隔壁房间随手弹了四下。最不像设备。',
    seconds: 3.2, partials: FELT, attack: 0.014,
    notes: [note(0.10, 72, 1), note(0.42, 67, 0.8), note(0.74, 64, 0.62), note(1.06, 60, 0.46)],
  },
  {
    id: '02-nylon-guitar', name: '尼龙弦吉他 · 慢慢往下拨',
    trait: '真实拨弦物理模型：越往后越暗，不是越往后越尖。最像「乐器」的一条。',
    seconds: 3.6,
    notes: [
      note(0.10, 76, 0.62, { voice: 'string', decay: 1.0, brightness: 0.32 }),
      note(0.40, 72, 0.72, { voice: 'string', decay: 1.1, brightness: 0.36 }),
      note(0.70, 69, 0.82, { voice: 'string', decay: 1.2, brightness: 0.4 }),
      note(1.00, 64, 0.9, { voice: 'string', decay: 1.5, brightness: 0.45 }),
      note(1.40, 57, 0.75, { voice: 'string', decay: 2.2, brightness: 0.3 }),
    ],
  },
  {
    id: '03-marimba', name: '马林巴 · 三音加一个低音落地',
    trait: '短、圆、有木框的嗡声。节奏感最强，适合不想被温柔对待、只想被叫醒一下的人。',
    seconds: 3.0, partials: MARIMBA, attack: 0.006,
    notes: [note(0.10, 79, 0.9), note(0.42, 76, 1), note(0.74, 72, 0.7), note(1.06, 57, 0.5)],
  },
  {
    id: '04-music-box', name: '八音盒 · 高把位往下掉',
    trait: '金属但很小，像玩具而不是广播。五个音一路弱下去。',
    seconds: 3.0, partials: BOX, attack: 0.004, beat: 0.004,
    notes: [note(0.10, 88, 1), note(0.40, 84, 0.85), note(0.70, 79, 0.7), note(1.00, 76, 0.55), note(1.30, 72, 0.4)],
  },
  {
    id: '05-kalimba', name: '拇指琴 · 弹一下停一下',
    trait: '带缓慢颤动（两个音高差 6‰ 拍频），听起来是活的、被吹气的金属片。',
    seconds: 3.4, partials: KALIMBA, attack: 0.008, beat: 0.006,
    notes: [note(0.10, 76, 1), note(0.34, 72, 0.8), note(0.58, 74, 0.75), note(0.92, 69, 0.55)],
  },
  {
    id: '06-singing-bowl', name: '颂钵 · 一个音加五度',
    trait: '最长的一条（4.2 秒），几乎不算旋律，只有缓慢起伏。最不着急。',
    seconds: 4.2, partials: BOWL, attack: 0.12, release: 0.6, beat: 0.009,
    notes: [note(0.05, 50, 1), note(0.35, 57, 0.5)],
  },
  {
    id: '07-hummed-third', name: '低吟 · 两音下行',
    trait: '带揉弦的正弦，像人闭着嘴「嗯——」两声。最不像提示音，最容易不被当成手机。',
    seconds: 3.2, partials: AIR, attack: 0.16, vibratoHz: 4.8, vibratoDepth: 0.008,
    notes: [note(0.10, 65, 1), note(1.10, 62, 0.8)],
  },
  {
    id: '08-rhodes-swell', name: '电钢琴 · 一个 Am7 轻扫再补一下',
    trait: '起音很慢（0.22 秒）的渐强，像有人把音量推上来。最柔、最不「叮」。',
    seconds: 4.0, partials: RHODES, attack: 0.22,
    notes: [
      note(0.08, 57, 0.2), note(0.08, 60, 0.22), note(0.08, 64, 0.26), note(0.08, 67, 0.3),
      note(1.75, 60, 0.14), note(1.75, 64, 0.16), note(1.75, 67, 0.18), note(1.75, 72, 0.2),
    ],
  },
  {
    id: '09-bamboo-flute', name: '竹笛 · 三个音往下收',
    trait: '持续揉弦的气声，没有打击感。东方一点，但不是古装剧那种。',
    seconds: 3.4, partials: AIR, attack: 0.09, vibratoHz: 5.6, vibratoDepth: 0.012,
    notes: [note(0.10, 79, 1), note(0.58, 76, 0.85), note(1.10, 72, 0.6)],
  },
  {
    id: '10-minor-chime', name: '小铃 · 小三度往下（对照组里最危险的一条）',
    trait: '金属泛音、有叮咚感。区别只在它往下走且是小三度。如果这条还是像车站，说明问题在「金属」而不在旋律。',
    seconds: 3.0, partials: CHIME, attack: 0.004,
    notes: [note(0.10, 84, 1), note(0.52, 79, 0.72)],
  },
  {
    id: '11-shipped-control', ship: false, name: '对照：现在正在用的这一条',
    trait: 'C5·A4·G4·E4 下行拨弦。放进来只做一件事——听清楚新的这些到底比它好在哪、或者不如在哪。',
    seconds: 3.2, partials: SHIPPED, attack: 0.012,
    notes: [note(0.10, 72, 1), note(0.42, 69, 0.86), note(0.74, 67, 0.74), note(1.12, 64, 0.66)],
  },
];

/**
 * The tone id a candidate ships under: `05-kalimba` → `kalimba`. The control row
 * opts out, because the sound it reproduces is already shipped as `classic`.
 * Checked against the table the UI actually renders, so a recipe can be added
 * here and silently not appear in the dropdown, or the other way round.
 */
const toneId = (candidate) => candidate.ship === false ? undefined : candidate.id.replace(/^\d+-/, '');

function player(candidates) {
  const rows = candidates.map((candidate, index) => `
      <li>
        <button type="button" data-src="${candidate.id}.wav" data-index="${index + 1}">▶</button>
        <div>
          <h2>${index + 1}. ${candidate.name}</h2>
          <p>${candidate.trait}</p>
          <p class="meta">${candidate.seconds} 秒 · <a href="${candidate.id}.wav">${candidate.id}.wav</a></p>
        </div>
      </li>`).join('');
  return `<!doctype html>
<meta charset="utf-8">
<title>铃声候选 · dsh-voice-call</title>
<style>
  body { margin:0 auto; padding:32px 20px 64px; max-width:720px; font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif; color:#1b1b1f; background:#fbfbfd; }
  h1 { font-size:20px; margin:0 0 6px; }
  .lede { color:#6b6b74; margin:0 0 20px; }
  .bar { display:flex; align-items:center; gap:8px; margin:0 0 20px; padding:10px 12px; border:1px solid #e3e3ea; border-radius:10px; background:#fff; }
  .bar label { display:flex; align-items:center; gap:6px; font-size:13px; color:#3c3c44; }
  ol { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
  li { display:flex; gap:12px; align-items:flex-start; padding:14px; border:1px solid #e3e3ea; border-radius:12px; background:#fff; }
  li[data-playing="1"] { border-color:#4a7cff; box-shadow:0 0 0 3px #4a7cff22; }
  button { flex:0 0 auto; width:40px; height:40px; border-radius:999px; border:1px solid #d7d7e0; background:#f3f3f8; color:#1b1b1f; font-size:15px; cursor:pointer; }
  button:hover { background:#e7ecff; border-color:#4a7cff; }
  h2 { font-size:15px; margin:0 0 2px; }
  p { margin:0; }
  .meta, li p:nth-of-type(2) { color:#55555e; font-size:13px; }
  li p:nth-of-type(2) { margin:0 0 4px; }
  .meta { color:#8b8b95; }
  a { color:#4a7cff; }
  @media (prefers-color-scheme: dark) {
    body { color:#e8e8ee; background:#17171b; }
    .bar, li { background:#1f1f26; border-color:#33333d; }
    button { background:#2a2a33; border-color:#3d3d48; color:#e8e8ee; }
    h2, .bar label { color:#e8e8ee; }
    li p:nth-of-type(2), .meta { color:#a0a0ac; }
  }
</style>
<h1>来电铃声候选 · 11 条</h1>
<p class="lede">每条都是本机脚本合成的，没有用任何第三方音频。11 条都混到同一个峰值（−3.3 dBFS），也就是同一份响度余量——最响的 300 ms 窗之间还差 5 dB 左右，那是渐强与敲击声的本性，要改得改配方而不是补一级增益。默认按卡片实际音量播（0.45），想听细节再勾「全音量」。建议每条连听两三遍再决定。</p>
<div class="bar">
  <label><input type="checkbox" id="loop"> 循环播放（一直响到再点一次）</label>
  <label><input type="checkbox" id="full"> 全音量（卡片上是 0.45，约小 7 dB）</label>
  <span style="margin-left:auto;font-size:13px;color:#8b8b95">按 <kbd>Esc</kbd> 停</span>
</div>
<ol>${rows}
</ol>
<script>
  // 0.45 is RINGTONE_VOLUME in src/client/ringtone.ts — the player gain the
  // call card really applies. Listening at file level would rate these against a
  // loudness no call ever has, and the sharp ones always win that contest.
  const CARD_VOLUME = 0.45;
  const audio = new Audio();
  audio.volume = CARD_VOLUME;
  let current = null;
  const loop = document.getElementById('loop');
  const full = document.getElementById('full');
  document.querySelectorAll('li button').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest('li');
      if (current === row) { audio.pause(); audio.currentTime = 0; row.dataset.playing = ''; current = null; return; }
      if (current) current.dataset.playing = '';
      current = row;
      audio.loop = loop.checked;
      audio.volume = full.checked ? 1 : CARD_VOLUME;
      audio.src = button.dataset.src;
      void audio.play().then(() => { row.dataset.playing = '1'; }, () => { row.dataset.playing = ''; });
    });
  });
  audio.addEventListener('ended', () => { if (current) { current.dataset.playing = ''; current = null; } });
  loop.addEventListener('change', () => { audio.loop = loop.checked; });
  addEventListener('keydown', (event) => { if (event.key === 'Escape') { audio.pause(); if (current) { current.dataset.playing = ''; current = null; } } });
</script>
`;
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'design', 'ringtones');
const shipped = join(here, '..', 'assets', 'ringtones');
await mkdir(target, { recursive: true });
await mkdir(shipped, { recursive: true });

const { TONES } = await import('../src/client/tones.ts');
const expected = TONES.filter((tone) => tone.file.startsWith('ringtones/')).map((tone) => tone.file.slice('ringtones/'.length, -'.wav'.length)).sort();
const produced = CANDIDATES.map(toneId).filter((id) => id !== undefined).sort();
if (JSON.stringify(expected) !== JSON.stringify(produced)) {
  throw new Error(`dropdown table and recipes disagree\n  tones.ts: ${expected.join(', ')}\n  recipes:  ${produced.join(', ')}`);
}

const lines = [];
for (const candidate of CANDIDATES) {
  const samples = render(candidate);
  const { buffer: file, peak } = encode(samples);
  await writeFile(join(target, `${candidate.id}.wav`), file);
  const id = toneId(candidate);
  if (id !== undefined) await writeFile(join(shipped, `${id}.wav`), file);
  const win = loudWindow(samples);
  lines.push([
    (id === undefined ? `${candidate.id}（对照，不入库）` : `${candidate.id} → ${id}`).padEnd(36),
    `${String(file.length).padStart(7)} B`,
    `${candidate.seconds}s`.padStart(5),
    `peak ${peak.toFixed(3)}=${dbfs(peak).toFixed(1)}`,
    `loud ${dbfs(win).toFixed(1)} dBFS`,
  ].join('  '));
}
await writeFile(join(target, 'index.html'), player(CANDIDATES));
console.log(lines.join('\n'));
console.log(`\n${produced.length} 条入库 assets/ringtones/，${CANDIDATES.length} 条试听文件 design/ringtones/（${SAMPLE_RATE} Hz mono 16-bit）`);
console.log(`每条峰值都顶到 ${dbfs(TARGET_PEAK).toFixed(1)} dBFS（同一个响度余量）；loud 列是最响 300 ms 窗，只是参考值，不做对齐`);
console.log('试听：design/ringtones/index.html（双击即可，本地文件，不联网）');
