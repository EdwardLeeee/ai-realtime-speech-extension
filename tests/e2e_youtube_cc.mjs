// YouTube 字幕模式的端到端測試：本機假的 YouTube 觀看頁（播放時用 fetch 抓 /api/timedtext，和真的播放器一樣帶 pot），
// 載入一份把 127.0.0.1 也加進 YouTube 內容腳本範圍的插件複本（ID 由 manifest 的 key 決定，不變），模擬點圖示。
// 檢查：不錄音、不載入 Whisper；字幕照影片時間一句句進文字稿和網頁字幕；往回拖、重新整理網頁都不會重複；停止後收乾淨。
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
<div id="movie_player" style="width:960px;height:540px;background:#000"><video class="html5-main-video" src="/media.mp3" muted autoplay style="width:100%;height:100%"></video></div>
<script>
  // 和真的播放器一樣：開始播放後抓字幕（一次 XHR 沒帶 pot、一次 fetch 帶 pot，另外一次是翻譯）
  document.querySelector('video').addEventListener('playing', () => {
    const v = new URLSearchParams(location.search).get('v');
    const x = new XMLHttpRequest(); x.open('GET', '/api/timedtext?v=' + v + '&lang=en&fmt=json3'); x.send();
    fetch('/api/timedtext?v=' + v + '&lang=en&fmt=json3&pot=abc123&c=WEB');
    fetch('/api/timedtext?v=' + v + '&lang=en&fmt=json3&pot=abc123&c=WEB&tlang=zh-Hant');
  }, { once: true });
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
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
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
  const overlayText = () => evaluate(page, `document.querySelector('tab-transcriber-caption')?.shadowRoot.querySelector('.line:last-child')?.textContent ?? ''`);
  const until = async (fn, ms) => { for (let t = 0; t < ms; t += 250) { const v = await fn(); if (v) return v; await sleep(250); } return fn(); };

  const { targetInfos } = await cdp('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.type === 'tab' && t.url === pageUrl);
  await cdp('Target.activateTarget', { targetId: pageTarget });
  await cdp('Extensions.triggerAction', { id, targetId: tab.targetId });
  log('已模擬點擊插件圖示');

  if (opt['no-hook']) {
    const s = await until(async () => { const { state } = await getState(); return /打開 CC/.test(state.message) ? state : null; }, 14000);
    check(Boolean(s), `拿不到字幕時提示打開 CC（${(await getState()).state.message || '沒有提示'}）`);
  } else {
    const started = await until(async () => { const { state } = await getState(); return state.status === 'recording' ? state : null; }, 8000);
    check(started?.source === 'youtube', `用 YouTube 字幕模式開始（來源=${started?.source}，狀態=${started?.status}）`);
    const offscreen = (await cdp('Target.getTargets')).targetInfos.some((t) => t.url.endsWith('/offscreen.html'));
    check(!offscreen, '沒有開錄音頁（不錄聲音）');
    await sleep(9000);
    let { state, rec } = await getState();
    const t = await videoTime();
    const expected = CUES.filter((c) => c.start <= t - 0.6); // 檢查間隔 0.5 秒，留一點餘裕
    const got = rec.segments.map((s) => s.start);
    check(/YouTube 字幕（en）/.test(state.model), `顯示字幕來源（${state.model}）`);
    check(rec.source === 'youtube' && rec.language === 'en', `文字稿標記 YouTube 字幕、語言 en（${rec.source}、${rec.language}）`);
    check(expected.every((c) => rec.segments.some((s) => s.start === c.start && s.text === c.text)) &&
      rec.segments.every((s) => CUES.some((c) => c.start === s.start && c.text === s.text && s.start <= t + 0.1)),
      `影片播到 ${t.toFixed(1)} 秒，文字稿是那之前的每一句，時間是影片時間（${got.join(', ')}）`);
    check(!rec.segments.some((s) => s.text.includes('\n') || !s.text.trim()), '自動字幕的換行事件沒有進文字稿');
    const shown = await overlayText();
    check(shown === rec.segments.at(-1)?.text, `網頁字幕顯示目前這一句（${shown}）`);

    log('往回拖到 1 秒');
    await evaluate(page, `document.querySelector('video').currentTime = 1`);
    await sleep(3000);
    ({ rec } = await getState());
    const starts = rec.segments.map((s) => s.start);
    check(new Set(starts).size === starts.length, `往回拖不會重複（${starts.length} 句）`);

    log('重新整理網頁');
    const before = rec.segments.length;
    await evaluate(page, `location.reload()`);
    // 重新整理後影片從頭播：已經收過的句子要擋掉；跳到 20 秒後，後面的新句子要進來
    await until(async () => (await evaluate(page, `document.querySelector('video')?.currentTime ?? 0`).catch(() => 0)) > 2, 8000);
    await sleep(2000);
    await evaluate(page, `document.querySelector('video').currentTime = 20`);
    await sleep(5000);
    ({ state, rec } = await getState());
    const after = rec.segments.map((s) => s.start);
    check(state.status === 'recording' && new Set(after).size === after.length && after.some((s) => s >= 19),
      `重新整理後繼續收字幕、不重複（${before} → ${after.length} 句：${after.join(', ')}）`);

    if (opt.bilingual) {
      const translated = await until(async () => (await getState()).rec.segments.filter((s) => s.translation).length, 30000);
      check(translated > 0, `雙語字幕：有譯文（${translated} 句）`);
    }

    await evaluate(panel, `document.getElementById('toggle').click()`);
    const idle = await until(async () => ((await getState()).state.status === 'idle' ? true : null), 30000);
    ({ rec } = await getState());
    check(Boolean(idle), '按停止後回到待命');
    const n = rec.segments.length;
    await sleep(3000);
    check((await getState()).rec.segments.length === n, '停止後不再收字幕');
    check(!(await evaluate(page, `!!document.querySelector('tab-transcriber-caption')`)), '停止後網頁字幕拿掉了');
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
