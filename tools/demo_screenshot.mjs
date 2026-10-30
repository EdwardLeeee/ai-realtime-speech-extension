// README 開頭的使用畫面（docs/images/demo.png）：用暫時的 Brave 設定檔載入插件，在本機網頁播影片，
// 實際錄音轉文字、翻譯，錄到指定那一句出現後，把網頁（影片＋網頁字幕）和側邊欄的截圖左右拼成一張。
// 會用到 Whisper 和翻譯模型（有顯示卡就用顯示卡），要先執行過 ./install.sh。拼圖用 python3 的 Pillow。
//
// 用法：node tools/demo_screenshot.mjs --video <影片> [--start 34] [--until "talking last night"]
//                                       [--hints "Thom, Celia, Barley"] [--out docs/images/demo.png]
// 現在這張：Tears of Steel（Blender Foundation，CC BY 3.0）720p，從第 34 秒錄到「I heard you guys talking last night.」
//   https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXPECTED_ID = 'pclblnfmncjbohcnbhlkgefpdhpljiae';
const PAGE = { width: 863, height: 840 };
const PANEL = { width: 420, height: 840 }; // 側邊欄要放得下錄音標題到最後一句

const { values: opt } = parseArgs({
  options: {
    video: { type: 'string' },
    start: { type: 'string', default: '34' },
    until: { type: 'string', default: 'talking last night' },
    hints: { type: 'string', default: 'Thom, Celia, Barley' },
    out: { type: 'string', default: path.join(ROOT, 'docs', 'images', 'demo.png') },
    timeout: { type: 'string', default: '240' },
  },
});
if (!opt.video) throw new Error('需要 --video <影片>');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 網頁＋影片（支援 Range，影片才能跳到指定秒數）----
const videoSize = fs.statSync(opt.video).size;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/video')) {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const from = range ? Number(range[1]) : 0;
    const to = range && range[2] ? Number(range[2]) : videoSize - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': to - from + 1,
      ...(range ? { 'Content-Range': `bytes ${from}-${to}/${videoSize}` } : {}),
    });
    fs.createReadStream(opt.video, { start: from, end: to }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Tears of Steel</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain}</style>
<video id="v" preload="auto" src="/video#t=${Number(opt.start)}"></video>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// ---- 瀏覽器（和 tests/e2e.mjs 一樣：暫時設定檔，結束時整組收掉）----
// --disable-audio-output：影片的聲音不從喇叭出來（插件照樣錄得到分頁的聲音）
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-demo-'));
const browser = spawn('brave-browser', ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--disable-audio-output', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', detached: true });
const portFile = path.join(profile, 'DevToolsActivePort');
let wsPath = null;
for (let i = 0; i < 100 && !wsPath; i++) {
  await sleep(200);
  if (fs.existsSync(portFile)) {
    const [port, p] = fs.readFileSync(portFile, 'utf8').split('\n');
    if (p) wsPath = `ws://127.0.0.1:${port}${p}`;
  }
}
if (!wsPath) throw new Error('瀏覽器沒有開出除錯埠');
const ws = new WebSocket(wsPath);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let nextId = 1;
const waiting = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (!msg.id || !waiting.has(msg.id)) return;
  const { resolve, reject } = waiting.get(msg.id);
  waiting.delete(msg.id);
  msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : resolve(msg.result);
};
// 每個呼叫最多等 15 秒：分頁卡住時要能走到 finally 收掉瀏覽器，不要整支程式掛著
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} 15 秒沒有回應`)); }, 15000);
  waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (sessionId, expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const openTab = async (url, size) => {
  const { targetId } = await cdp('Target.createTarget', { url });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  await cdp('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false }, sessionId);
  return { targetId, sessionId };
};
const shot = async (sessionId, file) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
};
function profileProcesses() {
  const pids = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').includes(`--user-data-dir=${profile}`)) pids.push(Number(d));
    } catch {}
  }
  return pids;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-demo-shots-'));
let ok = false;
try {
  const { id } = await cdp('Extensions.loadUnpacked', { path: path.join(ROOT, 'extension') });
  if (id !== EXPECTED_ID) throw new Error(`插件 ID 不對：${id}`);
  const page = await openTab(pageUrl, PAGE);
  const panel = await openTab(`chrome-extension://${id}/sidepanel.html`, PANEL);
  await evaluate(panel.sessionId, `chrome.storage.local.set({ language: 'en', bilingual: true, overlay: true, ytCaptions: false,
    hints: { en: ${JSON.stringify(opt.hints)} } })`);
  await cdp('Page.reload', {}, panel.sessionId); // 讓側邊欄照新設定畫
  await evaluate(page.sessionId, `document.getElementById('v').play().catch(() => {}), true`);
  const playing = async () => evaluate(page.sessionId, `(v => !v.paused && v.currentTime > ${Number(opt.start)})(document.getElementById('v'))`);
  for (let t = 0; t < 20000 && !(await playing()); t += 500) await sleep(500);
  if (!(await playing())) throw new Error('影片沒有開始播放');
  log('影片在播放');
  const { targetInfos } = await cdp('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.type === 'tab' && t.url === pageUrl);
  await cdp('Target.activateTarget', { targetId: page.targetId });
  await cdp('Extensions.triggerAction', { id, targetId: tab.targetId });
  log('已點插件圖示，等「' + opt.until + '」定稿並翻好');

  // 那一句定稿、有譯文，網頁字幕也換到它
  const ready = () => evaluate(page.sessionId, `(() => {
    const live = document.querySelector('tab-transcriber-caption')?.shadowRoot.querySelector('.line:last-child');
    return Boolean(live?.querySelector('.tr')?.textContent) && live.firstChild.textContent.includes(${JSON.stringify(opt.until)});
  })()`).then(async (onPage) => onPage && evaluate(panel.sessionId, `[...document.querySelectorAll('.line:not(.live)')]
    .some((l) => l.querySelector('.src')?.textContent.includes(${JSON.stringify(opt.until)}) && l.querySelector('.tr')?.textContent)`));
  for (let t = 0; t < Number(opt.timeout) * 1000 && !(await ready()); t += 1000) await sleep(1000);
  if (!(await ready())) throw new Error(`${opt.timeout} 秒內沒等到「${opt.until}」`);
  await evaluate(page.sessionId, `document.getElementById('v').pause()`);
  await evaluate(panel.sessionId, `document.getElementById('transcript').scrollTop = 0, document.scrollingElement.scrollTop = 0`);
  await sleep(800);
  const pageFile = path.join(work, 'page.png');
  const panelFile = path.join(work, 'panel.png');
  await cdp('Target.activateTarget', { targetId: page.targetId });
  await shot(page.sessionId, pageFile);
  await shot(panel.sessionId, panelFile);
  await evaluate(panel.sessionId, `document.getElementById('toggle').click()`);
  await sleep(2000);

  const py = spawnSync('python3', ['-I', '-c', `
import sys
from PIL import Image
page, panel = Image.open(sys.argv[1]).convert('RGB'), Image.open(sys.argv[2]).convert('RGB')
out = Image.new('RGB', (page.width + panel.width, max(page.height, panel.height)), 'white')
out.paste(page, (0, 0)); out.paste(panel, (page.width, 0))
out.save(sys.argv[3], optimize=True)
`, pageFile, panelFile, opt.out], { encoding: 'utf8' });
  if (py.status !== 0) throw new Error(`拼圖失敗：${py.stderr}`);
  log('已存：', opt.out);
  ok = true;
} catch (err) {
  log('ERROR', err.message);
} finally {
  await cdp('Browser.close').catch(() => {});
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    for (let i = 0; i < 25 && profileProcesses().length; i++) await sleep(200);
    try { process.kill(-browser.pid, sig); } catch {}
    for (const pid of profileProcesses()) try { process.kill(pid, sig); } catch {}
  }
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
