// Tab Transcriber 背景程式：管錄音流程、把錄到的聲音轉送給本機 Whisper，再把文字寫進 storage 讓側邊欄顯示。
//
// 資料放哪裡：
//   chrome.storage.session.state     目前狀態（側邊欄讀它顯示「錄音中」等）
//   chrome.storage.local.recordings  文字稿 [{ id, title, url, language, startedAt, segments: [{ start, end, text }] }]
//   chrome.storage.local.language    側邊欄選的語言（en | ja），下次開始錄音時生效
// 即時字幕（還沒講完的那一句）每秒更新，不寫 storage，直接用 runtime 訊息 { type: 'caption' } 推給側邊欄。

const HOST_NAME = 'com.tab_transcriber.host';
const OFFSCREEN_URL = 'offscreen.html';
const HOST_CONNECT_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 120_000;
const HOST_LOG = '~/.cache/tab-transcriber/host.log';

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
};

let port = null; // 和本機程式的連線，只在錄音期間存在
let rec = null; // 目前這次錄音 { id, tabId, pending, stopping, captureDone, lastFinalId, partialInFlight, queuedPartial }
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

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open 只能在點擊當下呼叫，前面不能先 await。
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  if (!rec) start(tab);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === 'offscreen') return;
  switch (msg.type) {
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
        if (keep) list.push({ ...keep, segments: [] });
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'chunk':
      onChunk(msg);
      break;
    case 'partial':
      onPartial(msg);
      break;
    case 'partial-reset':
      if (rec) rec.queuedPartial = null;
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
  };
  const { language = 'en' } = await chrome.storage.local.get('language');
  await setState({ ...IDLE, status: 'starting', tabId: tab.id, title: tab.title ?? '', recId: id, language });
  try {
    await ensureOffscreen();
    // 先拿分頁音訊：這一步最常因為「沒在那個分頁點圖示」失敗，失敗就不必啟動 Whisper。
    // 拿到的 streamId 幾秒內沒用就失效，本機程式約 0.1 秒就會回第一則訊息，來得及。
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await connectHost();
    port.postMessage({ type: 'start', language });
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
  } catch (err) {
    await fail(explain(err));
  }
}

function stop() {
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  setState({ status: 'stopping' });
  stopTimer = setTimeout(() => finish('最後幾段等太久沒有轉完，已略過。'), STOP_TIMEOUT_MS);
  // 錄音頁會先把手上最後一段送出，再回 'stopped'；等排隊的段落都轉完才收尾（maybeFinish）。
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
}

function onCaptureDone(reason) {
  if (!rec) return;
  if (!rec.stopping) {
    // 不是使用者按停止：分頁關掉或換頁了。
    rec.stopping = true;
    stopTimer = setTimeout(() => finish('最後幾段等太久沒有轉完，已略過。'), STOP_TIMEOUT_MS);
    setState({ status: 'stopping', message: reason === 'ended' ? '分頁已關閉或換頁，錄音已停止。' : '' });
  }
  rec.captureDone = true;
  maybeFinish();
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
}

function onHostMessage(msg) {
  if (!rec) return;
  if (msg.type === 'status') {
    setState(msg.state === 'ready' ? { host: 'ready', model: msg.model, device: msg.device } : { host: 'loading' });
  } else if (msg.type === 'partial') {
    rec.partialInFlight = false;
    // 定稿已經回來的段落，晚到的即時字幕就不顯示了。
    if (msg.id > rec.lastFinalId && msg.text) sendCaption({ id: msg.id, offset: msg.offset, text: msg.text });
    const next = rec.queuedPartial;
    rec.queuedPartial = null;
    if (next) onPartial(next);
  } else if (msg.type === 'segments' || (msg.type === 'error' && msg.id != null)) {
    const recId = rec.id;
    rec.lastFinalId = Math.max(rec.lastFinalId, msg.id);
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
  if (rec?.stopping && rec.captureDone && rec.pending === 0) finish();
}

async function finish(message) {
  clearTimeout(stopTimer);
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
    return '找不到本機轉文字程式。請先在終端機執行 tab-transcriber/install.sh，再按開始。';
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
