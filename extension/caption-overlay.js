// 網頁字幕：錄音中由背景程式注入到被錄的分頁，浮在網頁上顯示上一句定稿和正在講的這一句（雙語字幕開著時各帶譯文），
// 可以拖動，右下角拖動改寬高（字的大小不變，按兩下恢復自動大小），右上角 × 關掉（等於關掉側邊欄的「網頁字幕」開關）。
// 背景程式用 chrome.tabs.sendMessage 推 { target: 'overlay', type: 'update', lines: [{ text, tr }] } 和 { type: 'remove' }。
//
// 全螢幕：字幕框是 popover，放在 top layer。影片進入全螢幕後要重新 showPopover 一次，才會排到全螢幕元素上面；
// 全螢幕的是一般元素（YouTube 等網站的播放器外框）時再搬進那個元素裡，否則滑鼠點不到（只看得到、拖不動）。
// 全螢幕的是 <video>、<iframe> 這類不能放子元素的，或搬進去後畫不出來（例如外框用 shadow DOM、沒有 slot），就只能看。

(() => {
  if (globalThis.__tabTranscriberOverlay) return;
  globalThis.__tabTranscriberOverlay = true;

  const NO_CHILDREN = ['VIDEO', 'IFRAME', 'CANVAS', 'IMG', 'EMBED', 'OBJECT'];
  // 位置存成比例：x 是字幕框中線、y 是底邊，分別佔視窗寬、高的多少，全螢幕和一般視窗都適用。
  let pos = { x: 0.5, y: 0.9 };
  // 使用者拖過右下角後的寬高，單位 em：字體跟著畫面寬度縮放（例如全螢幕），框也跟著等比例變，一行的字數不變。null 是依文字自動。
  let size = null;
  const MIN_SIZE = { w: 8, h: 2.4 }; // 最小約一行字

  const host = document.createElement('tab-transcriber-caption');
  host.setAttribute('popover', 'manual');
  // 蓋掉 popover 的預設樣式（置中、邊框、底色）和網頁可能對它下的樣式。
  const hostStyle = {
    position: 'fixed',
    inset: 'auto',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    overflow: 'visible',
    width: 'max-content',
    height: 'auto',
    'max-width': 'none',
    'max-height': 'none',
    transform: 'translate(-50%, -100%)',
    'z-index': '2147483647',
    'pointer-events': 'auto',
  };
  for (const [k, v] of Object.entries(hostStyle)) host.style.setProperty(k, v, 'important');

  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .box {
      all: initial;
      position: relative;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      max-width: min(92vw, 40em);
      padding: 0.45em 2em 0.5em 1em;
      border-radius: 10px;
      background: rgb(12 12 12 / 0.74);
      color: #fff;
      font: 500 clamp(15px, 1.25vw + 4px, 34px)/1.45 system-ui, "Noto Sans TC", "Noto Sans CJK TC", "Noto Sans JP", "Noto Sans Thai", sans-serif;
      text-align: center;
      text-shadow: 0 1px 2px #000;
      overflow-wrap: anywhere;
      cursor: move;
      user-select: none;
      touch-action: none;
    }
    /* 一句太長時只留最下面約五行（最新的字在最後面），上緣淡出；本機程式已經把一長串重複縮短，這裡是保險 */
    .lines {
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      max-height: 7.5em;
      overflow: hidden;
    }
    .lines.clipped { mask-image: linear-gradient(transparent, #000 1.5em); }
    /* 拖過右下角：框的寬高固定，字貼著下緣 */
    .box.sized { max-width: 96vw; max-height: 90vh; }
    .box.sized .lines { flex: 1 1 auto; min-height: 0; max-height: none; }
    .line { flex-shrink: 0; }
    .line + .line { margin-top: 0.25em; }
    /* 有正在講的這一句時，上一句淡一點、小一點 */
    .line:not(:last-child) { opacity: 0.62; font-size: 0.85em; }
    .tr { display: block; color: #ffe7a3; font-size: 0.9em; }
    .waiting { opacity: 0.6; font-size: 0.85em; }
    .close {
      all: initial;
      position: absolute;
      top: 3px;
      right: 3px;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      color: rgb(255 255 255 / 0.75);
      font: 22px/28px system-ui, sans-serif;
      text-align: center;
      cursor: pointer;
    }
    .close:hover { background: rgb(255 255 255 / 0.18); color: #fff; }
    .resize {
      all: initial;
      position: absolute;
      right: 0;
      bottom: 0;
      width: 18px;
      height: 18px;
      border-bottom-right-radius: 10px;
      background: linear-gradient(135deg, transparent 52%, rgb(255 255 255 / 0.5) 52% 60%, transparent 60% 68%,
        rgb(255 255 255 / 0.5) 68% 76%, transparent 76%);
      opacity: 0.5;
      cursor: nwse-resize;
      touch-action: none;
    }
    .box:hover .resize { opacity: 1; }
    .close:focus-visible { outline: 2px solid #8ab4ff; }
  `);
  root.adoptedStyleSheets = [sheet];

  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', '即時字幕');
  const lines = document.createElement('div');
  lines.className = 'lines';
  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.textContent = '×';
  close.title = '關掉網頁字幕（側邊欄的「網頁字幕」可以再打開）';
  close.setAttribute('aria-label', '關掉網頁字幕');
  const grip = document.createElement('div');
  grip.className = 'resize';
  grip.title = '拖動改變字幕框大小，按兩下恢復自動大小';
  box.append(lines, close, grip);
  root.append(box);

  function render(items) {
    const nodes = items.map(({ text, tr }) => {
      const line = document.createElement('div');
      line.className = 'line';
      line.textContent = text;
      if (tr) {
        const t = document.createElement('span');
        t.className = 'tr';
        t.lang = 'zh-Hant';
        t.textContent = tr;
        line.append(t);
      }
      return line;
    });
    if (!nodes.length) {
      const waiting = document.createElement('div');
      waiting.className = 'waiting';
      waiting.textContent = '聽寫中…';
      nodes.push(waiting);
    }
    lines.replaceChildren(...nodes);
    updateClip();
    place();
  }

  function updateClip() {
    const height = [...lines.children].reduce((sum, node) => sum + node.offsetHeight, 0);
    lines.classList.toggle('clipped', height > lines.clientHeight + 1);
  }

  function applySize() {
    box.classList.toggle('sized', Boolean(size));
    box.style.width = size ? `${size.w}em` : '';
    box.style.height = size ? `${size.h}em` : '';
    updateClip();
  }

  // 依比例擺放，並讓整個字幕框留在畫面裡。
  function place() {
    const r = box.getBoundingClientRect();
    const half = Math.min(0.5, r.width / 2 / innerWidth);
    const x = Math.min(1 - half, Math.max(half, pos.x));
    const y = Math.min(1, Math.max(Math.min(1, r.height / innerHeight), pos.y));
    host.style.setProperty('left', `${x * 100}vw`, 'important');
    host.style.setProperty('top', `${y * 100}vh`, 'important');
  }

  function show() {
    const fs = document.fullscreenElement;
    attach(fs && !NO_CHILDREN.includes(fs.tagName) ? fs : document.documentElement);
    if (!box.getClientRects().length) attach(document.documentElement);
    place();
  }

  function attach(parent) {
    if (host.parentNode !== parent) parent.append(host);
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  }

  // 拖動：按住字幕框任何地方（×、右下角以外）移動。
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.composedPath().some((el) => el === close || el === grip)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: { ...pos } };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (drag?.id !== e.pointerId) return;
    pos = { x: drag.start.x + (e.clientX - drag.x) / innerWidth, y: drag.start.y + (e.clientY - drag.y) / innerHeight };
    place();
  });
  const endDrag = (e) => {
    if (drag?.id !== e.pointerId) return;
    drag = null;
    // 存下夾進畫面後的位置
    const r = box.getBoundingClientRect();
    pos = { x: (r.left + r.width / 2) / innerWidth, y: r.bottom / innerHeight };
    chrome.storage.local.set({ overlayPos: pos }).catch(() => {});
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  // 改大小：拖右下角，左上角不動。
  let resize = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = box.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(box).fontSize);
    resize = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, em };
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (resize?.id !== e.pointerId) return;
    const { em } = resize;
    size = {
      w: Math.max(MIN_SIZE.w, (resize.w + e.clientX - resize.x) / em),
      h: Math.max(MIN_SIZE.h, (resize.h + e.clientY - resize.y) / em),
    };
    applySize();
    // 實際大小（夾過最小、最大值）換算回字幕框中線和底邊的位置
    const r = box.getBoundingClientRect();
    pos = { x: (resize.left + r.width / 2) / innerWidth, y: (resize.top + r.height) / innerHeight };
    place();
  });
  const endResize = (e) => {
    if (resize?.id !== e.pointerId) return;
    const r = box.getBoundingClientRect();
    if (size) size = { w: r.width / resize.em, h: r.height / resize.em };
    resize = null;
    pos = { x: (r.left + r.width / 2) / innerWidth, y: r.bottom / innerHeight };
    chrome.storage.local.set({ overlayPos: pos, ...(size && { overlaySize: size }) }).catch(() => {});
  };
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);
  grip.addEventListener('dblclick', () => {
    size = null;
    applySize();
    place();
    chrome.storage.local.remove('overlaySize').catch(() => {});
  });
  // 不讓點擊、雙擊傳到網頁：YouTube 點一下會暫停、雙擊會切換全螢幕。
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  close.addEventListener('click', () => {
    teardown();
    chrome.storage.local.set({ overlay: false }).catch(() => {});
  });

  function onMessage(msg) {
    if (msg?.target !== 'overlay') return;
    if (msg.type === 'update') render(msg.lines ?? []);
    else if (msg.type === 'remove') teardown();
  }

  function teardown() {
    chrome.runtime.onMessage.removeListener(onMessage);
    document.removeEventListener('fullscreenchange', show);
    removeEventListener('resize', place);
    host.remove();
    delete globalThis.__tabTranscriberOverlay;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener('fullscreenchange', show);
  addEventListener('resize', place);
  render([]);
  show();
  chrome.storage.local.get(['overlayPos', 'overlaySize']).then(({ overlayPos, overlaySize }) => {
    if (drag || resize) return;
    if (overlayPos) pos = overlayPos;
    if (overlaySize) size = overlaySize;
    applySize();
    place();
  });
})();
