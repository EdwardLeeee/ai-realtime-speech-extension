// 字幕延遲：透過真的插件（無頭 Brave＋本機程式）播一串 FLEURS 句子，量使用者看到字幕要等多久。
//   開口到第一個即時字幕：這句第一個字開始講到側邊欄第一次出現這句的即時字幕（第一版常有錯字，不要求轉對）
//   講完到定稿：這句最後一個字講完到這句結尾的字出現在定稿裡（一段可能包含上一句的結尾和下一句的開頭，所以看字不看段）
//   講完到中文：雙語字幕開著時，這句講完到它的中文出現（翻譯會等到句尾標點才翻，最多等 6 秒，所以譯文掛在同一組的最後一行）
// 每句之間插 2.5 秒靜音（加上 FLEURS 句子本身前後的空白，停頓約 3 秒）。時間都換算成音檔的播放時間來比，
// 網頁每 0.2 秒記一次（時鐘, currentTime），側邊欄用同一個時鐘（performance.timeOrigin + now()）記字幕變化。
// 挑哪些句子、音量怎麼調、句子的開始和結束怎麼定，見 latency_audio.py。
//
// 要先執行過 ./install.sh；用 host/.venv 的 Python 和顯示卡做音檔。
// 用法：node docs/research/tab-transcription/bench_latency.mjs --fleurs <FLEURS 語言資料夾> --lang en
//         [--clips 25] [--bilingual on|off] [--cpu] [--out docs/research/tab-transcription/bench-latency.jsonl] [--raw 原始紀錄.json]
//   重算：node docs/research/tab-transcription/bench_latency.mjs --reanalyze 原始紀錄.json
//   --cpu：瀏覽器帶 CUDA_VISIBLE_DEVICES= 啟動，本機程式看不到顯示卡，改用 CPU 和 CPU 的模型

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..', '..');
const EXPECTED_ID = 'pclblnfmncjbohcnbhlkgefpdhpljiae';
const { values: opt } = parseArgs({
  options: {
    fleurs: { type: 'string' },
    lang: { type: 'string', default: 'en' },
    clips: { type: 'string', default: '25' },
    gap: { type: 'string', default: '2.5' },
    bilingual: { type: 'string', default: 'on' },
    cpu: { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(HERE, 'bench-latency.jsonl') },
    raw: { type: 'string' }, // 另外存原始紀錄（每句時間、側邊欄的每次變化、播放時間對照），可以事後重算
    reanalyze: { type: 'string' }, // 只拿 --raw 存的原始紀錄重算，不開瀏覽器
    extension: { type: 'string', default: path.join(ROOT, 'extension') }, // 改過的插件複本（比較不同的切段規則）
    label: { type: 'string', default: '' }, // 寫進結果，分辨是哪一版
    times: { type: 'string' }, // 重算時換掉每句的開始和結束（latency_audio.py 不給輸出檔時印的 JSON）
  },
});
if (!opt.fleurs && !opt.reanalyze) throw new Error('需要 --fleurs <FLEURS 語言資料夾>');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 和 host/run_host.sh 一樣，讓 CTranslate2 找得到 pip 裝的 CUDA 函式庫
function cudaLibs() {
  const site = path.join(ROOT, 'host', '.venv', 'lib');
  const dirs = [];
  for (const py of fs.existsSync(site) ? fs.readdirSync(site) : []) {
    const nv = path.join(site, py, 'site-packages', 'nvidia');
    for (const d of fs.existsSync(nv) ? fs.readdirSync(nv) : []) if (fs.existsSync(path.join(nv, d, 'lib'))) dirs.push(path.join(nv, d, 'lib'));
  }
  return [...dirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}
if (opt.reanalyze) {
  const raw = JSON.parse(fs.readFileSync(opt.reanalyze, 'utf8'));
  if (opt.times) {
    const fixed = JSON.parse(fs.readFileSync(opt.times, 'utf8')).clips;
    if (fixed.map((c) => c.id).join() !== raw.clips.map((c) => c.id).join()) throw new Error('--times 的句子和原始紀錄對不上');
    raw.clips = fixed;
  }
  const { per, lines, summary } = analyze(raw.events, raw.map, raw.clips, raw.rec);
  for (const p of per) console.log(JSON.stringify(p));
  for (const l of lines) console.log(JSON.stringify(l));
  console.log(JSON.stringify(summary));
  process.exit(0);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-latency-'));

// ---- 音檔：挑句子接成一個 wav，記下每句第一個字開始、最後一個字結束的時間（latency_audio.py）----
const py = spawnSync(path.join(ROOT, 'host', '.venv', 'bin', 'python'),
  ['-I', path.join(HERE, 'latency_audio.py'), opt.fleurs, opt.lang, opt.clips, opt.gap, path.join(work, 'audio.wav')],
  { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: cudaLibs() } });
if (py.status !== 0) throw new Error(`做音檔失敗：${py.stderr}`);
const { duration, clips } = JSON.parse(py.stdout);
log(`音檔 ${duration} 秒，${clips.length} 句`);
if (clips.length < Number(opt.clips)) throw new Error(`夠大聲的句子只有 ${clips.length} 句，不到 ${opt.clips} 句`);

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/audio.wav')) {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    fs.createReadStream(path.join(work, 'audio.wav')).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>latency</title><audio id="a" preload="auto" src="/audio.wav"></audio>
<script>
  window.__map = [];
  const a = document.getElementById('a');
  setInterval(() => { if (!a.paused) window.__map.push([performance.timeOrigin + performance.now(), a.currentTime]); }, 200);
</script>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// ---- 瀏覽器（同 tools/demo_screenshot.mjs）----
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-latency-profile-'));
const env = opt.cpu ? { ...process.env, CUDA_VISIBLE_DEVICES: '' } : process.env;
const browser = spawn('brave-browser', ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--disable-audio-output', 'about:blank'], { stdio: 'ignore', detached: true, env });
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
const openTab = async (url) => {
  const { targetId } = await cdp('Target.createTarget', { url });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
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

// ---- 分析 ----
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function round(x) {
  return x === null || x === undefined ? null : Math.round(x * 100) / 100;
}
function bigrams(s) {
  const t = s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}
// 把 ref 整句對齊到 hyp 的某一段（前後多出來的 hyp 不算錯），回傳 [ref 最後一個對上的字, 它對到的 hyp 位置]
function alignEnd(ref, hyp) {
  if (!ref.length || !hyp.length) return null;
  const m = ref.length, n = hyp.length;
  let prev = new Array(n + 1).fill(0); // 第 0 列：從 hyp 的任何位置開始都不扣分
  const back = []; // back[i][j]：走到 (i, j) 的上一步，0 對角、1 上（ref 少字）、2 左（hyp 多字）
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    const b = new Uint8Array(n + 1);
    cur[0] = i;
    b[0] = 1;
    for (let j = 1; j <= n; j++) {
      // 換字算 2（等於少一個字加多一個字）：否則句尾沒轉出來的字會去對下一行開頭的字，把句尾算到下一行
      const eq = ref[i - 1] === hyp[j - 1];
      const diag = prev[j - 1] + (eq ? 0 : 2);
      const up = prev[j] + 1;
      const left = cur[j - 1] + 1;
      if (eq && diag <= up && diag <= left) [cur[j], b[j]] = [diag, 0];
      else if (up <= left && up <= diag) [cur[j], b[j]] = [up, 1];
      else if (left <= diag) [cur[j], b[j]] = [left, 2];
      else [cur[j], b[j]] = [diag, 0];
    }
    back.push(b);
    prev = cur;
  }
  // 最後一列取分數最低、最早的位置（後面多出來的 hyp 不算）；再往回找 ref 最後一個字實際對到的 hyp 字
  let j = 0;
  for (let x = 1; x <= n; x++) if (prev[x] < prev[j]) j = x;
  let i = m;
  while (i > 0 && j > 0) {
    const step = back[i - 1][j];
    if (step === 0) return [i - 1, j - 1];
    if (step === 1) i--;
    else j--;
  }
  return null;
}
function analyze(events, map, clips, rec) {
  // 時鐘 → 播放時間：取前一個取樣點（比第一個還早就用第一個往回推），加上之後經過的時間（播放速度 1）
  const audioTime = (t) => {
    let best = map[0];
    for (const [mt, ct] of map) if (mt <= t) best = [mt, ct];
    return best[1] + (t - best[0]) / 1000;
  };
  // 每句的開頭（前 30 個字元）的雙字組
  const norm = (t) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
  const head = clips.map((c) => bigrams(norm(c.ref).slice(0, 30)));
  const share = (a, b) => [...a].filter((x) => b.has(x)).length;
  const per = clips.map((c) => ({ id: c.id, start: c.start, end: c.end, firstLive: null, final: null, tr: null, line: null,
    tailMissing: false }));
  const finalAt = new Map(); // 第幾行 → 時鐘
  const trAt = []; // [第幾行, 時鐘]
  let newChunkAt = null; // 上一行定稿出現的播放時間；之後第一個即時字幕是新的一段
  for (const e of events) {
    const at = audioTime(e.t);
    if (e.kind === 'live') {
      // 這句開始講話以後、下一句開始以前，第一個屬於這句的即時字幕。第一版常有錯字（「月面は」→「月名は」），
      // 所以不要求和原文一樣：上一行定稿後還沒有別的即時字幕，這句開始後的第一個即時字幕就是這句的新一段；
      // 上一句的尾巴還在同一段時（兩句併成一段），要等字幕裡出現這句開頭的字（至少一個相同的雙字組）。
      const k = clips.findIndex((c, i) => at >= c.start && at < (clips[i + 1]?.start ?? Infinity));
      const fresh = newChunkAt !== null;
      if (k >= 0 && per[k].firstLive === null && (fresh || share(bigrams(e.text), head[k]) >= 1)) {
        per[k].firstLive = at - clips[k].start;
      }
      newChunkAt = null;
    } else if (e.kind === 'final') {
      if (!finalAt.has(e.i)) finalAt.set(e.i, e.t);
      newChunkAt = at;
    } else if (e.kind === 'tr') {
      trAt.push([e.i, e.t]);
    }
  }
  // 定稿：側邊欄第 i 行就是這次錄音的第 i 段。一段可能是半句，也可能包含上一句的結尾和下一句的開頭，
  // 所以把這句原文對齊到定稿文字上（逐字的編輯距離，前後多出來的字不算），看原文最後一個對上的字在哪一行；
  // 那一行出現的時間減掉這句講完的時間就是「講完到定稿」。只拿這句開始以後 40 秒內出現的行來對。
  // （Whisper 標的段落時間不夠準：開頭是靜音時，段落開始常標在切段的位置，會早好幾秒。）
  const segs = rec.segments.map((g, i) => ({ ...g, a0: audioTime(rec.startedAt + g.start * 1000),
    a1: audioTime(rec.startedAt + g.end * 1000), shown: finalAt.get(i) }));
  clips.forEach((c, k) => {
    const window = segs.map((g, i) => [g, i]).filter(([g]) => g.shown !== undefined
      && audioTime(g.shown) > c.start && audioTime(g.shown) < c.end + 40);
    const hyp = [];
    const owner = [];
    for (const [g, i] of window) for (const ch of norm(g.text)) { hyp.push(ch); owner.push(i); }
    const end = alignEnd([...norm(c.ref)], hyp);
    if (end === null) return;
    const i = owner[end[1]];
    per[k].line = i;
    // 那一行在這句講完以前就出現了：這句的結尾沒有轉出來（例如 1901 的「in a machine」被切到下一段後沒轉出字），
    // 不算定稿時間，另外計數。一行最快也要停頓 0.4 秒加上轉文字的時間才會出現，所以講完前出現一定是少了結尾。
    if (audioTime(segs[i].shown) < c.end) {
      per[k].tailMissing = true;
      return;
    }
    per[k].final = audioTime(segs[i].shown) - c.end;
    // 這一行所在那組句子的譯文：第 i 行以後第一個出現的譯文
    const t = trAt.filter(([j]) => j >= i).map(([, at]) => at).sort((a, b) => a - b)[0];
    if (t !== undefined) per[k].tr = audioTime(t) - c.end;
  });
  const live = per.map((p) => p.firstLive).filter((x) => x !== null);
  const fin = per.map((p) => p.final).filter((x) => x !== null);
  const tr = per.map((p) => p.tr).filter((x) => x !== null);
  return {
    per: per.map((p) => ({ ...p, firstLive: round(p.firstLive), final: round(p.final), tr: round(p.tr) })),
    lines: segs.map((g) => ({ a0: round(g.a0), a1: round(g.a1), shown: g.shown === undefined ? null : round(audioTime(g.shown)), text: g.text })),
    summary: {
      live_median: round(median(live)), live_max: live.length ? round(Math.max(...live)) : null, live_n: live.length,
      final_median: round(median(fin)), final_max: fin.length ? round(Math.max(...fin)) : null, final_n: fin.length,
      tr_median: round(median(tr)), tr_max: tr.length ? round(Math.max(...tr)) : null, tr_n: tr.length,
      final_over3: fin.filter((x) => x > 3).length, tail_missing: per.filter((p) => p.tailMissing).length,
    },
  };
}

let ok = false;
try {
  const { id } = await cdp('Extensions.loadUnpacked', { path: path.resolve(opt.extension) });
  if (id !== EXPECTED_ID) throw new Error(`插件 ID 不對：${id}`);
  const page = await openTab(pageUrl);
  const panel = await openTab(`chrome-extension://${id}/sidepanel.html`);
  await evaluate(panel.sessionId, `chrome.storage.local.set({ language: ${JSON.stringify(opt.lang)}, bilingual: ${opt.bilingual === 'on'},
    overlay: true, ytCaptions: false, hints: {} })`);
  await cdp('Page.reload', {}, panel.sessionId);
  await sleep(1000);
  await evaluate(panel.sessionId, `(() => {
    window.__ev = [];
    const now = () => performance.timeOrigin + performance.now();
    let finals = 0, lastLive = '';
    const trDone = new Set();
    new MutationObserver(() => {
      const t = now();
      const live = document.querySelector('.line.live .src')?.textContent ?? '';
      if (live && live !== lastLive) window.__ev.push({ t, kind: 'live', text: live });
      lastLive = live;
      const lines = [...document.querySelectorAll('.line:not(.live)')];
      for (let i = finals; i < lines.length; i++) window.__ev.push({ t, kind: 'final', i, text: lines[i].querySelector('.src')?.textContent ?? '' });
      finals = Math.max(finals, lines.length);
      lines.forEach((l, i) => {
        if (!trDone.has(i) && l.querySelector('.tr')?.textContent) { trDone.add(i); window.__ev.push({ t, kind: 'tr', i }); }
      });
    }).observe(document.getElementById('transcript'), { childList: true, subtree: true, characterData: true });
  })()`);

  // 先開始錄音、等模型（和翻譯模型）載入好，再播放
  const { targetInfos } = await cdp('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.type === 'tab' && t.url === pageUrl);
  await cdp('Target.activateTarget', { targetId: page.targetId });
  await cdp('Extensions.triggerAction', { id, targetId: tab.targetId });
  const state = () => evaluate(panel.sessionId, `chrome.storage.session.get('state').then((s) => s.state ?? {})`);
  let st = {};
  for (let i = 0; i < 240; i++) {
    st = await state();
    if (st.status === 'recording' && st.host === 'ready' && (opt.bilingual !== 'on' || st.translator === 'ready')) break;
    if (st.status === 'error') throw new Error(`開始失敗：${st.message}`);
    await sleep(250);
  }
  if (st.host !== 'ready') throw new Error(`60 秒內模型沒有載入好：${JSON.stringify(st)}`);
  if (opt.cpu && st.device !== 'cpu') throw new Error(`--cpu 卻在用 ${st.device}`);
  log(`錄音中：${st.model} / ${st.device}${opt.bilingual === 'on' ? `，翻譯 ${st.translatorDevice}` : ''}；開始播放`);
  await evaluate(page.sessionId, `document.getElementById('a').play().then(() => true)`);
  // 播放期間每 0.5 秒看一次顯示記憶體：本機程式（python）和翻譯模型（llama-server）各自最高用多少 MiB
  const vram = {};
  const sampler = setInterval(() => {
    const r = spawnSync('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split('\n')) {
      const [pid, mib] = line.split(',').map((x) => x.trim());
      if (!pid || !mib) continue;
      let name = '';
      try { name = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
      const key = name.some((a) => a.endsWith('/host/transcriber_host.py')) ? 'host'
        : name[0]?.endsWith('/llama-server') ? 'translator' : null;
      if (key) vram[key] = Math.max(vram[key] ?? 0, Number(mib));
    }
  }, 500);
  // 播完再等一下，讓最後一句定稿和翻譯回來（CPU 轉得慢，可能還有幾段在排隊）
  await sleep((duration + (opt.cpu ? 30 : 10)) * 1000);
  clearInterval(sampler);
  const events = await evaluate(panel.sessionId, `window.__ev`);
  const map = await evaluate(page.sessionId, `window.__map`);
  const rec = await evaluate(panel.sessionId, `chrome.storage.local.get('recordings').then(({ recordings }) => {
    const r = recordings.at(-1);
    return { startedAt: r.startedAt, segments: r.segments.map((g) => ({ start: g.start, end: g.end, text: g.text })) };
  })`);
  await evaluate(panel.sessionId, `document.getElementById('toggle').click()`);
  await sleep(1500);

  if (opt.raw) fs.writeFileSync(opt.raw, JSON.stringify({ clips, events, map, rec }));
  // 側邊欄第 i 行要對到第 i 段，對不上的話定稿時間會算錯
  const finalLines = new Set(events.filter((e) => e.kind === 'final').map((e) => e.i)).size;
  if (finalLines !== rec.segments.length) throw new Error(`側邊欄有 ${finalLines} 行定稿，錄音紀錄有 ${rec.segments.length} 段，對不上`);
  const { per, lines, summary } = analyze(events, map, clips, rec);
  const commit = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const row = {
    lang: opt.lang, label: opt.label, bilingual: opt.bilingual === 'on', model: st.model, device: st.device,
    translator: opt.bilingual === 'on' ? st.translatorDevice : null, clips: clips.length, gap_s: Number(opt.gap),
    ...summary, vram_mib: vram, host_commit: commit, date: new Date().toLocaleDateString('sv-SE'), per, lines,
  };
  fs.appendFileSync(opt.out, JSON.stringify(row) + '\n');
  const { per: _, lines: __, ...brief } = row;
  log(JSON.stringify(brief));
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
