// 錄音頁（extension/offscreen.js）在哪裡切段的單元測試：用假的錄音元件把合成的聲音一塊塊餵進去（不需要瀏覽器和模型）。
// 「講話」是一串 0.15 秒的雜訊音節，每句 1.5–4 秒，句子之間停 0.5–1 秒；背景是一直存在的雜訊。
// 用法：node tests/test_chunking.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const RATE = 16000;
const BLOCK = 1600;
const source = fs.readFileSync(new URL('../extension/offscreen.js', import.meta.url), 'utf8');

let seed = 1;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());

// 回傳整段聲音和每句講話的 [開始, 結束] 秒數
function speech(seconds) {
  const pcm = new Float32Array(seconds * RATE);
  const phrases = [];
  let t = 0.5;
  while (t < seconds - 5) {
    const end = t + 1.5 + random() * 2.5;
    phrases.push([t, end]);
    for (; t < end; t += 0.2) {
      const start = Math.floor(t * RATE), n = Math.floor(0.15 * RATE);
      for (let i = 0; i < n; i++) pcm[start + i] = 0.14 * Math.sin((Math.PI * i) / n) * gauss();
    }
    t = end + 0.5 + random() * 0.5;
  }
  return { pcm, phrases };
}

function rms(x) {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / x.length);
}

// 背景雜訊比講話小 snr dB（負數表示比講話大）
function withNoise({ pcm, phrases }, snr) {
  const level = rms(pcm) / 10 ** (snr / 20);
  return { pcm: pcm.map((v) => v + level * gauss()), phrases };
}

async function run(pcm) {
  const sent = [];
  let listener, node;
  const context = vm.createContext({
    btoa,
    console,
    chrome: { runtime: { onMessage: { addListener: (f) => (listener = f) }, sendMessage: async (m) => sent.push(m) } },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [{ addEventListener() {} }] }),
      },
    },
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
  vm.runInContext(source, context);
  await new Promise((resolve) => listener({ target: 'offscreen', type: 'start', streamId: 'x' }, null, resolve));
  for (let i = 0; i + BLOCK <= pcm.length; i += BLOCK) node.port.onmessage({ data: pcm.slice(i, i + BLOCK) });
  listener({ target: 'offscreen', type: 'stop' });
  return sent
    .filter((m) => m.type === 'chunk')
    .map((m) => [m.offset, m.offset + Buffer.from(m.pcm, 'base64').length / 2 / RATE]);
}

let failed = 0;
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const clean = speech(120);
for (const [label, audio] of [
  ['沒有背景聲', clean],
  ['背景聲比講話小 10 dB', withNoise(clean, 10)],
  ['背景聲和講話一樣大', withNoise(clean, 0)],
]) {
  const chunks = await run(audio.pcm);
  const lengths = chunks.map(([a, b]) => b - a);
  // 每句講話的中點都要落在某一段送出的聲音裡
  const covered = audio.phrases.filter(([a, b]) => chunks.some(([s, e]) => s <= (a + b) / 2 && (a + b) / 2 <= e)).length;
  console.log(`${label}：${chunks.length} 段，中位數 ${median(lengths).toFixed(1)} 秒，最長 ${Math.max(...lengths).toFixed(1)} 秒，` +
    `送出 ${covered}/${audio.phrases.length} 句`);
  check(median(lengths) < 12, `${label}：在句子停頓處切段，不會每段都拖到最長 25 秒`);
  check(covered === audio.phrases.length, `${label}：每句都有送去轉文字`);
}
if (failed) {
  console.log(`${failed} 項失敗`);
  process.exit(1);
}
console.log('全部通過');
