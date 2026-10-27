// YouTube 原文字幕能不能從插件拿到：播放器回應裡的字幕清單、直接抓 timedtext、播放器自己的 timedtext 請求、
// 用那個網址在 content script（獨立 world）重抓原文和 tlang 翻譯、畫面上的字幕 DOM、逐字稿面板。
// 用法：node docs/research/tab-transcription/yt_captions_probe.mjs <影片 id>...（第 13 節）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['dQw4w9WgXcQ'];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcc-profile-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const browser = spawn('brave-browser', ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--window-size=1280,720', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--lang=zh-TW', 'about:blank'],
  { stdio: 'ignore', detached: true });
const kill = () => { try { process.kill(-browser.pid, 'SIGKILL'); } catch {} };
try {
  let wsPath;
  for (let i = 0; i < 100 && !wsPath; i++) {
    await sleep(200);
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) { const [p, w] = fs.readFileSync(f, 'utf8').split('\n'); if (w) wsPath = `ws://127.0.0.1:${p}${w}`; }
  }
  const ws = new WebSocket(wsPath);
  await new Promise((r) => (ws.onopen = r));
  let id = 1; const wait = new Map(); const listeners = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else listeners.forEach((f) => f(m)); };
  const cdp = (method, params = {}, sessionId) => new Promise((r) => { const i = id++; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  for (const vid of IDS) {
    log('=====', vid);
    const { result: { targetId } } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    const timed = [];
    listeners.push((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/timedtext')) timed.push({ requestId: m.params.requestId, url: m.params.response.url, status: m.params.response.status });
    });
    await cdp('Network.enable', {}, sessionId);
    await cdp('Page.enable', {}, sessionId);
    await cdp('Page.navigate', { url: `https://www.youtube.com/watch?v=${vid}` }, sessionId);
    await sleep(9000);
    const main = async (expression) => {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
      if (r.result?.exceptionDetails) return 'ERR ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
      return r.result.result.value;
    };
    const { result: { frameTree } } = await cdp('Page.getFrameTree', {}, sessionId);
    const { result: { executionContextId: iso } } = await cdp('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'cs' }, sessionId);
    const isolated = async (expression) => {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId: iso }, sessionId);
      if (r.result?.exceptionDetails) return 'ERR ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
      return r.result.result.value;
    };

    // 1. 播放器回應裡的字幕清單（主 world 才看得到 player 物件）
    const tracks = await main(`(() => {
      const p = document.querySelector('#movie_player');
      const pr = p?.getPlayerResponse?.() ?? window.ytInitialPlayerResponse;
      const r = pr?.captions?.playerCaptionsTracklistRenderer;
      return { title: pr?.videoDetails?.title, status: pr?.playabilityStatus?.status,
        tracks: (r?.captionTracks ?? []).map((t) => ({ lang: t.languageCode, kind: t.kind ?? 'manual', name: t.name?.simpleText ?? t.name?.runs?.[0]?.text, translatable: t.isTranslatable, url: t.baseUrl })),
        translationLanguages: r?.translationLanguages?.length ?? 0,
        zhHant: (r?.translationLanguages ?? []).filter((l) => /zh/.test(l.languageCode)).map((l) => l.languageCode) };
    })()`);
    log('player', JSON.stringify({ ...tracks, tracks: tracks.tracks?.map(({ url, ...t }) => ({ ...t, xpe: /exp=xpe/.test(url) })) }));
    // 字幕清單在獨立 world 也看得到嗎（content script 的情況）：只能讀頁面的 HTML
    log('isolated sees captionTracks in HTML:', await isolated(`[...document.scripts].some((s) => s.textContent.includes('captionTracks'))`));
    const first = tracks.tracks?.find((t) => t.kind === 'manual') ?? tracks.tracks?.[0];
    if (!first) { log('no caption tracks'); await cdp('Target.closeTarget', { targetId }); continue; }

    // 2. 直接抓 baseUrl（沒有 pot）
    log('direct fetch (no pot):', await isolated(`fetch(${JSON.stringify(first.url + '&fmt=json3')}).then(async (r) => ({ status: r.status, len: (await r.text()).length }))`));

    // 3. 打開 CC，讓播放器自己抓
    await main(`(() => { const v = document.querySelector('video'); v.muted = true; v.play(); })()`);
    await sleep(1500);
    log('cc button before:', await main(`document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed')`));
    await main(`document.querySelector('.ytp-subtitles-button')?.click()`);
    await sleep(5000);
    log('cc button after:', await main(`document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed')`), 'timedtext requests:', timed.length);
    for (const t of timed) {
      const body = await cdp('Network.getResponseBody', { requestId: t.requestId }, sessionId);
      const u = new URL(t.url);
      log('  player request', { status: t.status, lang: u.searchParams.get('lang'), tlang: u.searchParams.get('tlang'), fmt: u.searchParams.get('fmt'), pot: u.searchParams.has('pot'), c: u.searchParams.get('c'), bodyLen: body.result?.body?.length ?? body.error?.message });
    }
    // 4. 用播放器的網址（含 pot）在 content script 重抓：原文、翻成繁中
    const playerUrl = timed.find((t) => t.status === 200 && new URL(t.url).searchParams.has('pot'))?.url ?? timed[0]?.url;
    if (playerUrl) {
      const variants = { original: (u) => u, zhHant: (u) => { u.searchParams.set('tlang', 'zh-Hant'); return u; } };
      for (const [name, f] of Object.entries(variants)) {
        const u = f(new URL(playerUrl)); u.searchParams.set('fmt', 'json3');
        const r = await isolated(`fetch(${JSON.stringify(u.toString())}).then(async (r) => { const t = await r.text(); let j; try { j = JSON.parse(t); } catch {}
          const ev = (j?.events ?? []).filter((e) => e.segs);
          return { status: r.status, len: t.length, events: ev.length, sample: ev.slice(0, 3).map((e) => [(e.tStartMs / 1000).toFixed(1), e.segs.map((s) => s.utf8).join('').slice(0, 40)]) }; })`);
        log(`  content-script refetch ${name}:`, JSON.stringify(r));
      }
      // pot 能不能跨影片、隔一段時間重用：這裡只記錄網址裡的 pot 長度
      log('  pot length', new URL(playerUrl).searchParams.get('pot')?.length);
    }
    // 5. 畫面上的字幕（content script 讀 DOM）
    for (let i = 0; i < 3; i++) {
      log('  dom caption:', JSON.stringify(await isolated(`[...document.querySelectorAll('.ytp-caption-segment')].map((e) => e.textContent).join(' | ').slice(0, 80)`)));
      await sleep(2000);
    }
    // 6. 逐字稿面板
    log('  transcript panel exists:', await isolated(`!!document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]')`));
    await cdp('Target.closeTarget', { targetId });
  }
} finally { kill(); await sleep(500); fs.rmSync(profile, { recursive: true, force: true }); }
