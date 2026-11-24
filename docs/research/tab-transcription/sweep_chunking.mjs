// 錄音頁（extension/offscreen.js）切段規則的離線比較：把真的音檔一塊塊餵給 offscreen.js（同 tests/test_chunking.mjs 的假錄音元件），
// 看每段在什麼時候送出。不需要瀏覽器、模型和顯示卡。
//
// 比的規則：0.7.0 的「一段至少 6 秒，之後停頓 0.4 秒就切」，加上「停頓滿 X 秒就切，不管這段多長」（--pause 列出 X）。
// offscreen.js 已經改成第 18 節選的規則（停頓 0.6 秒、人聲 1 秒）也沒關係：會先換回 0.7.0 的條件再比。
// 量的東西（時間都是錄音的秒數，不含轉文字和傳訊息的時間）：
//   段數、段長中位數、不到 2 秒的段數、有聲音卻沒送出的段數（有聲音不到 0.3 秒，MIN_VOICED_BLOCKS）
//   每塊有聲音的 0.1 秒，從它錄到到它所在的那段送出要等多久（中位數、九成、最慢）：不需要知道句子在哪裡，連續朗讀也能比
//   有 --clips 時：每句講完到「含有句尾的那段」送出要等多久，和被切成幾段的句子數
//
// 用法：node docs/research/tab-transcription/sweep_chunking.mjs <16 kHz 單聲道 wav> [--clips 每句時間.json] [--pause 0.6,0.8,1.0]
//   --cpu-min 秒數：另外比「停頓滿 X 秒就切，但這段至少要有這麼長」（給只有 CPU 時用，CPU 每段有約 2 秒的固定成本）

import fs from 'node:fs';
import vm from 'node:vm';
import { parseArgs } from 'node:util';

const RATE = 16000;
const BLOCK = 1600;
const BLOCK_S = BLOCK / RATE;
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    clips: { type: 'string' },
    pause: { type: 'string', default: '0.6,0.8,1.0,1.5' },
    'cpu-min': { type: 'string' },
    voiced: { type: 'string', default: '0' }, // 停頓切的時候這段至少要有幾秒「有人聲」（逗號分開可以比好幾個）
    speech: { type: 'string' }, // 混了背景聲時，乾淨講話裡哪些 0.1 秒有講話（{"voiced": [0/1, …]}）：等待和送出比例改用這個算
    json: { type: 'boolean', default: false },
  },
});
const CUT = '} else if (n >= MIN_CHUNK_BLOCKS && c.silentRun >= GAP_BLOCKS) {';
const CUT_PAUSE = `} else if ((n >= MIN_CHUNK_BLOCKS && c.silentRun >= GAP_BLOCKS)
    || (c.silentRun >= PAUSE_BLOCKS && c.loud.filter(Boolean).length >= PAUSE_VOICED_BLOCKS)) {`;
const source = fs.readFileSync(new URL('../../../extension/offscreen.js', import.meta.url), 'utf8').replace(CUT_PAUSE, CUT);
if (!source.includes(CUT)) throw new Error('offscreen.js 的切段條件和這支程式預期的不一樣');

function readWav(file) {
  const buf = fs.readFileSync(file);
  let p = 12;
  while (p < buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'data') {
      const pcm = new Float32Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(p + 8 + i * 2) / 32768;
      return pcm;
    }
    p += 8 + size;
  }
  throw new Error(`${file} 找不到 data`);
}

// 規則：pause = 停頓滿這麼多秒就切（null 是現在的規則）；minS = 那樣切時這段至少要多長；voicedS = 這段至少要有幾秒有人聲
async function run(pcm, pause, minS = 0, voicedS = 0) {
  const patched = pause === null ? source : source.replace(CUT,
    `} else if ((n >= MIN_CHUNK_BLOCKS && c.silentRun >= GAP_BLOCKS) || (c.silentRun >= ${Math.round(pause / BLOCK_S)} && n >= ${Math.round(minS / BLOCK_S)}`
    + ` && c.loud.filter(Boolean).length >= ${Math.round(voicedS / BLOCK_S)})) {`);
  const sent = [];
  let listener, node, block = 0;
  const context = vm.createContext({
    btoa,
    console,
    chrome: { runtime: { onMessage: { addListener: (f) => (listener = f) }, sendMessage: async (m) => sent.push({ ...m, at: block }) } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [{ addEventListener() {} }] }) } },
    AudioContext: class {
      state = 'running';
      destination = {};
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() { return { connect() {} }; }
      async resume() {}
      close() {}
    },
    AudioWorkletNode: class {
      port = {};
      constructor() { node = this; }
      connect() {}
    },
  });
  vm.runInContext(patched, context);
  await new Promise((resolve) => listener({ target: 'offscreen', type: 'start', streamId: 'x' }, null, resolve));
  for (let i = 0; i + BLOCK <= pcm.length; i += BLOCK, block++) node.port.onmessage({ data: pcm.slice(i, i + BLOCK) });
  listener({ target: 'offscreen', type: 'stop' });
  const chunks = sent.filter((m) => m.type === 'chunk').map((m) => ({
    start: m.offset, end: m.offset + Buffer.from(m.pcm, 'base64').length / 2 / RATE, closed: (m.at + 1) * BLOCK_S,
  }));
  // 出現過即時字幕、卻因為有聲音不到 0.3 秒沒送去定稿的段落（收掉即時字幕的時間）
  const resets = sent.filter((m) => m.type === 'partial-reset').map((m) => (m.at + 1) * BLOCK_S);
  return { chunks, resets };
}

// 和 offscreen.js 一樣的「有人聲」判斷，只用來算每塊有聲音的地方要等多久（不影響切段）
function loudBlocks(pcm) {
  const out = [];
  let speech = 0.05;
  const recent = [];
  for (let i = 0, b = 0; i + BLOCK <= pcm.length; i += BLOCK, b++) {
    let sum = 0;
    for (let j = i; j < i + BLOCK; j++) sum += pcm[j] * pcm[j];
    const rms = Math.sqrt(sum / BLOCK);
    recent.push(rms);
    if (recent.length > 100) recent.shift();
    const floor = [...recent].sort((a, c) => a - c)[Math.floor(recent.length / 10)];
    const loud = rms > Math.max(0.003, speech * 0.12, floor * 1.5);
    if (loud) { speech = speech * 0.95 + rms * 0.05; out.push((b + 1) * BLOCK_S); }
  }
  return out;
}

const q = (xs, f) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
const fmt = (x) => (x === null ? '—' : x.toFixed(1));

const pcm = readWav(positionals[0]);
const clips = opt.clips ? JSON.parse(fs.readFileSync(opt.clips, 'utf8')).clips : null;
const ref = opt.speech ? JSON.parse(fs.readFileSync(opt.speech, 'utf8')).voiced : null;
const loud = ref ? ref.flatMap((v, b) => (v ? [(b + 1) * BLOCK_S] : [])) : loudBlocks(pcm);
const rules = [['0.7.0（至少 6 秒）', null, 0, 0]];
for (const v of opt.voiced.split(',').map(Number)) {
  for (const x of opt.pause.split(',')) rules.push([`停頓 ${x} 秒就切${v ? `（人聲 ≥ ${v} 秒）` : ''}`, Number(x), 0, v]);
}
if (opt['cpu-min']) for (const x of opt.pause.split(',')) rules.push([`停頓 ${x} 秒、至少 ${opt['cpu-min']} 秒`, Number(x), Number(opt['cpu-min']), 0]);

const rows = [];
for (const [label, pause, minS, voicedS] of rules) {
  const { chunks, resets } = await run(pcm, pause, minS, voicedS);
  const lengths = chunks.map((c) => c.end - c.start);
  // 每塊有聲音的地方，到它所在那段送出要等多久
  const waits = loud.map((t) => chunks.find((c) => c.start < t && t <= c.end + 1e-6)).map((c, i) => (c ? c.closed - loud[i] : null))
    .filter((x) => x !== null);
  const row = { label, chunks: chunks.length, median_len: q(lengths, 0.5), short: lengths.filter((x) => x < 2).length, dropped: resets.length,
    sent: waits.length / loud.length,
    wait_median: q(waits, 0.5), wait_p90: q(waits, 0.9), wait_max: q(waits, 1) };
  if (clips) {
    const endWait = clips.map((s) => chunks.find((c) => c.start <= s.end && s.end <= c.end + 0.05)).map((c, i) => (c ? c.closed - clips[i].end : null));
    const split = clips.filter((s) => chunks.filter((c) => c.start < s.end && c.end > s.start).length > 1).length;
    // 沒送出的段落在句子裡面（講話開始到結束之間）的有幾個：那是被丟掉的講話，不是停頓時的雜音
    row.dropped_in_speech = resets.filter((t) => clips.some((s) => s.start < t - 0.4 && t - 0.4 < s.end)).length;
    Object.assign(row, { end_median: q(endWait.filter((x) => x !== null), 0.5), end_max: q(endWait.filter((x) => x !== null), 1),
      end_over3: endWait.filter((x) => x !== null && x > 3).length, end_missing: endWait.filter((x) => x === null).length, split });
  }
  rows.push(row);
}
if (opt.json) {
  console.log(JSON.stringify(rows));
} else {
  console.log(`${positionals[0]}（${(pcm.length / RATE).toFixed(0)} 秒）`);
  console.log('| 規則 | 段數 | 段長中位數 | 不到 2 秒 | 沒送出 | 送出的人聲 | 等待中位數 | 九成 | 最慢 |' + (clips ? ' 句尾等待中位數 | 最慢 | 超過 3 秒 | 被切開的句子 | 沒送出在句子裡 |' : ''));
  for (const r of rows) {
    console.log(`| ${r.label} | ${r.chunks} | ${fmt(r.median_len)} | ${r.short} | ${r.dropped} | ${(r.sent * 100).toFixed(0)}% | ${fmt(r.wait_median)} | ${fmt(r.wait_p90)} | ${fmt(r.wait_max)} |`
      + (clips ? ` ${fmt(r.end_median)} | ${fmt(r.end_max)} | ${r.end_over3} | ${r.split} | ${r.dropped_in_speech} |` : ''));
  }
}
