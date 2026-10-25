// 端到端測試：用暫時的 Brave 設定檔載入插件，在測試網頁播錄音，模擬點插件圖示，最後檢查文字稿與雙語字幕。
//
// 先執行過 ./install.sh：Brave 只到預設設定資料夾（~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts）
// 找本機程式的註冊檔，就算用 --user-data-dir 換了設定檔也一樣（2026-10 在 Brave 155 實測）。
//
// 用法：node tests/e2e.mjs --audio <音檔> [--start 60] [--duration 75] [--profile <暫存資料夾>]
//                          [--lang en|ja|th] [--bilingual off|on|toggle] [--browser brave-browser] [--headful] [--shots <截圖資料夾>]
//   --bilingual on      一開始就打開雙語字幕，檢查每組句子的譯文、即時字幕的譯文，停止後翻譯模型要結束
//   --bilingual toggle  錄到三分之一時打開、三分之二時關掉，檢查翻譯模型會啟動、關掉後會結束

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXPECTED_ID = 'pclblnfmncjbohcnbhlkgefpdhpljiae';

const { values: opt } = parseArgs({
  options: {
    audio: { type: 'string' },
    start: { type: 'string', default: '60' },
    duration: { type: 'string', default: '75' },
    profile: { type: 'string' },
    browser: { type: 'string', default: 'brave-browser' },
    headful: { type: 'boolean', default: false },
    shots: { type: 'string' },
    lang: { type: 'string', default: 'en' },
    bilingual: { type: 'string', default: 'off' },
  },
});
if (!opt.audio) throw new Error('需要 --audio <音檔>');
const start = Number(opt.start);
const duration = Number(opt.duration);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 測試網頁＋音檔（支援 Range，讓 <audio> 能跳到指定秒數）----
const audioBytes = fs.readFileSync(opt.audio);
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/audio')) {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const total = audioBytes.length;
    const from = range ? Number(range[1]) : 0;
    const to = range && range[2] ? Number(range[2]) : total - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Content-Length': to - from + 1,
      ...(range ? { 'Content-Range': `bytes ${from}-${to}/${total}` } : {}),
    });
    res.end(audioBytes.subarray(from, to + 1));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>English Listening Practice</title>
<h1>Listening</h1><audio id="a" controls preload="auto" src="/audio#t=${start},${start + duration}"></audio>
<div id="player" draggable="true" style="width:480px;height:270px;background:#234"></div>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// ---- 暫時的瀏覽器設定檔 ----
const profile = opt.profile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tt-e2e-'));
fs.mkdirSync(profile, { recursive: true });

const browser = spawn(
  opt.browser,
  [
    ...(opt.headful ? [] : ['--headless=new']),
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  // 自成一個 process group，結束時才能整組收掉（見 shutdownBrowser）。
  { stdio: 'ignore', detached: true },
);
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

// ---- 最小的 CDP 用戶端 ----
const ws = new WebSocket(wsPath);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let nextId = 1;
const waiting = new Map();
const listeners = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : resolve(msg.result);
  } else if (msg.method) {
    listeners.forEach((fn) => fn(msg));
  }
};
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

// 把插件各頁（背景程式、錄音頁、側邊欄）的 console 和錯誤印出來，方便除錯。
const sessionNames = new Map();
listeners.push((msg) => {
  const name = sessionNames.get(msg.sessionId);
  if (!name) return;
  if (msg.method === 'Runtime.consoleAPICalled') {
    log(`  <${name}> console.${msg.params.type}:`, msg.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    log(`  <${name}> EXCEPTION:`, msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
});
listeners.push(async (msg) => {
  if (msg.method !== 'Target.attachedToTarget') return;
  const { sessionId, targetInfo } = msg.params;
  if (!targetInfo.url.startsWith(`chrome-extension://${EXPECTED_ID}/`)) {
    cdp('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    return;
  }
  sessionNames.set(sessionId, path.basename(new URL(targetInfo.url).pathname));
  await cdp('Runtime.enable', {}, sessionId).catch(() => {});
  cdp('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
});
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await cdp('Target.setDiscoverTargets', { discover: true });
listeners.push((msg) => {
  if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.url.startsWith(`chrome-extension://${EXPECTED_ID}/`)) {
    cdp('Target.attachToTarget', { targetId: msg.params.targetInfo.targetId, flatten: true }).catch(() => {});
  }
});

async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function openTab(url) {
  const { targetId } = await cdp('Target.createTarget', { url });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  for (let i = 0; i < 50; i++) {
    const ready = await evaluate(sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`).catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  return { targetId, sessionId };
}

// brave-browser、google-chrome 是 shell 腳本，啟動瀏覽器時沒有 exec：只 kill 腳本的 PID，瀏覽器會留在背景繼續吃記憶體
// （2026-10-24 因此殘留 6 個 headless Brave、約 3 GB，最後整台電腦記憶體耗盡）。
// 所以先用 Browser.close 請瀏覽器自己關，再收掉整個 process group，最後逐一確認沒有程序還帶著這個設定檔。
function profileProcesses() {
  const pids = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    if (Number(d) === process.pid) continue;
    try {
      const args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      if (args.includes(`--user-data-dir=${profile}`)) pids.push(Number(d));
    } catch {}
  }
  return pids;
}
async function shutdownBrowser() {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    for (let i = 0; i < 25 && profileProcesses().length; i++) await sleep(200);
    if (!profileProcesses().length) return [];
    try {
      process.kill(-browser.pid, sig);
    } catch {}
    for (const pid of profileProcesses()) {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  }
  await sleep(500);
  return profileProcesses();
}

// 本機程式和它啟動的翻譯模型（llama-server）：瀏覽器關掉後都要跟著結束。
// 測試開始前就在跑的（使用者自己的瀏覽器正在錄音）不算。
const preexisting = new Set();
function hostProcesses() {
  const found = { host: [], llama: [] };
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || preexisting.has(Number(d))) continue;
    try {
      const args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      if (args.some((a) => a.endsWith('/host/transcriber_host.py'))) found.host.push(Number(d));
      if (args[0]?.endsWith('/host/vendor/llama.cpp/llama-server')) found.llama.push(Number(d));
    } catch {}
  }
  return found;
}
for (const pid of Object.values(hostProcesses()).flat()) preexisting.add(pid);
async function waitFor(fn, ms) {
  for (let t = 0; t < ms; t += 250) {
    if (fn()) return true;
    await sleep(250);
  }
  return fn();
}

let failed = false;
const check = (ok, label) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed = true;
};

try {
  const { id } = await cdp('Extensions.loadUnpacked', { path: path.join(ROOT, 'extension') });
  check(id === EXPECTED_ID, `插件載入，ID = ${id}`);

  const page = await openTab(pageUrl);
  await sleep(1500);
  const played = await evaluate(page.sessionId, `document.getElementById('a').play().then(() => 'playing', (e) => e.message)`);
  log('測試網頁播放：', played);

  // triggerAction 要的是包住頁面的 tab target，用網址對回去。
  const { targetInfos } = await cdp('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tabTarget = targetInfos.find((t) => t.type === 'tab' && t.url === pageUrl);
  if (!tabTarget) throw new Error('找不到測試網頁的 tab target');
  // 側邊欄頁面先開好，在裡面設定語言（等於使用者在選單選了語言）。
  const panel = await openTab(`chrome-extension://${id}/sidepanel.html`);
  await evaluate(
    panel.sessionId,
    `chrome.storage.local.set({ language: ${JSON.stringify(opt.lang)}, bilingual: ${opt.bilingual === 'on'} })`,
  );
  // 記錄即時字幕每次變化、第一句定稿出現的時間（相對於點圖示）。
  await evaluate(
    panel.sessionId,
    `(() => {
      window.__captions = [];
      window.__trCaptions = [];
      window.__firstFinal = null;
      new MutationObserver(() => {
        const text = document.querySelector('.line.live .src')?.textContent;
        const last = window.__captions.at(-1);
        if (text && text !== last?.text) window.__captions.push({ t: performance.now(), text });
        const tr = document.querySelector('.line.live .tr')?.textContent;
        if (tr && tr !== window.__trCaptions.at(-1)?.text) window.__trCaptions.push({ t: performance.now(), text: tr });
        if (!window.__firstFinal && document.querySelector('.line:not(.live)')) window.__firstFinal = performance.now();
      }).observe(document.getElementById('transcript'), { childList: true, subtree: true, characterData: true });
    })()`,
  );
  // triggerAction 實際作用在視窗目前顯示的分頁，所以先切回測試網頁。
  await cdp('Target.activateTarget', { targetId: page.targetId });
  await cdp('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
  await evaluate(panel.sessionId, `window.__t0 = performance.now()`);
  log('已模擬點擊插件圖示');
  const getState = () =>
    evaluate(
      panel.sessionId,
      `Promise.all([chrome.storage.session.get('state'), chrome.storage.local.get('recordings')])
        .then(([s, l]) => ({ state: s.state ?? {}, recordings: l.recordings ?? [] }))`,
    );

  const until = async (fn, ms = 5000) => {
    for (let t = 0; t < ms; t += 200) {
      const v = await fn();
      if (v) return v;
      await sleep(200);
    }
    return fn();
  };
  const attach = async (targetId) => {
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    return sessionId;
  };
  const screenshot = async (sessionId, name) => {
    if (!opt.shots) return;
    fs.mkdirSync(opt.shots, { recursive: true });
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(opt.shots, name), Buffer.from(data, 'base64'));
  };

  // 側邊欄上面的按鈕，在點圖示時真的打開的那個側邊欄上按（上面那個側邊欄分頁只是方便讀狀態）：
  // A+、收起後錄音繼續、再點圖示側邊欄回來而且不會重新開始。
  async function checkPanelButtons(recId) {
    const sidePanel = async () =>
      (await cdp('Target.getTargets')).targetInfos.find(
        (t) => t.url === `chrome-extension://${id}/sidepanel.html` && t.targetId !== panel.targetId,
      );
    const fontSize = (sid) => evaluate(sid, `getComputedStyle(document.getElementById('transcript')).fontSize`);
    const click = (sid, button) => evaluate(sid, `document.getElementById('${button}').click()`);

    const sp = await attach((await sidePanel()).targetId);
    const before = await fontSize(sp);
    await click(sp, 'bigger');
    await sleep(300);
    const after = await fontSize(sp);
    check(parseFloat(after) > parseFloat(before), `按 A+ 字變大（${before} → ${after}）`);
    await click(sp, 'smaller');

    await click(sp, 'collapse');
    check(await until(async () => !(await sidePanel())), '按「收起」側邊欄關掉');
    await sleep(1000);
    check((await getState()).state.status === 'recording', '收起後還在錄音');
    await cdp('Target.activateTarget', { targetId: page.targetId });
    await cdp('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
    check(Boolean(await until(sidePanel)) && (await getState()).state.recId === recId, '再點圖示側邊欄回來，還是同一次錄音');
  }

  // 網頁字幕（caption-overlay.js）：在測試網頁上浮著、有字；拖得動、點擊不會傳到網頁（YouTube 點一下會暫停）；
  // 全螢幕時搬進全螢幕的元素而且在最上面；按 × 會拿掉並關掉側邊欄的開關；再打開開關又出現。
  async function checkOverlay() {
    const ps = page.sessionId;
    await cdp('Target.activateTarget', { targetId: page.targetId });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, ps);
    const info = () =>
      evaluate(
        ps,
        `(() => {
          const host = document.querySelector('tab-transcriber-caption');
          if (!host) return null;
          const r = host.shadowRoot.querySelector('.box').getBoundingClientRect();
          const c = host.shadowRoot.querySelector('.close').getBoundingClientRect();
          const g = host.shadowRoot.querySelector('.resize').getBoundingClientRect();
          return {
            open: host.matches(':popover-open'),
            parent: host.parentNode.id || host.parentNode.tagName,
            top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === host,
            text: host.shadowRoot.querySelector('.line')?.textContent ?? '',
            tr: host.shadowRoot.querySelector('.tr')?.textContent ?? '',
            cx: r.left + r.width / 2, cy: r.top + r.height / 2, bottom: r.bottom,
            close: [c.left + c.width / 2, c.top + c.height / 2],
            grip: [g.left + g.width / 2, g.top + g.height / 2],
            left: r.left, top: r.top, w: r.width, h: r.height,
            sized: host.shadowRoot.querySelector('.box').classList.contains('sized'),
          };
        })()`,
      );
    const mouse = (type, x, y, clickCount = 1) =>
      cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount }, ps);

    const shown = await until(async () => {
      const i = await info();
      return i?.open && i.text ? i : null;
    }, 10000);
    check(Boolean(shown?.top), `網頁上有浮動字幕（${shown?.text.slice(0, 40) ?? '沒有'}）`);
    if (!shown) return;
    await screenshot(ps, 'page-overlay.png');

    await evaluate(ps, `window.__clicks = 0; document.addEventListener('click', () => window.__clicks++)`);
    await mouse('mousePressed', shown.cx, shown.cy);
    await mouse('mouseReleased', shown.cx, shown.cy);
    await mouse('mousePressed', shown.cx, shown.cy);
    for (let i = 1; i <= 5; i++) await mouse('mouseMoved', shown.cx - 30 * i, shown.cy - 25 * i);
    await mouse('mouseReleased', shown.cx - 150, shown.cy - 125);
    await sleep(300);
    const moved = await info();
    const saved = (await evaluate(panel.sessionId, `chrome.storage.local.get('overlayPos')`)).overlayPos;
    const clicks = await evaluate(ps, `window.__clicks`);
    const dx = moved.cx - shown.cx;
    const dy = moved.bottom - shown.bottom;
    check(
      Math.abs(dx + 150) < 3 && Math.abs(dy + 125) < 3 && Boolean(saved) && clicks === 0,
      `拖得動、位置有存、點擊沒有傳到網頁（移動 ${dx.toFixed(0)}, ${dy.toFixed(0)}；網頁收到 ${clicks} 次點擊）`,
    );

    // 拖右下角改大小：寬高跟著滑鼠變、左上角不動；按兩下恢復自動大小
    const resizeBy = async (dx, dy) => {
      const from = await info();
      await mouse('mousePressed', ...from.grip);
      for (let i = 1; i <= 5; i++) await mouse('mouseMoved', from.grip[0] + (dx * i) / 5, from.grip[1] + (dy * i) / 5);
      await mouse('mouseReleased', from.grip[0] + dx, from.grip[1] + dy);
      await sleep(300);
      const to = await info();
      const ok = to.sized && Math.abs(to.w - from.w - dx) < 3 && Math.abs(to.h - from.h - dy) < 3 &&
        Math.abs(to.left - from.left) < 3 && Math.abs(to.top - from.top) < 3;
      return { from, to, ok };
    };
    const resetSize = async () => {
      const { grip } = await info();
      await mouse('mousePressed', ...grip);
      await mouse('mouseReleased', ...grip);
      await mouse('mousePressed', ...grip, 2);
      await mouse('mouseReleased', ...grip, 2);
      await sleep(300);
    };
    const { from: small, to: big, ok: resized } = await resizeBy(200, 80);
    const size = (await evaluate(panel.sessionId, `chrome.storage.local.get('overlaySize')`)).overlaySize;
    check(
      resized && Boolean(size),
      `拖右下角可以改寬高，大小有存（寬 ${small.w.toFixed(0)}→${big.w.toFixed(0)}，高 ${small.h.toFixed(0)}→${big.h.toFixed(0)}）`,
    );
    await screenshot(ps, 'page-overlay-resized.png');
    await resetSize();
    const reset = await info();
    const cleared = !(await evaluate(panel.sessionId, `chrome.storage.local.get('overlaySize')`)).overlaySize;
    check(!reset.sized && reset.h < big.h - 40 && cleared && (await evaluate(ps, `window.__clicks`)) === 0,
      `右下角按兩下恢復自動大小（高 ${reset.h.toFixed(0)}）`);

    await evaluate(ps, `document.getElementById('player').requestFullscreen()`);
    const full = await until(async () => {
      const i = await info();
      return i?.parent === 'player' && i.open ? i : null;
    }, 3000);
    check(Boolean(full?.top), '全螢幕時字幕搬進播放器，在最上面，滑鼠點得到');
    await screenshot(ps, 'page-overlay-fullscreen.png');
    // 播放器設了 draggable（和 YouTube 的影片區一樣）：縮小或按著框的邊緣拖時，按下去的那一點會離開框、落在播放器上，
    // 瀏覽器不能因此開始拖播放器而中斷改大小、拖動（0.5.1 在全螢幕縮小字幕框只動了第一步）。
    if (full) {
      const grown = await resizeBy(200, 80);
      const shrunk = await resizeBy(-120, -50);
      check(
        grown.ok && shrunk.ok,
        `全螢幕時拖右下角可以放大也可以縮小（寬 ${grown.from.w.toFixed(0)}→${grown.to.w.toFixed(0)}→${shrunk.to.w.toFixed(0)}）`,
      );
      const edge = await info();
      await mouse('mousePressed', edge.cx, edge.bottom - 3);
      for (let i = 1; i <= 5; i++) await mouse('mouseMoved', edge.cx, edge.bottom - 3 - 30 * i);
      await mouse('mouseReleased', edge.cx, edge.bottom - 153);
      await sleep(300);
      const lifted = await info();
      check(
        Math.abs(lifted.bottom - edge.bottom + 150) < 3 && Math.abs(lifted.cx - edge.cx) < 3,
        `全螢幕時按著框的下緣往上拖也拖得動（移動 ${(lifted.bottom - edge.bottom).toFixed(0)}）`,
      );
      await resetSize();
    }
    await evaluate(ps, `document.exitFullscreen()`);
    check(
      Boolean(await until(async () => { const i = await info(); return i?.parent === 'HTML' && i.open && i.top; }, 3000)),
      '退出全螢幕後字幕回到網頁上',
    );

    const before = await info();
    await mouse('mousePressed', ...before.close);
    await mouse('mouseReleased', ...before.close);
    const gone = await until(async () => !(await info()), 3000);
    await sleep(300);
    const stored = (await evaluate(panel.sessionId, `chrome.storage.local.get('overlay')`)).overlay;
    const checked = await evaluate(panel.sessionId, `document.getElementById('overlay').checked`);
    check(gone && stored === false && !checked, '按 × 字幕不見，側邊欄的「網頁字幕」開關也關掉');

    await evaluate(panel.sessionId, `document.getElementById('overlay').click()`);
    check(Boolean(await until(async () => (await info())?.open, 5000)), '再打開「網頁字幕」開關，字幕又出現');
    if (opt.bilingual === 'on') {
      const tr = await until(async () => (await info())?.tr, 15000);
      check(Boolean(tr), `網頁字幕也有譯文（${tr?.slice(0, 30) ?? '沒有'}）`);
    }
  }

  let last = '';
  let meterMax = 0;
  let warning = '';
  let llamaSeen = false; // 錄音中看到過翻譯模型的程序
  let device = '';
  let translatorDevice = '';
  let toggledOn = false;
  let toggledOff = false;
  const recStart = Date.now();
  const deadline = recStart + (duration + 5) * 1000;
  let shotTaken = false;
  let buttonsChecked = false;
  const clickBilingual = () => evaluate(panel.sessionId, `document.getElementById('bilingual').click()`);
  while (Date.now() < deadline) {
    await sleep(3000);
    const { state, recordings } = await getState();
    const segs = recordings.at(-1)?.segments ?? [];
    const translated = segs.filter((s) => s.translation).length;
    const line =
      `狀態=${state.status} host=${state.host} 模型=${state.model} 排隊=${state.pending} 句數=${segs.length}` +
      ` 翻譯=${state.translator ?? '關'}${state.translatorDevice ? '/' + state.translatorDevice : ''} 有譯文=${translated}`;
    if (line !== last) log(line);
    last = line;
    if (state.status === 'error') throw new Error(state.message);
    if (state.message) warning = state.message;
    if (state.device) device = state.device;
    if (state.translatorDevice) translatorDevice = state.translatorDevice;
    const meter = await evaluate(panel.sessionId, `parseFloat(document.getElementById('meter-fill').style.width) || 0`);
    meterMax = Math.max(meterMax, meter);
    if (hostProcesses().llama.length) llamaSeen = true;
    const elapsed = (Date.now() - recStart) / 1000;
    // 錄音中的截圖在還有聲音時拍，才拍得到即時字幕（和它的譯文）。
    if (opt.shots && !shotTaken && elapsed >= duration * 0.6) {
      shotTaken = true;
      fs.mkdirSync(opt.shots, { recursive: true });
      await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 760, deviceScaleFactor: 1, mobile: false }, panel.sessionId);
      for (const scheme of ['light', 'dark']) {
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, panel.sessionId);
        await sleep(300);
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, panel.sessionId);
        fs.writeFileSync(path.join(opt.shots, `panel-recording-${scheme}.png`), Buffer.from(data, 'base64'));
      }
    }
    if (!buttonsChecked && elapsed >= duration * 0.45) {
      buttonsChecked = true;
      await checkPanelButtons(state.recId);
      await checkOverlay();
    }
    if (opt.bilingual === 'toggle' && !toggledOn && elapsed >= duration / 3) {
      log('在側邊欄打開雙語字幕');
      await clickBilingual();
      toggledOn = true;
    } else if (opt.bilingual === 'toggle' && toggledOn && !toggledOff && elapsed >= (duration * 2) / 3) {
      check(llamaSeen, '打開雙語字幕後有啟動翻譯模型');
      log('在側邊欄關掉雙語字幕');
      await clickBilingual();
      toggledOff = true;
      const gone = await waitFor(() => !hostProcesses().llama.length, 5000);
      check(gone, '關掉雙語字幕後 5 秒內翻譯模型已結束');
    }
  }
  check(!warning, `錄音中沒有警告（${warning || '無'}）`);
  check(meterMax > 20, `音量條有在動（最高 ${meterMax.toFixed(0)}%）`);

  const live = await evaluate(
    panel.sessionId,
    `({ t0: window.__t0, firstFinal: window.__firstFinal, captions: window.__captions, trCaptions: window.__trCaptions })`,
  );
  const caps = live.captions;
  const gaps = caps.slice(1).map((c, i) => (c.t - caps[i].t) / 1000).sort((a, b) => a - b);
  const firstCap = caps.length ? (caps[0].t - live.t0) / 1000 : null;
  const firstFinal = live.firstFinal ? (live.firstFinal - live.t0) / 1000 : null;
  log(
    `即時字幕：更新 ${caps.length} 次，第一次在 ${firstCap?.toFixed(1)} 秒；` +
      `更新間隔中位數 ${gaps.length ? gaps[Math.floor(gaps.length / 2)].toFixed(2) : '-'} 秒；第一句定稿在 ${firstFinal?.toFixed(1)} 秒`,
  );
  check(caps.length >= Math.floor(duration / 5), `錄音中有即時字幕（${caps.length} 次更新）`);
  check(firstCap !== null && (firstFinal === null || firstCap < firstFinal), '即時字幕比定稿先出現');
  if (opt.bilingual !== 'off') {
    log(`即時字幕的譯文：更新 ${live.trCaptions.length} 次，最後一次「${live.trCaptions.at(-1)?.text ?? ''}」`);
    // 只有 CPU 時即時字幕不翻（一句要 3 秒，跟不上每秒一次），只翻定稿。
    if (device !== 'cuda') check(live.trCaptions.length === 0, `CPU 模式不翻即時字幕（${live.trCaptions.length} 次）`);
    else if (translatorDevice === 'gpu') check(live.trCaptions.length >= 3, `即時字幕也有譯文（${live.trCaptions.length} 次更新）`);
    // 顯示卡被別的程式佔住時（例如使用者自己的瀏覽器也在錄音），翻譯模型會改用 CPU，即時字幕就不翻。
    else log(`翻譯模型改用 ${translatorDevice || '?'}，不檢查即時字幕的譯文`);
  }
  // 錄音中換頁：同網站整頁重新載入、換到別的網站（localhost 和 127.0.0.1 算不同網站），錄音都不中斷，字幕框在新頁面上自動出現。
  // 聲音已經播完，換頁不影響後面的字數檢查。
  {
    const { recId } = (await getState()).state;
    const ps = page.sessionId;
    for (const [label, url] of [['同網站換頁', `${pageUrl}?next`], ['換到別的網站', pageUrl.replace('127.0.0.1', 'localhost')]]) {
      await cdp('Page.navigate', { url }, ps);
      const shown = await until(
        () =>
          evaluate(ps, `location.href === ${JSON.stringify(url)} && Boolean(document.querySelector('tab-transcriber-caption')?.matches(':popover-open'))`)
            .catch(() => false),
        8000,
      );
      const { state } = await getState();
      check(shown && state.status === 'recording' && state.recId === recId, `${label}後錄音沒有中斷，字幕框在新頁面出現`);
    }
    // 換過網站後，停止再按側邊欄的「開始」要先再點一次圖示（點圖示拿到的 activeTab 換網站就失效）；錄音中點圖示不會重新開始。
    await cdp('Target.activateTarget', { targetId: page.targetId });
    await cdp('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
    await sleep(500);
    check((await getState()).state.recId === recId, '換網站後再點圖示，還是同一次錄音');
  }

  log('按側邊欄的「停止」');
  await evaluate(panel.sessionId, `document.getElementById('toggle').click()`);
  let final;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    final = await getState();
    if (final.state.status === 'idle' || final.state.status === 'error') break;
  }
  check(final.state.status === 'idle', `停止後回到待命（狀態=${final.state.status}，訊息=${final.state.message || '無'}）`);
  const llamaGone = await waitFor(() => !hostProcesses().llama.length, 5000);
  check(llamaGone, '停止後翻譯模型已結束');
  const contexts = await cdp('Target.getTargets');
  const offscreenLeft = contexts.targetInfos.some((t) => t.url.endsWith('/offscreen.html'));
  check(!offscreenLeft, '停止後錄音頁已關閉');
  const overlayLeft = await evaluate(page.sessionId, `Boolean(document.querySelector('tab-transcriber-caption'))`);
  check(!overlayLeft, '停止後網頁字幕拿掉了');

  // README 的換語言流程：圖示點過的分頁，在側邊欄換語言後按「開始」要能直接錄。
  const other = opt.lang === 'ja' ? 'en' : 'ja';
  await cdp('Target.activateTarget', { targetId: page.targetId });
  await evaluate(
    panel.sessionId,
    `(() => { const s = document.getElementById('language'); s.value = ${JSON.stringify(other)}; s.dispatchEvent(new Event('change')); })()`,
  );
  await sleep(300);
  await evaluate(panel.sessionId, `document.getElementById('toggle').click()`);
  let again;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    again = (await getState()).state;
    if (again.status === 'recording' || again.status === 'error') break;
  }
  check(
    again.status === 'recording' && again.language === other,
    `換成 ${other} 後在側邊欄按開始可以直接錄（狀態=${again.status}${again.message ? '，' + again.message : ''}）`,
  );
  await evaluate(panel.sessionId, `document.getElementById('toggle').click()`);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if ((await getState()).state.status === 'idle') break;
  }

  // 在不能錄音的頁面（側邊欄本身這個分頁）按開始，要出現白話提示，而且不會卡在錄音中。
  await cdp('Target.activateTarget', { targetId: panel.targetId });
  await evaluate(panel.sessionId, `document.getElementById('toggle').click()`);
  let bad;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    bad = (await getState()).state;
    if (bad.status === 'error' || bad.status === 'idle') break;
  }
  check(bad.status === 'error' && /工具列|內部頁面/.test(bad.message), `不能錄音的頁面按開始時提示：${bad.message}`);
  const hostLeft = await evaluate(panel.sessionId, `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c) => c.length)`);
  check(hostLeft === 0, '失敗後沒有留下錄音頁');

  const segs = final.recordings.at(-1)?.segments ?? [];
  const text = segs.map((s) => s.text).join(' ');
  // 日文、泰文詞和詞之間不空格，用字元數；英文用字數。一般朗讀英文每秒 2–3 字、日文每秒 5–8 字、泰文每秒約 10 字。
  const byChar = opt.lang !== 'en';
  const count = byChar ? text.replace(/\s/g, '').length : text.split(/\s+/).filter(Boolean).length;
  const minCount = duration * (byChar ? 3 : 1);
  check(segs.length > 0, `轉出 ${segs.length} 句、${count} 個${byChar ? '字元' : '字'}`);
  check(count >= minCount, `字數合理（至少 ${minCount}）`);
  check(final.recordings.at(-1)?.language === opt.lang, `文字稿標記的語言是 ${opt.lang}`);
  // 本機程式用來示範標點的提示句（host/transcriber_host.py STYLE_PROMPTS）不能被念進文字稿。
  const leaked = segs.filter((s) => /today's lecture|いいお天気/i.test(s.text));
  check(leaked.length === 0, `文字稿沒有混入提示句（${leaked.length} 句）`);
  // 泰文本來就幾乎不用標點，只檢查是泰文字。
  if (opt.lang === 'th') {
    check(/\p{Script=Thai}/u.test(text), '文字稿是泰文');
    if (start === 0 && duration >= 25) check(text.includes('1767'), '文字稿有第二句的「1767」');
  } else {
    check(/[.,?!。、？！]/.test(text), '文字稿有標點');
  }
  const monotonic = segs.every((s, i) => i === 0 || s.start >= segs[i - 1].start);
  check(monotonic, '時間依序遞增');
  const lastEnd = segs.at(-1)?.end ?? 0;
  check(lastEnd <= duration + 15, `最後一句結束在 ${lastEnd.toFixed(1)} 秒，沒有超出錄音長度`);
  // 雙語字幕：譯文接在一組句子的最後一句上（本機程式湊到句尾標點才翻）。
  const translated = segs.filter((s) => s.translation);
  const trText = translated.map((s) => s.translation).join('');
  if (opt.bilingual === 'off') {
    check(translated.length === 0 && !llamaSeen, '沒開雙語字幕時沒有翻譯，也沒有啟動翻譯模型');
  } else {
    check(translated.length > 0, `有譯文（${translated.length}／${segs.length} 句）`);
    if (opt.bilingual === 'on') check(Boolean(segs.at(-1)?.translation), '停止前最後一句也翻了');
    const han = (trText.match(/\p{Script=Han}/gu) ?? []).length;
    const letters = (trText.match(/\p{L}/gu) ?? []).length;
    check(han / Math.max(1, letters) > 0.7, `譯文是中文（漢字佔 ${((han / Math.max(1, letters)) * 100).toFixed(0)}%）`);
    const simplified = trText.match(/[这们个时说为会对来发过还没样问题与见经关现进开实点长东车门买卖头写读学习业电话认识让请谢语钱铁轮华国图场动应无当从]/g) ?? [];
    check(simplified.length === 0, `譯文是繁體字（簡體字 ${simplified.length} 個${simplified.length ? '：' + simplified.join('') : ''}）`);
    const source = { ja: /[\p{Script=Hiragana}\p{Script=Katakana}]/u, th: /\p{Script=Thai}/u }[opt.lang];
    check(!source || !source.test(trText), '譯文沒有夾著原文');
  }
  console.log('\n----- 文字稿 -----');
  for (const s of segs) {
    console.log(`[${s.start.toFixed(1).padStart(6)}] ${s.text}`);
    if (s.translation) console.log(`         ${s.translation}`);
  }
  console.log('------------------\n');

  if (opt.shots) {
    await evaluate(panel.sessionId, `window.scrollTo(0, 0)`);
    for (const scheme of ['light', 'dark']) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, panel.sessionId);
      await sleep(300);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, panel.sessionId);
      fs.writeFileSync(path.join(opt.shots, `panel-done-${scheme}.png`), Buffer.from(data, 'base64'));
    }
    log('截圖存在', opt.shots);
  }
} catch (err) {
  log('FAIL', err.message);
  failed = true;
} finally {
  await cdp('Browser.close').catch(() => {});
  ws.close();
  server.close();
  const left = await shutdownBrowser();
  check(left.length === 0, `瀏覽器已完全關閉（殘留程序 ${left.length} 個）`);
  await waitFor(() => !hostProcesses().host.length && !hostProcesses().llama.length, 5000);
  const orphans = hostProcesses();
  check(
    !orphans.host.length && !orphans.llama.length,
    `本機程式與翻譯模型都已結束（殘留 ${orphans.host.length} + ${orphans.llama.length} 個）`,
  );
}
log(failed ? '測試失敗' : '全部通過');
process.exit(failed ? 1 : 0);
