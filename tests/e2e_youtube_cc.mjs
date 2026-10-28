// YouTube 字幕模式的端到端測試：本機假的 YouTube 觀看頁（播放時用 fetch 抓 /api/timedtext，和真的播放器一樣帶 pot），
// 載入一份把 127.0.0.1 也加進 YouTube 內容腳本範圍的插件複本（ID 由 manifest 的 key 決定，不變），模擬點圖示。
// 檢查：不錄音、不載入 Whisper；插件幫忙打開 CC；一拿到字幕就整部進文字稿；網頁字幕和側邊欄跟著影片時間走；
// 往回拖、重新整理網頁都不會重複；停止後收乾淨，插件打開的 CC 關回去，使用者自己開的不動。
// 真的 YouTube 在 headless 瀏覽器裡會擋字幕和播放（研究筆記第 13 節），所以只能用假的頁面測插件這一側。
//
// 用法：node tests/e2e_youtube_cc.mjs [--bilingual]（--bilingual 會啟動翻譯模型，要用顯示卡）
//       node tests/e2e_youtube_cc.mjs --no-hook   拿掉 yt-caption-hook.js，應該提示打開 CC（確認測試抓得到這種壞掉）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXPECTED_ID = 'pclblnfmncjbohcnbhlkgefpdhpljiae';
const VIDEO = 'MOCKVIDEO01';
const { values: opt } = parseArgs({ options: { bilingual: { type: 'boolean', default: false }, 'no-hook': { type: 'boolean', default: false } } });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
};

// 每 2 秒一句；中間夾一個自動字幕的換行事件（aAppend）和只有換行的事件，都不該進文字稿
const CUES = Array.from({ length: 30 }, (_, i) => ({ start: 1 + i * 2, text: `This is caption number ${i + 1}.` }));
const json3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 500, aAppend: 1, segs: [{ utf8: '\n' }] },
    ...CUES.flatMap((c) => [
      { tStartMs: c.start * 1000, dDurationMs: 1800, segs: c.text.split(' ').map((w, i) => ({ utf8: (i ? ' ' : '') + w })) },
      { tStartMs: c.start * 1000 + 1900, dDurationMs: 50, segs: [{ utf8: '\n' }] },
    ]),
  ],
});

// ---- 假的 YouTube：觀看頁、字幕檔、影片（用測試用的英文錄音，靜音播放）----
const media = fs.readFileSync(path.join(ROOT, 'docs/research/tab-transcription/corpus/alice-one-syllable-ch02.mp3'));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/timedtext') {
    // 真的播放器會打兩次：一次沒帶 pot（回空的）、一次帶 pot；翻譯（tlang）的要被忽略
    const body = url.searchParams.has('pot') && !url.searchParams.has('tlang') ? json3 : '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  if (url.pathname === '/media.mp3') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const from = range ? Number(range[1]) : 0;
    const to = range && range[2] ? Number(range[2]) : media.length - 1;
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': to - from + 1,
      ...(range ? { 'Content-Range': `bytes ${from}-${to}/${media.length}` } : {}) });
    res.end(media.subarray(from, to + 1));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Mock video - YouTube</title>
<div id="movie_player" style="width:960px;height:540px;background:#000"><video class="html5-main-video" src="/media.mp3" muted autoplay style="width:100%;height:90%"></video>
<button class="ytp-subtitles-button ytp-button" aria-pressed="false">CC</button></div>
<script>
  // 和真的播放器一樣：CC 開著才抓字幕（一次 XHR 沒帶 pot、一次 fetch 帶 pot，另外一次是翻譯），
  // 而且會記住上次開著，下次載入就自己抓
  const button = document.querySelector('.ytp-subtitles-button');
  let fetched = false;
  function load() {
    if (fetched || button.getAttribute('aria-pressed') !== 'true') return;
    fetched = true;
    const v = new URLSearchParams(location.search).get('v');
    const x = new XMLHttpRequest(); x.open('GET', '/api/timedtext?v=' + v + '&lang=en&fmt=json3'); x.send();
    fetch('/api/timedtext?v=' + v + '&lang=en&fmt=json3&pot=abc123&c=WEB');
    fetch('/api/timedtext?v=' + v + '&lang=en&fmt=json3&pot=abc123&c=WEB&tlang=zh-Hant');
  }
  button.addEventListener('click', () => {
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(on));
    localStorage.cc = on ? '1' : '0';
    load();
  });
  if (localStorage.cc === '1') button.setAttribute('aria-pressed', 'true');
  document.querySelector('video').addEventListener('playing', load, { once: true });
</script>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/watch?v=${VIDEO}`;

// ---- 插件複本：YouTube 內容腳本也套用到 127.0.0.1 ----
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ytcc-ext-'));
fs.cpSync(path.join(ROOT, 'extension'), ext, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
for (const cs of manifest.content_scripts) cs.matches.push('http://127.0.0.1/*');
if (opt['no-hook']) manifest.content_scripts = manifest.content_scripts.filter((cs) => !cs.js.includes('yt-caption-hook.js'));
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ---- 瀏覽器（和 e2e.mjs 一樣：暫時設定檔，結束時整組收掉）----
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-ytcc-'));
const browser = spawn('brave-browser', ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  'about:blank'], { stdio: 'ignore', detached: true });
const profileProcesses = () => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
  try { return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').includes(`--user-data-dir=${profile}`); } catch { return false; }
});
async function shutdown() {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    for (let i = 0; i < 25 && profileProcesses().length; i++) await sleep(200);
    if (!profileProcesses().length) break;
    try { process.kill(-browser.pid, sig); } catch {}
    for (const pid of profileProcesses()) try { process.kill(Number(pid), sig); } catch {}
  }
  server.close();
  // 瀏覽器剛結束時還可能在寫設定檔，刪不乾淨就再試幾次
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(ext, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

try {
  let wsPath;
  for (let i = 0; i < 100 && !wsPath; i++) {
    await sleep(200);
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) { const [p, w] = fs.readFileSync(f, 'utf8').split('\n'); if (w) wsPath = `ws://127.0.0.1:${p}${w}`; }
  }
  const ws = new WebSocket(wsPath);
  await new Promise((r) => (ws.onopen = r));
  let nextId = 1;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const { resolve, reject } = waiting.get(m.id); waiting.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  };
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async (sessionId, expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const attach = async (targetId) => { const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }); await cdp('Runtime.enable', {}, sessionId); return sessionId; };

  const { id } = await cdp('Extensions.loadUnpacked', { path: ext });
  check(id === EXPECTED_ID, `插件複本載入，ID = ${id}`);
  const { targetId: panelTarget } = await cdp('Target.createTarget', { url: `chrome-extension://${id}/sidepanel.html` });
  const panel = await attach(panelTarget);
  await evaluate(panel, `chrome.storage.local.set({ ytCaptions: true, overlay: true, bilingual: ${opt.bilingual}, language: 'ja' })`);
  const { targetId: pageTarget } = await cdp('Target.createTarget', { url: pageUrl });
  const page = await attach(pageTarget);
  await sleep(2500);
  const getState = () => evaluate(panel, `Promise.all([chrome.storage.session.get('state'), chrome.storage.local.get('recordings')]).then(([s, l]) => ({ state: s.state ?? {}, rec: (l.recordings ?? []).at(-1) }))`);
  const videoTime = () => evaluate(page, `document.querySelector('video').currentTime`);
  const overlayText = () => evaluate(page, `document.querySelector('tab-transcriber-caption')?.shadowRoot.querySelector('.line:last-child')?.firstChild?.textContent ?? ''`); // 只要原文，不含譯文
  const until = async (fn, ms) => { for (let t = 0; t < ms; t += 250) { const v = await fn(); if (v) return v; await sleep(250); } return fn(); };

  const { targetInfos } = await cdp('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.type === 'tab' && t.url === pageUrl);
  await cdp('Target.activateTarget', { targetId: pageTarget });
  await cdp('Extensions.triggerAction', { id, targetId: tab.targetId });
  log('已模擬點擊插件圖示');

  const ccState = () => evaluate(page, `document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed')`);
  // 影片現在該顯示的那一句（最後一句已經開始的）
  const cueAt = (t) => CUES.findLast((c) => c.start <= t);
  const nowLine = () => evaluate(panel, `document.querySelector('.line.now .src')?.textContent ?? ''`);
  const followsVideo = async () => {
    const [t, shown, now] = [await videoTime(), await overlayText(), await nowLine()];
    const ok = [cueAt(t)?.text, cueAt(t - 0.8)?.text].includes(shown) && shown === now;
    return { ok, text: `影片 ${t.toFixed(1)} 秒，網頁字幕「${shown}」，側邊欄標的「${now}」` };
  };

  if (opt['no-hook']) {
    const s = await until(async () => { const { state } = await getState(); return /打開 CC/.test(state.message) ? state : null; }, 14000);
    check(Boolean(s), `拿不到字幕時提示打開 CC（${(await getState()).state.message || '沒有提示'}）`);
  } else {
    const started = await until(async () => { const { state } = await getState(); return state.status === 'recording' ? state : null; }, 8000);
    check(started?.source === 'youtube', `用 YouTube 字幕模式開始（來源=${started?.source}，狀態=${started?.status}）`);
    const offscreen = (await cdp('Target.getTargets')).targetInfos.some((t) => t.url.endsWith('/offscreen.html'));
    check(!offscreen, '沒有開錄音頁（不錄聲音）');
    check(await until(async () => (await ccState()) === 'true', 6000), '插件幫忙打開了播放器的 CC');
    const full = await until(async () => ((await getState()).rec?.segments.length === CUES.length ? true : null), 5000);
    let { state, rec } = await getState();
    const t = await videoTime();
    check(Boolean(full) && CUES.every((c, i) => rec.segments[i]?.start === c.start && rec.segments[i]?.text === c.text),
      `一拿到字幕就整部影片進文字稿（影片才播到 ${t.toFixed(1)} 秒，文字稿 ${rec.segments.length} 句，時間是影片時間）`);
    check(/YouTube 字幕（en）/.test(state.model), `顯示字幕來源（${state.model}）`);
    check(rec.source === 'youtube' && rec.language === 'en', `文字稿標記 YouTube 字幕、語言 en（${rec.source}、${rec.language}）`);
    check(!rec.segments.some((s) => s.text.includes('\n') || !s.text.trim()), '自動字幕的換行事件沒有進文字稿');
    await sleep(4000);
    let f = await until(async () => ((await followsVideo()).ok ? true : null), 3000);
    check(Boolean(f), `網頁字幕和側邊欄跟著影片走（${(await followsVideo()).text}）`);
    // 原生 CC 在一句開始時就換；網頁字幕晚多少（毫秒）：影片時間跨過一句開頭的時刻 → 網頁字幕換成那一句
    const lags = await evaluate(page, `new Promise((resolve) => {
      const v = document.querySelector('video');
      const root = document.querySelector('tab-transcriber-caption').shadowRoot;
      const cues = ${JSON.stringify(CUES)};
      const crossed = {}, shown = {};
      let last = v.currentTime;
      const poll = setInterval(() => {
        const t = v.currentTime, now = performance.now();
        cues.forEach((c, i) => { if (last < c.start && t >= c.start) crossed[i] = now - ((t - c.start) / v.playbackRate) * 1000; });
        last = t;
      }, 4);
      const seen = new MutationObserver(() => {
        const text = root.querySelector('.line:last-child')?.firstChild?.textContent;
        const i = cues.findIndex((c) => c.text === text);
        if (i >= 0 && !(i in shown)) shown[i] = performance.now();
      });
      seen.observe(root, { childList: true, subtree: true, characterData: true });
      setTimeout(() => {
        clearInterval(poll);
        seen.disconnect();
        resolve(Object.keys(crossed).filter((i) => i in shown).map((i) => Math.round(shown[i] - crossed[i])));
      }, 8500);
    })`);
    const sorted = [...lags].sort((a, b) => a - b);
    check(sorted.length >= 3 && sorted[sorted.length >> 1] <= 60 && sorted.at(-1) <= 150,
      `網頁字幕在一句開始時就換（${sorted.length} 句，晚 ${lags.join('、')} 毫秒）`);

    log('往回拖到 1 秒');
    await evaluate(page, `document.querySelector('video').currentTime = 1`);
    await sleep(1500);
    ({ rec } = await getState());
    const starts = rec.segments.map((s) => s.start);
    f = await followsVideo();
    check(starts.length === CUES.length && new Set(starts).size === starts.length && f.ok,
      `往回拖：文字稿不變（${starts.length} 句）、字幕回到那一句（${f.text}）`);

    log('重新整理網頁');
    await evaluate(page, `location.reload()`);
    // 重新整理後播放器記得 CC 開著，自己抓字幕；插件不能再按一次（會把它關掉）
    await until(async () => (await evaluate(page, `document.querySelector('video')?.currentTime ?? 0`).catch(() => 0)) > 2, 8000);
    await sleep(3000);
    check((await ccState()) === 'true', '重新整理後 CC 還開著（插件沒有又按一次）');
    await evaluate(page, `document.querySelector('video').currentTime = 20`);
    await sleep(1500);
    ({ state, rec } = await getState());
    const after = rec.segments.map((s) => s.start);
    f = await followsVideo();
    check(state.status === 'recording' && after.length === CUES.length && new Set(after).size === after.length && f.ok,
      `重新整理後繼續跟著影片、不重複（${after.length} 句；${f.text}）`);

    // 清除要按兩次；字幕模式的文字稿是整部影片的字幕，只清以前的錄音
    await evaluate(panel, `document.getElementById('clear').click(); document.getElementById('clear').click()`);
    await sleep(1000);
    ({ rec } = await getState());
    check(rec.segments.length === CUES.length && Boolean(await nowLine()), `按清除後這部影片的字幕還在、還標著現在這一句（${rec.segments.length} 句）`);

    if (opt.bilingual) {
      // 先翻好後面的句子：影片還沒播到的地方就有譯文
      const ahead = await until(async () => {
        const [{ rec: r }, now] = [await getState(), await videoTime()];
        const n = r.segments.filter((s) => s.translation && s.start > now + 5).length;
        return n ? { n, now } : null;
      }, 60000);
      check(Boolean(ahead), `雙語字幕：影片還沒播到的句子先有譯文（${ahead ? `${ahead.n} 句，影片在 ${ahead.now.toFixed(1)} 秒` : '沒有'}）`);
      // 剛拖過進度條時，現在這一組可能還在翻
      const overlayTr = () => evaluate(page, `document.querySelector('tab-transcriber-caption')?.shadowRoot.querySelector('.line:last-child .tr')?.textContent ?? ''`);
      const shownTr = await until(async () => { const tr = await overlayTr(); return /[一-鿿]/.test(tr) ? tr : null; }, 15000);
      check(Boolean(shownTr), `網頁字幕現在這一句有中文（${shownTr ?? await overlayTr()}）`);
    }

    await evaluate(panel, `document.getElementById('toggle').click()`);
    const idle = await until(async () => ((await getState()).state.status === 'idle' ? true : null), 10000);
    ({ rec } = await getState());
    check(Boolean(idle), '按停止後馬上回到待命（不等還沒播到的句子翻完）');
    const n = rec.segments.length;
    await sleep(3000);
    check((await getState()).rec.segments.length === n, '停止後文字稿不再變');
    check(!(await evaluate(page, `!!document.querySelector('tab-transcriber-caption')`)), '停止後網頁字幕拿掉了');
    check((await ccState()) === 'false', '停止後插件打開的 CC 關回去了');

    log('使用者自己開著 CC 再錄一次');
    await evaluate(page, `(b => b.getAttribute('aria-pressed') === 'true' || b.click())(document.querySelector('.ytp-subtitles-button'))`);
    await sleep(500);
    await cdp('Extensions.triggerAction', { id, targetId: tab.targetId });
    await until(async () => ((await getState()).state.status === 'recording' ? true : null), 8000);
    await sleep(3000);
    await evaluate(panel, `document.getElementById('toggle').click()`);
    await until(async () => ((await getState()).state.status === 'idle' ? true : null), 10000);
    await sleep(500);
    check((await ccState()) === 'true', '使用者自己開的 CC，停止後還開著');
  }
} catch (err) {
  log('ERROR', err.message);
  failed++;
} finally {
  await shutdown();
  log(`瀏覽器殘留 ${profileProcesses().length} 個程序`);
}
log(failed ? `${failed} 項失敗` : '全部通過');
process.exit(failed ? 1 : 0);
