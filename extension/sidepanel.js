// 側邊欄：顯示錄音狀態和文字稿，提供開始／停止、雙語字幕開關、複製、下載、清除。
// 狀態和文字稿都由背景程式寫進 storage，這裡只負責讀出來畫。
// 按「放大」時，同一個頁面會再開在獨立視窗裡（網址帶 ?window=原本瀏覽器視窗的 id）。

const $ = (id) => document.getElementById(id);
const ACTIVE = ['starting', 'recording', 'stopping'];
const LANGUAGE_NAMES = { en: '英文', ja: '日文', th: '泰文' };
const TEXT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];
const hostWindowId = Number(new URLSearchParams(location.search).get('window')) || null;
const inWindow = hostWindowId !== null;
// 側邊欄和獨立視窗各記各的字體大小，視窗預設大一點。
const TEXT_SIZE_KEY = inWindow ? 'windowTextSize' : 'textSize';
const DEFAULT_TEXT_SIZE = inWindow ? 18 : 14;

let state = {};
let recordings = [];
let language = 'en';
let bilingual = false; // 雙語字幕開關：開著才顯示（和複製、下載）譯文
let textSize = DEFAULT_TEXT_SIZE;
let caption = null; // 還沒講完那一句的即時字幕 { recId, id, offset, text }
let captionTr = null; // 即時字幕的譯文 { recId, id, text }
let clearArmed = null;

async function load() {
  ({ state = {} } = await chrome.storage.session.get('state'));
  ({
    recordings = [],
    language = 'en',
    bilingual = false,
    [TEXT_SIZE_KEY]: textSize = DEFAULT_TEXT_SIZE,
  } = await chrome.storage.local.get(['recordings', 'language', 'bilingual', TEXT_SIZE_KEY]));
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.state) state = changes.state.newValue ?? {};
  if (area === 'local' && changes.recordings) recordings = changes.recordings.newValue ?? [];
  if (area === 'local' && changes.language) language = changes.language.newValue ?? 'en';
  if (area === 'local' && changes.bilingual) bilingual = Boolean(changes.bilingual.newValue);
  if (area === 'local' && changes[TEXT_SIZE_KEY]) textSize = changes[TEXT_SIZE_KEY].newValue ?? DEFAULT_TEXT_SIZE;
  render();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'level') {
    // 講話的音量大約 0.02–0.2，用對數刻度讓小聲也看得到在動。
    const pct = Math.max(0, Math.min(100, ((Math.log10(msg.value + 1e-6) + 3) / 2.3) * 100));
    $('meter-fill').style.width = `${pct}%`;
  } else if (msg.type === 'caption') {
    caption = msg.text ? msg : null;
    if (!caption) captionTr = null;
    renderLive();
  } else if (msg.type === 'caption-translation') {
    captionTr = msg.text ? msg : null;
    renderLive();
  }
});

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusText() {
  switch (state.status) {
    case 'starting':
      return '準備中…';
    case 'recording':
      return state.host === 'ready' ? '錄音中' : '錄音中 · 載入 Whisper 模型…';
    case 'stopping':
      return '轉完最後幾段…';
    case 'error':
      return '出了點問題';
    default:
      return recordings.some((r) => r.segments.length) ? '已停止' : '尚未開始';
  }
}

function translatorHint() {
  if (!bilingual || !ACTIVE.includes(state.status)) return '';
  if (state.translator === 'loading') return '載入翻譯模型…';
  if (state.translator === 'ready' && state.translatorDevice === 'cpu') return '用 CPU 翻譯，較慢';
  return '';
}

// 一行文字稿：時間＋原文，雙語字幕開著而且有譯文時，原文下面再加一行中文。
function makeLine(sec, text, translation, live = false) {
  const line = document.createElement('p');
  line.className = live ? 'line live' : 'line';
  const time = document.createElement('time');
  time.textContent = formatTime(sec);
  const body = document.createElement('span');
  body.className = 'body';
  const src = document.createElement('span');
  src.className = 'src';
  src.textContent = text;
  body.append(src);
  if (bilingual && translation) {
    const tr = document.createElement('span');
    tr.className = 'tr';
    tr.lang = 'zh-Hant';
    tr.textContent = translation;
    body.append(tr);
  }
  line.append(time, body);
  return line;
}

function render() {
  const active = ACTIVE.includes(state.status);
  const scroller = document.scrollingElement;
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48;

  $('status').textContent = statusText();
  $('dot').className = `dot ${
    state.status === 'recording' ? 'rec' : state.status === 'error' ? 'err' : active ? 'busy' : ''
  }`;
  const model = state.model ? ` · ${state.model} ${state.device === 'cuda' ? 'GPU' : 'CPU'}` : '';
  $('source').textContent = active && state.title ? `${state.title}${model}` : '';
  if (!active) $('meter-fill').style.width = '0';

  $('language').value = active ? state.language ?? language : language;
  $('language').disabled = active;
  $('bilingual').checked = bilingual;
  $('bilingual-hint').textContent = translatorHint();
  document.documentElement.style.setProperty('--text-size', `${textSize}px`);
  $('smaller').disabled = textSize <= TEXT_SIZES[0];
  $('bigger').disabled = textSize >= TEXT_SIZES.at(-1);

  const toggle = $('toggle');
  toggle.textContent = state.status === 'stopping' ? '收尾中…' : active ? '停止' : '開始';
  toggle.classList.toggle('stop', active);
  toggle.disabled = state.status === 'stopping';

  const msg = $('message');
  msg.hidden = !state.message;
  msg.textContent = state.message ?? '';

  const hasText = recordings.some((r) => r.segments.length);
  $('copy').disabled = !hasText;
  $('download').disabled = !hasText;
  $('clear').disabled = !hasText;
  $('empty').hidden = hasText || active;

  const main = $('transcript');
  main.replaceChildren();
  for (const r of recordings) {
    if (!r.segments.length && r.id !== state.recId) continue;
    const head = document.createElement('div');
    head.className = 'rec-head';
    const title = document.createElement('strong');
    title.textContent = r.title || '（沒有標題的分頁）';
    head.append(title, ` · ${LANGUAGE_NAMES[r.language ?? 'en']} · ${formatDate(r.startedAt)}`);
    main.append(head);
    for (const seg of r.segments) main.append(makeLine(seg.start, seg.text, seg.translation));
  }
  if (active) {
    const live = document.createElement('div');
    live.id = 'live';
    main.append(live);
    renderLive(false);
  } else {
    caption = null;
    captionTr = null;
  }

  updateElapsed();
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

// 最下面那一行：這一句還沒講完時顯示即時字幕（淺色，會一直改），講完定稿後由正式的一行取代。
function renderLive(keepBottom = true) {
  const live = $('live');
  if (!live) return;
  const scroller = document.scrollingElement;
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48;
  if (caption && caption.recId === state.recId) {
    // 譯文比原文慢一點才到：只顯示同一句（同一個 id）的譯文。
    const tr = captionTr?.id === caption.id && captionTr.recId === caption.recId ? captionTr.text : '';
    live.replaceChildren(makeLine(caption.offset, caption.text, tr, true));
  } else {
    const working = document.createElement('p');
    working.className = 'working';
    working.textContent = state.pending > 1 ? `聽寫中…（還有 ${state.pending} 段在排隊）` : '聽寫中…';
    live.replaceChildren(working);
  }
  if (keepBottom && atBottom) scroller.scrollTop = scroller.scrollHeight;
}

function updateElapsed() {
  $('elapsed').textContent =
    state.status === 'recording' && state.startedAt ? formatTime((Date.now() - state.startedAt) / 1000) : '';
}
setInterval(updateElapsed, 1000);

function transcriptText() {
  return recordings
    .filter((r) => r.segments.length)
    .map((r) =>
      [
        `來源：${r.title || '（沒有標題的分頁）'}`,
        r.url ? `網址：${r.url}` : null,
        `語言：${LANGUAGE_NAMES[r.language ?? 'en']}`,
        bilingual && r.segments.some((s) => s.translation) ? '翻譯：繁體中文（這台電腦上的翻譯模型，僅供參考）' : null,
        `開始：${formatDate(r.startedAt)}（時間從開始錄音算起）`,
        '',
        ...r.segments.flatMap((s) => {
          const head = `[${formatTime(s.start)}] `;
          return bilingual && s.translation ? [head + s.text, ' '.repeat(head.length) + s.translation] : [head + s.text];
        }),
      ]
        .filter((l) => l !== null)
        .join('\n'),
    )
    .join('\n\n\n');
}

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = original), 1500);
}

$('language').addEventListener('change', (e) => chrome.storage.local.set({ language: e.target.value }));
// 錄音中也可以切換：背景程式聽 storage 的變化，馬上通知本機程式啟動或關掉翻譯模型。
$('bilingual').addEventListener('change', (e) => chrome.storage.local.set({ bilingual: e.target.checked }));

$('toggle').addEventListener('click', async () => {
  if (ACTIVE.includes(state.status)) {
    chrome.runtime.sendMessage({ type: 'stop' });
  } else {
    // 獨立視窗裡按開始：錄放大前那個瀏覽器視窗正在看的分頁；那個視窗關掉了，就用最近用過的瀏覽器視窗。
    const host = inWindow && (await chrome.windows.get(hostWindowId).catch(() => null));
    const win = inWindow ? host || (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })) : await chrome.windows.getCurrent();
    chrome.runtime.sendMessage({ type: 'start', windowId: win.id });
  }
});

function stepTextSize(dir) {
  const next = dir > 0 ? TEXT_SIZES.find((n) => n > textSize) : TEXT_SIZES.findLast((n) => n < textSize);
  if (next) chrome.storage.local.set({ [TEXT_SIZE_KEY]: next });
}
$('smaller').addEventListener('click', () => stepTextSize(-1));
$('bigger').addEventListener('click', () => stepTextSize(1));

// 收起側邊欄只是關掉這個頁面，錄音在背景程式和錄音頁裡繼續。
async function closePanel() {
  const { id } = await chrome.windows.getCurrent();
  if (chrome.sidePanel.close) await chrome.sidePanel.close({ windowId: id });
  else window.close();
}
$('collapse').addEventListener('click', closePanel);

$('popout').addEventListener('click', async () => {
  const { id } = await chrome.windows.getCurrent();
  const url = chrome.runtime.getURL(`sidepanel.html?window=${id}`);
  // 這個瀏覽器視窗已經放大過，就把那個視窗叫到前面，不再開第二個。
  const [open] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (open) await chrome.windows.update(open.windowId, { focused: true });
  else await chrome.windows.create({ url, type: 'popup', width: 760, height: 900 });
  await closePanel();
});

$('dock').addEventListener('click', () => {
  // sidePanel.open 只能在點擊當下呼叫，前面不能先 await。
  chrome.sidePanel.open({ windowId: hostWindowId }).then(
    () => window.close(),
    () => flash($('dock'), '原本的瀏覽器視窗已關閉'),
  );
});

if (inWindow) {
  $('popout').hidden = true;
  $('collapse').hidden = true;
  $('dock').hidden = false;
}

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(transcriptText());
    flash($('copy'), '已複製');
  } catch {
    flash($('copy'), '複製失敗');
  }
});

$('download').addEventListener('click', () => {
  const blob = new Blob([transcriptText() + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = formatDate(recordings.at(-1)?.startedAt ?? Date.now()).replace(/[-: ]/g, '');
  a.href = url;
  a.download = `transcript-${stamp}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// 清除要按兩次，避免誤刪。
$('clear').addEventListener('click', async () => {
  const button = $('clear');
  if (!clearArmed) {
    button.textContent = '確定清除？';
    button.classList.add('armed');
    clearArmed = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  await chrome.runtime.sendMessage({ type: 'clear' });
});

function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = null;
  $('clear').textContent = '清除';
  $('clear').classList.remove('armed');
}

load();
