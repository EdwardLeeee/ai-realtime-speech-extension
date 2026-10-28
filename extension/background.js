// Tab Transcriber 背景程式：管錄音流程、把錄到的聲音轉送給本機 Whisper，再把文字寫進 storage 讓側邊欄顯示。
//
// 資料放哪裡：
//   chrome.storage.session.state     目前狀態（側邊欄讀它顯示「錄音中」等）
//   chrome.storage.local.recordings  文字稿 [{ id, title, url, language, startedAt, segments: [{ start, end, text, translation? }] }]
//   chrome.storage.local.language    側邊欄選的語言（en | ja | th），下次開始錄音時生效
//   chrome.storage.local.bilingual   雙語字幕開關；錄音中切換會馬上通知本機程式啟動或關掉翻譯模型
//   chrome.storage.local.ytCaptions  「YouTube 字幕」開關：開著時，在有 CC 的 YouTube 影片上直接用播放器的字幕，不錄音、不跑 Whisper
//   chrome.storage.local.hints       各語言的專有名詞 { en: 'donk, MOUZ', ja: '…' }，放在 Whisper 提示最前面；錄音中改了馬上通知本機程式
//   chrome.storage.local.overlay     網頁字幕開關（預設開）；overlayPos、overlaySize 是網頁字幕的位置和使用者拖出來的大小，由 caption-overlay.js 存
// 即時字幕（還沒講完的那一句）每秒更新，不寫 storage，直接用 runtime 訊息 { type: 'caption' } 推給側邊欄，
// 它的譯文用 { type: 'caption-translation' }。
// 網頁字幕（caption-overlay.js）注入在被錄的分頁裡，用 tabs.sendMessage 推上一句定稿和正在講的這一句；
// YouTube 字幕：yt-caption-hook.js（頁面的 world）看播放器自己抓的字幕檔，yt-caption-bridge.js 把整份交過來
// （{ type: 'yt-track' }），一開始就整份放進文字稿；之後照影片播放時間用 { type: 'yt-cue' } 說現在播到哪一句，
// 網頁字幕和側邊欄跟著走（state.now）。這時不開錄音頁、不載入 Whisper，本機程式只在雙語字幕開著時負責翻譯：
// 先翻好現在這一句之後 LOOKAHEAD_S 秒內的句子，拖了進度條就改翻新的位置。
// 分頁換頁（整頁重新載入）後原本的字幕框就不見了，載入完再注入一次。換頁不會讓分頁錄音結束（2026-10 Brave 155 實測，
// 同網站、換網站、brave:// 頁都一樣），所以錄音照常，只要補字幕框。

const HOST_NAME = 'com.tab_transcriber.host';
const OFFSCREEN_URL = 'offscreen.html';
const HOST_CONNECT_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 120_000;
const HOST_LOG = '~/.cache/tab-transcriber/host.log';
const CC_WAIT_MS = 10_000; // YouTube 字幕模式開始（或換影片）後這麼久還沒收到字幕，就提示打開 CC
const LOOKAHEAD_S = 60; // YouTube 字幕模式：先翻好影片接下來這麼多秒的字幕
// 和本機程式湊句子的規則一樣（transcriber_host.py 的 SENTENCE_END）：英文、日文等到句尾，最多三句一組；其他語言一句一組
const SENTENCE_END = { en: /[.?!…]["')\]]*$/, ja: /[。？！?!」』）…]$/ };
const MAX_UNIT_CUES = 3;

const IDLE = {
  status: 'idle', // idle | starting | recording | stopping | error
  host: null, // null | loading | ready
  model: '',
  device: '',
  language: 'en',
  message: '',
  tabId: null,
  title: '',
  recId: null,
  startedAt: null,
  pending: 0,
  translator: null, // null（雙語字幕關著）| loading | ready
  translatorDevice: '', // gpu | cpu
  source: '', // whisper | youtube（YouTube 字幕）
  now: null, // YouTube 字幕模式：影片現在播到的那一句 { videoId, start }，側邊欄標出來
};

let port = null; // 和本機程式的連線，只在錄音期間存在
let rec = null; // 目前這次錄音 { id, tabId, pending, stopping, captureDone, lastFinalId, partialInFlight, queuedPartial, translate, flushPending, overlay, lines }
// YouTube 字幕模式另外有 { captions, videos, videoId, now, trackSeq, trWrites, trTimer, ccTimer, closeCaptions }
let stopTimer = null;
let writes = Promise.resolve(); // 依序寫 storage，避免同時讀改寫互相蓋掉

function enqueue(fn) {
  writes = writes.then(fn).catch((err) => console.error(err));
  return writes;
}

function setState(patch) {
  return enqueue(async () => {
    const { state = IDLE } = await chrome.storage.session.get('state');
    await chrome.storage.session.set({ state: { ...state, ...patch } });
  });
}

function updateRecordings(fn) {
  return enqueue(async () => {
    const { recordings = [] } = await chrome.storage.local.get('recordings');
    fn(recordings);
    await chrome.storage.local.set({ recordings });
  });
}

// 背景程式被瀏覽器重啟時，記憶體裡的錄音已經不在了，把殘留的「錄音中」狀態收掉。
chrome.storage.session.get('state').then(async ({ state }) => {
  if (!rec && ['starting', 'recording', 'stopping'].includes(state?.status)) {
    await closeOffscreen();
    await setState({ ...IDLE, status: 'error', message: '瀏覽器重新啟動了背景程式，錄音已中斷。請再按一次開始。' });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bilingual) setTranslate(Boolean(changes.bilingual.newValue));
  if (area === 'local' && changes.overlay) setOverlay(changes.overlay.newValue !== false);
  if (area === 'local' && changes.hints && rec && port && !rec.stopping) {
    port.postMessage({ type: 'hints', text: changes.hints.newValue?.[rec.language] ?? '' });
  }
});

// YouTube 字幕模式沒有錄音頁，分頁關掉要自己發現。
chrome.tabs.onRemoved.addListener((tabId) => {
  if (rec?.captions && rec.tabId === tabId) onCaptureDone('ended');
});

// 被錄的分頁載入完一頁就補上字幕框（字幕框自己會擋重複注入；YouTube 換影片這種不重新載入整頁的，字幕框本來就還在）。
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (rec?.tabId !== tabId || info.status !== 'complete' || rec.stopping) return;
  const { overlay = true } = await chrome.storage.local.get('overlay');
  if (overlay && rec?.tabId === tabId && !rec.stopping) injectOverlay();
});

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open 只能在點擊當下呼叫，前面不能先 await。
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  if (!rec) start(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'yt-hello': // YouTube 分頁重新整理後問還在不在錄它
      sendResponse({ active: Boolean(rec?.captions && !rec.stopping && sender.tab?.id === rec.tabId) });
      break;
    case 'yt-track':
      if (rec?.captions && !rec.stopping && sender.tab?.id === rec.tabId) onTrack(msg);
      break;
    case 'yt-cue':
      if (rec?.captions && !rec.stopping && sender.tab?.id === rec.tabId) onCue(msg);
      break;
    case 'yt-video':
      if (rec?.captions && !rec.stopping && sender.tab?.id === rec.tabId) onVideo(msg);
      break;
    case 'yt-cc': // CC 是插件幫忙打開的，停止時關回去
      if (rec?.captions && sender.tab?.id === rec.tabId) rec.closeCaptions = true;
      break;
    case 'start':
      chrome.tabs.query({ active: true, windowId: msg.windowId }).then(([tab]) => tab && start(tab));
      break;
    case 'stop':
      stop();
      break;
    case 'clear':
      updateRecordings((list) => {
        const keep = list.find((r) => r.id === rec?.id);
        list.length = 0;
        // YouTube 字幕模式的文字稿是整部影片的字幕，清掉就不會再來，所以只清以前的錄音
        if (keep) list.push(rec.captions ? keep : { ...keep, segments: [] });
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'chunk':
      onChunk(msg);
      break;
    case 'partial':
      onPartial(msg);
      break;
    case 'partial-reset':
      if (!rec) break;
      rec.queuedPartial = null;
      sendCaption(null);
      break;
    case 'stopped':
    case 'ended':
      onCaptureDone(msg.type);
      break;
    case 'capture-error':
      fail(msg.message);
      break;
  }
});

async function start(tab) {
  if (rec) return;
  const id = Date.now();
  rec = {
    id,
    tabId: tab.id,
    pending: 0,
    stopping: false,
    captureDone: false,
    lastFinalId: 0,
    partialInFlight: false,
    queuedPartial: null,
    language: 'en',
    translate: false,
    flushPending: false,
    overlay: false, // 網頁字幕已經注入分頁
    lines: { prev: null, live: null }, // 網頁字幕顯示的上一句定稿 { start, text, tr } 和即時字幕 { id, text, tr }
  };
  const { language = 'en', ytCaptions = false } = await chrome.storage.local.get(['language', 'ytCaptions']);
  rec.language = language;
  await setState({ ...IDLE, status: 'starting', tabId: tab.id, title: tab.title ?? '', recId: id, language });
  // 只有 YouTube 分頁裡有 yt-caption-bridge.js 會回答
  const probe = ytCaptions
    ? await chrome.tabs.sendMessage(tab.id, { target: 'yt-captions', type: 'probe' }, { frameId: 0 }).catch(() => null)
    : null;
  if (probe?.youtube) return startCaptions(tab, probe.track);
  try {
    await ensureOffscreen();
    // 先拿分頁音訊：這一步最常因為「沒在那個分頁點圖示」失敗，失敗就不必啟動 Whisper。
    // 拿到的 streamId 幾秒內沒用就失效，本機程式約 0.1 秒就會回第一則訊息，來得及。
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await connectHost();
    const { bilingual = false, hints = {} } = await chrome.storage.local.get(['bilingual', 'hints']);
    rec.translate = bilingual;
    port.postMessage({ type: 'start', language, translate: bilingual, hints: hints[language] ?? '' });
    if (bilingual) setState({ translator: 'loading' });
    const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId });
    if (!reply?.ok) throw new Error(reply?.error ?? '無法開始錄音');
    const startedAt = Date.now();
    await updateRecordings((list) =>
      list.push({ id, title: tab.title ?? '', url: tab.url ?? '', language, startedAt, segments: [] }),
    );
    const muted = reply.playback !== 'running';
    await setState({
      status: 'recording',
      startedAt,
      message: muted ? '正在錄音，但瀏覽器沒讓聲音播回喇叭；在分頁上點一下再試，或停止後重新開始。' : '',
    });
    const { overlay = true } = await chrome.storage.local.get('overlay');
    setOverlay(overlay);
  } catch (err) {
    await fail(explain(err));
  }
}

// YouTube 字幕模式：不錄音、不載入 Whisper；本機程式只用來翻譯（雙語字幕開著時）。
async function startCaptions(tab, track) {
  const { id } = rec;
  rec.captions = true;
  rec.videos = new Map(); // videoId → 這部影片的字幕（makeVideo）
  rec.videoId = null; // 分頁現在的影片
  rec.now = null; // 現在播到的那一句 { videoId, index }
  rec.trackSeq = 0;
  rec.trWrites = []; // 還沒寫進 storage 的譯文
  rec.trTimer = null;
  rec.closeCaptions = false;
  const lang = track?.lang ?? '';
  try {
    await connectHost();
    const { bilingual = false } = await chrome.storage.local.get('bilingual');
    rec.translate = bilingual;
    port.postMessage({ type: 'start', whisper: false, language: lang || 'auto', translate: bilingual });
    if (bilingual) setState({ translator: 'loading' });
    const startedAt = Date.now();
    await updateRecordings((list) =>
      list.push({ id, title: tab.title ?? '', url: tab.url ?? '', language: lang, source: 'youtube', startedAt, segments: [] }),
    );
    await setState({ status: 'recording', startedAt, source: 'youtube', model: ccLabel(track), device: '' });
    await chrome.tabs.sendMessage(tab.id, { target: 'yt-captions', type: 'start' }, { frameId: 0 });
    armCaptionsPrompt();
    const { overlay = true } = await chrome.storage.local.get('overlay');
    setOverlay(overlay);
  } catch (err) {
    await fail(explain(err));
  }
}

function ccLabel(track) {
  if (!track) return 'YouTube 字幕';
  return `YouTube ${track.asr ? '自動字幕' : '字幕'}${track.lang ? `（${track.lang}）` : ''}`;
}

// 開始或換影片後 CC_WAIT_MS 還沒拿到這部影片的字幕，就提示（CC 是插件幫忙按的，按不到或影片本來就沒有字幕都會走到這裡）
function armCaptionsPrompt() {
  clearTimeout(rec.ccTimer);
  const { id } = rec;
  rec.ccTimer = setTimeout(() => {
    if (rec?.id === id && !rec.stopping && !rec.videos.has(rec.videoId)) {
      setState({ message: '還沒收到 YouTube 字幕：這部影片可能沒有字幕。有的話，請在播放器打開 CC；已經打開的話，重新整理網頁或換一次字幕語言。' });
    }
  }, CC_WAIT_MS);
}

// 一部影片的字幕：cues 照時間排；units 是一起翻的幾句（譯文放在最後一句），unitOf[i] 是第 i 句屬於哪一組；
// tr 是已經翻好的組 → 譯文，queued 是已經交給本機程式、還沒翻回來的組。tag 每換一次字幕就換，晚到的舊譯文會認得出來。
function makeVideo(videoId, track, cues) {
  const base = track.lang.split('-')[0].toLowerCase();
  const end = SENTENCE_END[base];
  const units = [];
  const unitOf = [];
  let first = 0;
  cues.forEach((c, i) => {
    unitOf.push(units.length);
    if (!end || end.test(c.text) || i - first + 1 >= MAX_UNIT_CUES || i === cues.length - 1) {
      const text = cues.slice(first, i + 1).map((x) => x.text).join(base === 'ja' ? '' : ' ');
      units.push({ first, last: i, text });
      first = i + 1;
    }
  });
  return { id: videoId, lang: track.lang, asr: track.asr, cues, units, unitOf, tr: new Map(), queued: new Set(),
    tag: `${videoId}#${++rec.trackSeq}` };
}

// 拿到整份字幕：放進文字稿（一開始就是整部影片），同一部影片換了字幕語言就換掉它原本的那幾行。
function onTrack(msg) {
  const { videoId } = msg;
  const cues = (msg.cues ?? []).filter((c) => Number.isFinite(c?.start) && c.text).sort((a, b) => a.start - b.start);
  if (!videoId || !cues.length) return;
  const track = { lang: String(msg.lang ?? ''), asr: Boolean(msg.asr) };
  const old = rec.videos.get(videoId);
  // 同一份字幕又抓了一次（重新整理網頁、換畫質）：一樣就不動，譯文留著
  if (old && old.lang === track.lang && old.asr === track.asr && old.cues.length === cues.length &&
      old.cues.every((c, i) => c.start === cues[i].start && c.text === cues[i].text)) return;
  writeTranslations(); // 先寫掉舊字幕手上的譯文，免得寫到新字幕同一個時間的句子
  const video = makeVideo(videoId, track, cues);
  if (old && old.lang === track.lang && old.asr === track.asr) {
    // 同一份字幕多了或改了幾句：沒變的組，譯文留著
    const known = new Map(old.units.map((u, k) => [`${old.cues[u.last].start}|${u.text}`, old.tr.get(k)]));
    video.units.forEach((u, k) => {
      const tr = known.get(`${cues[u.last].start}|${u.text}`);
      if (tr) video.tr.set(k, tr);
    });
  }
  const trByStart = new Map([...video.tr].map(([k, tr]) => [cues[video.units[k].last].start, tr]));
  rec.videos.set(videoId, video);
  clearTimeout(rec.ccTimer);
  setState({ model: ccLabel(track), message: '' });
  const recId = rec.id;
  updateRecordings((list) => {
    const r = list.find((x) => x.id === recId);
    if (!r) return;
    if (track.lang) r.language = track.lang;
    const segs = cues.map((c) => ({ start: c.start, end: c.end, text: c.text, videoId,
      ...(trByStart.has(c.start) ? { translation: trByStart.get(c.start) } : {}) }));
    const at = r.segments.findIndex((s) => s.videoId === videoId);
    const rest = r.segments.filter((s) => s.videoId !== videoId);
    r.segments = at < 0 ? [...rest, ...segs] : [...rest.slice(0, at), ...segs, ...rest.slice(at)];
  });
  // 換了字幕語言：現在的位置換成新字幕裡同一個時間的那一句，從那裡開始翻（bridge 接著也會重送現在這一句）
  if (rec.now?.videoId === videoId) {
    const t = old.cues[rec.now.index].start;
    const index = cues.findLastIndex((c) => c.start <= t);
    rec.now = index < 0 ? null : { videoId, index };
  }
  feedTranslator(true);
}

function onVideo(msg) {
  rec.videoId = msg.videoId;
  rec.now = null;
  rec.lines = { prev: null, live: null };
  pushOverlay();
  const video = rec.videos.get(msg.videoId);
  setState({ now: null, ...(video ? { model: ccLabel(video) } : {}) });
  if (!video) armCaptionsPrompt();
}

function onCue(msg) {
  const video = rec.videos.get(msg.videoId);
  if (!video) return;
  const index = msg.start === null ? -1 : video.cues.findIndex((c) => c.start === msg.start);
  rec.now = index < 0 ? null : { videoId: msg.videoId, index };
  setState({ now: rec.now && { videoId: msg.videoId, start: msg.start } });
  showCues();
  feedTranslator(Boolean(msg.seeked));
}

// 網頁字幕：影片現在這一句和前一句。一組句子的譯文一開始就看得到，放在這一組最下面那一行。
function showCues() {
  const video = rec.videos.get(rec.now?.videoId);
  if (!video) {
    rec.lines = { prev: null, live: null };
    return pushOverlay();
  }
  const i = rec.now.index;
  const line = (k, tr) => ({ start: video.cues[k].start, text: video.cues[k].text, tr: tr ? video.tr.get(video.unitOf[k]) ?? '' : '' });
  rec.lines = {
    prev: i > 0 ? line(i - 1, video.unitOf[i - 1] !== video.unitOf[i]) : null,
    live: line(i, true),
  };
  pushOverlay();
}

// 先翻好現在這一句之後 LOOKAHEAD_S 秒內還沒翻的組。拖了進度條（或剛開始、剛換字幕）就請本機程式丟掉排隊中的，
// 照新的位置重排；連續播放時只補新進到範圍裡的。
function feedTranslator(replace) {
  if (!rec?.captions || !rec.translate || !port || rec.stopping) return;
  const video = rec.videos.get(rec.now?.videoId ?? rec.videoId);
  if (!video) return;
  if (replace) for (const v of rec.videos.values()) v.queued.clear();
  const from = rec.now ? video.unitOf[rec.now.index] : 0;
  const until = (rec.now ? video.cues[rec.now.index].start : 0) + LOOKAHEAD_S;
  const send = [];
  for (let k = from; k < video.units.length && video.cues[video.units[k].first].start <= until; k++) {
    if (!video.tr.has(k) && !video.queued.has(k)) send.push(k);
  }
  if (!send.length && !replace) return;
  for (const k of send) video.queued.add(k);
  const segments = send.map((k) => {
    const last = video.cues[video.units[k].last];
    return { start: last.start, end: last.end, text: video.units[k].text };
  });
  port.postMessage({ type: 'text', tag: video.tag, replace, segments });
}

function onCaptionTranslation(msg) {
  const video = [...rec.videos.values()].find((v) => v.tag === msg.tag);
  const k = video?.units.findIndex((u) => video.cues[u.last].start === msg.start) ?? -1;
  if (k < 0) return; // 換字幕語言以前送出的
  video.queued.delete(k);
  video.tr.set(k, msg.text);
  rec.trWrites.push({ videoId: video.id, start: msg.start, text: msg.text });
  rec.trTimer ??= setTimeout(writeTranslations, 300);
  if (rec.now?.videoId === video.id) showCues();
  feedTranslator(false);
}

// 譯文一次可能回來好幾組，集中起來寫 storage（每次都整份重寫）
function writeTranslations() {
  if (!rec?.captions) return;
  clearTimeout(rec.trTimer);
  rec.trTimer = null;
  const items = rec.trWrites.splice(0);
  if (!items.length) return;
  const recId = rec.id;
  updateRecordings((list) => {
    const segments = list.find((r) => r.id === recId)?.segments ?? [];
    for (const it of items) {
      const seg = segments.find((s) => s.videoId === it.videoId && s.start === it.start);
      if (seg) seg.translation = it.text;
    }
  });
}

function stop() {
  if (!rec || rec.stopping) return;
  if (rec.captions) {
    stopBridge();
    onCaptureDone('stopped');
    return;
  }
  rec.stopping = true;
  setState({ status: 'stopping' });
  stopTimer = setTimeout(() => finish('最後幾段等太久沒有轉完，已略過。'), STOP_TIMEOUT_MS);
  // 錄音頁會先把手上最後一段送出，再回 'stopped'；等排隊的段落都轉完才收尾（maybeFinish）。
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
}

function onCaptureDone(reason) {
  if (!rec) return;
  if (!rec.stopping) {
    // 不是使用者按停止：分頁關掉了（換頁不會）。YouTube 字幕模式按停止也走這裡。
    rec.stopping = true;
    stopTimer = setTimeout(() => finish('最後幾段等太久沒有轉完，已略過。'), STOP_TIMEOUT_MS);
    setState({ status: 'stopping', message: reason === 'ended' ? '分頁已關閉，錄音已停止。' : '' });
  }
  rec.captureDone = true;
  // 錄音頁的最後一段已經比 'stopped' 先送進本機程式，所以 flush 一定排在所有定稿後面。
  // YouTube 字幕模式不等：排隊的是還沒播到的句子，停了就不用翻。
  if (rec.translate && port && !rec.captions) {
    rec.flushPending = true;
    port.postMessage({ type: 'flush' });
  }
  maybeFinish();
}

// 側邊欄切換雙語字幕：錄音中就通知本機程式；收尾時不再切換，免得等不到 flushed。
function setTranslate(on) {
  if (!rec || !port || rec.stopping || rec.translate === on) return;
  rec.translate = on;
  port.postMessage({ type: 'translate', enabled: on });
  if (rec.captions) {
    if (on) feedTranslator(true);
    else for (const v of rec.videos.values()) v.queued.clear(); // 本機程式關掉翻譯時把排隊的都丟了
  } else if (!on) {
    sendCaptionTranslation(null);
  }
  pushOverlay();
  setState({ translator: on ? 'loading' : null, translatorDevice: '' });
}

function onChunk(msg) {
  if (!rec || !port) return;
  port.postMessage({ type: 'audio', id: msg.id, offset: msg.offset, pcm: msg.pcm });
  rec.pending += 1;
  setState({ pending: rec.pending });
}

// 即時字幕：同一時間只讓一段未完成的聲音在本機程式裡轉，轉的期間來的新段落只留最新一段。
function onPartial(msg) {
  if (!rec || !port || rec.stopping || msg.id <= rec.lastFinalId) return;
  if (rec.partialInFlight) {
    rec.queuedPartial = msg;
    return;
  }
  rec.partialInFlight = true;
  port.postMessage({ type: 'partial', id: msg.id, offset: msg.offset, pcm: msg.pcm });
}

function sendCaption(caption) {
  chrome.runtime.sendMessage({ type: 'caption', recId: rec?.id ?? null, ...(caption ?? { text: '' }) }).catch(() => {});
  const live = rec.lines.live;
  rec.lines.live = caption ? { id: caption.id, text: caption.text, tr: live?.id === caption.id ? live.tr : '' } : null;
  pushOverlay();
}

function sendCaptionTranslation(tr) {
  chrome.runtime
    .sendMessage({ type: 'caption-translation', recId: rec?.id ?? null, ...(tr ?? { text: '' }) })
    .catch(() => {});
  const live = rec.lines.live;
  if (live && (!tr || tr.id === live.id)) live.tr = tr?.text ?? '';
  pushOverlay();
}

// 網頁字幕：錄音中打開就注入分頁，關掉就請它移除自己。
async function setOverlay(on) {
  if (!rec || rec.overlay === on) return;
  if (on) return injectOverlay();
  rec.overlay = false;
  removeOverlay(rec.tabId);
}

// 點圖示拿到的 activeTab 換到別的網站就失效，所以 manifest 要了所有網站的權限，換網站後也能注入。
async function injectOverlay() {
  const { tabId } = rec;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['caption-overlay.js'] });
  } catch (err) {
    // brave:// 這類內部頁面不能注入；回到一般網頁、載入完時會再注入。
    console.warn('網頁字幕注入失敗', err);
    return;
  }
  if (rec?.tabId !== tabId) return removeOverlay(tabId);
  rec.overlay = true;
  pushOverlay();
}

function removeOverlay(tabId) {
  chrome.tabs.sendMessage(tabId, { target: 'overlay', type: 'remove' }, { frameId: 0 }).catch(() => {});
}

function pushOverlay() {
  if (!rec?.overlay) return;
  const lines = [rec.lines.prev, rec.lines.live]
    .filter((l) => l?.text)
    .map((l) => ({ text: l.text, tr: rec.translate ? l.tr : '' }));
  chrome.tabs.sendMessage(rec.tabId, { target: 'overlay', type: 'update', lines }, { frameId: 0 }).catch(() => {});
}

function onHostMessage(msg) {
  if (!rec) return;
  if (msg.type === 'status') {
    if (rec.captions) setState({ host: msg.state === 'ready' ? 'ready' : 'loading' }); // 模型欄顯示字幕來源
    else setState(msg.state === 'ready' ? { host: 'ready', model: msg.model, device: msg.device } : { host: 'loading' });
  } else if (msg.type === 'partial') {
    rec.partialInFlight = false;
    // 定稿已經回來的段落，晚到的即時字幕就不顯示了。
    if (msg.id > rec.lastFinalId && msg.text) sendCaption({ id: msg.id, offset: msg.offset, text: msg.text });
    const next = rec.queuedPartial;
    rec.queuedPartial = null;
    if (next) onPartial(next);
  } else if (msg.type === 'translator') {
    if (msg.state === 'error') {
      // 翻譯用不了（沒安裝、啟動失敗）：把開關關回去，轉文字照常繼續。
      rec.translate = false;
      setState({ translator: null, translatorDevice: '', message: msg.message });
      chrome.storage.local.set({ bilingual: false });
    } else if (rec.translate && msg.state !== 'off') {
      setState({ translator: msg.state, translatorDevice: msg.device ?? '' });
    }
  } else if (msg.type === 'translation' && rec.captions) {
    onCaptionTranslation(msg);
  } else if (msg.type === 'translation') {
    const recId = rec.id;
    updateRecordings((list) => {
      const seg = list.find((r) => r.id === recId)?.segments.findLast((s) => s.start === msg.start);
      if (seg) seg.translation = msg.text;
    });
    for (const line of [rec.lines.prev, rec.lines.live]) {
      if (line?.start === msg.start) {
        line.tr = msg.text;
        pushOverlay();
      }
    }
  } else if (msg.type === 'partial-translation') {
    if (rec.translate && msg.id > rec.lastFinalId && msg.text) sendCaptionTranslation({ id: msg.id, text: msg.text });
  } else if (msg.type === 'flushed') {
    rec.flushPending = false;
    maybeFinish();
  } else if (msg.type === 'segments' || (msg.type === 'error' && msg.id != null)) {
    const recId = rec.id;
    rec.lastFinalId = Math.max(rec.lastFinalId, msg.id);
    const last = msg.segments?.at(-1);
    if (last) rec.lines.prev = { start: last.start, text: last.text, tr: '' };
    sendCaption(null);
    rec.pending = Math.max(0, rec.pending - 1);
    if (msg.segments?.length) {
      updateRecordings((list) => list.find((r) => r.id === recId)?.segments.push(...msg.segments));
    }
    setState({ pending: rec.pending, ...(msg.type === 'error' ? { message: msg.message } : {}) });
    maybeFinish();
  } else if (msg.type === 'error') {
    fail(msg.message);
  }
}

function maybeFinish() {
  if (rec?.stopping && rec.captureDone && rec.pending === 0 && !rec.flushPending) finish();
}

function stopBridge() {
  chrome.tabs.sendMessage(rec.tabId, { target: 'yt-captions', type: 'stop', closeCaptions: rec.closeCaptions },
    { frameId: 0 }).catch(() => {});
}

async function finish(message) {
  clearTimeout(stopTimer);
  clearTimeout(rec?.ccTimer);
  writeTranslations();
  if (rec) removeOverlay(rec.tabId);
  port?.disconnect();
  port = null;
  rec = null;
  await closeOffscreen();
  // 沒有新訊息就保留原本的（例如「分頁已關閉」），所以在佇列裡讀了再寫。
  await enqueue(async () => {
    const { state } = await chrome.storage.session.get('state');
    await chrome.storage.session.set({ state: { ...IDLE, message: message ?? state?.message ?? '' } });
  });
}

async function fail(message) {
  clearTimeout(stopTimer);
  clearTimeout(rec?.ccTimer);
  writeTranslations();
  if (rec?.captions) stopBridge();
  if (rec) removeOverlay(rec.tabId);
  port?.disconnect();
  port = null;
  rec = null;
  await closeOffscreen();
  await setState({ ...IDLE, status: 'error', message });
}

function connectHost() {
  return new Promise((resolve, reject) => {
    const p = chrome.runtime.connectNative(HOST_NAME);
    port = p;
    let settled = false;
    const timer = setTimeout(() => settle(new Error('本機轉文字程式沒有回應')), HOST_CONNECT_TIMEOUT_MS);
    function settle(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    }
    p.onMessage.addListener((msg) => {
      settle();
      onHostMessage(msg);
    });
    p.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message ?? '';
      if (port !== p) return;
      port = null;
      if (!settled) return settle(new Error(why || '本機轉文字程式啟動失敗'));
      if (rec) fail(`本機轉文字程式意外結束（${why || '沒有說明'}）。詳細原因在 ${HOST_LOG}。`);
    });
  });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: '錄下分頁播放的聲音，轉成文字稿',
  });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument().catch(() => {});
}

function explain(err) {
  const text = err?.message ?? String(err);
  if (/native messaging host not found/i.test(text)) {
    return '找不到本機轉文字程式。請先在終端機執行 tab-transcriber/install.sh（Windows 是 install.ps1），再按開始。';
  }
  if (/not been invoked|activeTab/i.test(text)) {
    return '請切到要轉文字的分頁，點工具列上的 Tab Transcriber 圖示開始（換過網頁要再點一次）。';
  }
  if (/chrome pages cannot be captured|cannot capture/i.test(text)) {
    return '瀏覽器內部頁面（設定、擴充功能頁）不能錄音，請在一般網頁上使用。';
  }
  if (/active stream/i.test(text)) {
    return '這個分頁已經被別的程式錄音中，請先關掉那邊。';
  }
  return text;
}
