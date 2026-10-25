// 分頁錄音遇到換頁會怎樣：錄音軌會不會結束、聲音有沒有跟著新頁面、還能不能把字幕框注入分頁、要不要再點圖示。
// 每個測試頁播不同音量的正弦波（/p1 0.004、/p2 0.008、/p3 0.012，RMS 約 0.0028、0.0057、0.0085），看量到的音量就知道聲音來自哪一頁。
// 127.0.0.1 和 localhost 是不同網站（origin）。
//
// 用法：node docs/research/tab-transcription/nav_probe.mjs [--all-urls]
//   --all-urls  插件另外要所有網站的權限（host_permissions <all_urls>），比較注入和錄音的差別

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const allUrls = process.argv.includes('--all-urls');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAIN = { '/p1': 0.004, '/p2': 0.008, '/p3': 0.012 };
const server = http.createServer((req, res) => {
  const page = new URL(req.url, 'http://x').pathname;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${page}</title><script>
    const c = new AudioContext(), o = c.createOscillator(), g = c.createGain();
    g.gain.value = ${GAIN[page] ?? 0.002}; o.connect(g).connect(c.destination); o.start(); c.resume();
  </script>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const A = `http://127.0.0.1:${port}`;
const B = `http://localhost:${port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-probe-'));
const ext = path.join(tmp, 'ext');
fs.cpSync(path.join(HERE, 'nav_probe'), ext, { recursive: true });
if (allUrls) {
  const m = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ ...m, host_permissions: ['<all_urls>'] }));
}
const profile = path.join(tmp, 'profile');
const browser = spawn(
  'brave-browser',
  ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'],
  { stdio: 'ignore', detached: true },
);

try {
  let wsPath;
  for (let i = 0; i < 100 && !wsPath; i++) {
    await sleep(200);
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) {
      const [p, w] = fs.readFileSync(f, 'utf8').split('\n');
      if (w) wsPath = `ws://127.0.0.1:${p}${w}`;
    }
  }
  const ws = new WebSocket(wsPath);
  await new Promise((r) => (ws.onopen = r));
  let nextId = 1;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  };
  const cdp = async (method, params = {}, sessionId) => {
    const m = await new Promise((r) => {
      const id = nextId++;
      waiting.set(id, r);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    if (m.error) throw new Error(`${method}: ${m.error.message}`);
    return m.result;
  };
  const evaluate = async (sessionId, expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  const { id } = await cdp('Extensions.loadUnpacked', { path: ext });
  async function open(url) {
    const { targetId } = await cdp('Target.createTarget', { url });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await sleep(1500);
    const { targetInfos } = await cdp('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = targetInfos.find((t) => t.type === 'tab' && t.url === url);
    return { targetId, sessionId, tab };
  }
  async function click(t) {
    await cdp('Target.activateTarget', { targetId: t.targetId });
    await cdp('Extensions.triggerAction', { id, targetId: t.tab.targetId });
    await sleep(1500);
  }
  const navigate = async (t, url) => {
    await cdp('Page.navigate', { url }, t.sessionId);
    await sleep(1500);
  };

  console.log(allUrls ? '插件權限：activeTab＋所有網站' : '插件權限：activeTab');
  const t1 = await open(`${A}/p1`);
  await click(t1);
  const sw = (await cdp('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
  const { sessionId: bg } = await cdp('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const report = async (label) => {
    await evaluate(bg, 'probe()'); // 清掉之前量到的最大音量
    await sleep(2500);
    console.log(label.padEnd(36), JSON.stringify(await evaluate(bg, 'probe()')));
  };

  console.log('\n錄音中，同一個分頁換頁：');
  await report('點圖示開始錄 /p1');
  await evaluate(t1.sessionId, `history.pushState({}, '', '/next'); true`);
  await report('同一頁內換網址（像 YouTube 換影片）');
  await evaluate(t1.sessionId, `location.href = '/p2'; true`);
  await sleep(1500);
  await report('同網站換頁 /p2');
  await navigate(t1, `${B}/p1`);
  await report('換網站 localhost/p1');
  await navigate(t1, `${A}/p3`);
  await report('換回原本的網站 /p3');
  await evaluate(t1.sessionId, `history.back(); true`);
  await sleep(1500);
  await report('按上一頁');
  await navigate(t1, 'chrome://version');
  await report('瀏覽器內部頁面');
  await navigate(t1, `${A}/p2`);
  await report('再回到網頁 /p2');

  console.log('\n錄音中，另一個分頁：');
  const t2 = await open(`${A}/other`);
  await cdp('Target.activateTarget', { targetId: t2.targetId });
  const other = await evaluate(bg, 'activeTab()');
  console.log('沒點圖示就錄'.padEnd(36), await evaluate(bg, `capture(${other})`));
  await click(t2);
  console.log('在那個分頁點圖示之後'.padEnd(36), await evaluate(bg, `capture(${other})`));

  console.log('\n點過圖示的分頁換頁後，還能不能開始錄（等於按側邊欄的「開始」）：');
  await navigate(t2, `${A}/p2`);
  console.log('同網站換頁之後'.padEnd(36), await evaluate(bg, `capture(${other})`));
  await navigate(t2, `${B}/p2`);
  console.log('換網站之後'.padEnd(36), await evaluate(bg, `capture(${other})`));
  await navigate(t2, `${A}/p3`);
  console.log('換回原本的網站'.padEnd(36), await evaluate(bg, `capture(${other})`));
  await cdp('Browser.close').catch(() => {});
} finally {
  await sleep(500);
  try {
    process.kill(-browser.pid, 'SIGKILL');
  } catch {}
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
