// YouTube 原文字幕（插件的 isolated world）：收 yt-caption-hook.js 交過來的整份字幕，錄音中交給背景程式
// （{ type: 'yt-track' }），再照影片的播放時間告訴它現在播到哪一句（{ type: 'yt-cue' }，時間是影片本身的時間）。
// 播放器只有打開 CC 時才會抓字幕檔，所以錄音中還沒拿到字幕的影片會幫使用者按一次 CC（{ type: 'yt-cc' }），
// 停止時背景程式會請這裡關回去。
// 背景程式在錄音開始時用 { target: 'yt-captions', type: 'probe' | 'start' | 'stop' } 找它；
// 錄音中網頁重新整理後，這裡會用 { type: 'yt-hello' } 問背景程式還在不在錄這個分頁。
(() => {
  if (globalThis.__tabTranscriberYtBridge) return;
  globalThis.__tabTranscriberYtBridge = true;
  const TAG = 'tab-transcriber-yt';
  const SEEK_S = 3; // 兩次檢查之間影片時間跳超過這麼多（或往回跳）就當成使用者拖了進度條
  const CC_DELAY_MS = 2000; // 換到一部影片後等播放器把 CC 狀態（YouTube 會記住上次開著）套上去，再決定要不要按

  const tracks = new Map(); // videoId → { lang, asr, cues }，只留目前這部影片
  const ccTried = new Set(); // 這次錄音幫哪些影片按過 CC，每部只按一次
  let active = false;
  let lastTime = null;
  let lastVideo; // 上次檢查時的 videoId，換影片要通知背景程式
  let videoSince = 0; // 什麼時候換到這部影片
  let current; // 上次送出的那一句的開始時間；null 是影片還沒播到第一句
  let video = null;
  let cueTimer = null; // 下一句開始的那一刻再檢查一次
  const EVENTS = ['timeupdate', 'seeked', 'play', 'ratechange'];

  const videoId = () => new URLSearchParams(location.search).get('v');
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
  const ccButton = () => document.querySelector('#movie_player .ytp-subtitles-button');

  function sendTrack(id) {
    const track = tracks.get(id);
    if (track) send({ type: 'yt-track', videoId: id, ...track });
  }

  addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== TAG || e.data.type !== 'track') return;
    const { videoId: id, lang, asr, cues } = e.data;
    if (!id || !Array.isArray(cues)) return;
    tracks.set(id, { lang: String(lang ?? ''), asr: Boolean(asr), cues });
    for (const key of tracks.keys()) if (key !== id) tracks.delete(key);
    if (active && id === videoId()) {
      sendTrack(id);
      current = undefined; // 換了字幕語言：現在這一句要重送
      tick();
    }
  });

  // 播放器的 CC 按鈕：影片有字幕而且還沒打開時按一次，播放器就會自己去抓字幕檔
  function openCaptions(id) {
    if (ccTried.has(id) || Date.now() - videoSince < CC_DELAY_MS) return;
    const button = ccButton();
    if (!button?.getClientRects().length || button.getAttribute('aria-disabled') === 'true') return;
    ccTried.add(id);
    if (button.getAttribute('aria-pressed') !== 'false') return; // 已經開著（或不是開關），不動它
    button.click();
    send({ type: 'yt-cc' });
  }

  function tick() {
    clearTimeout(cueTimer);
    if (!active) return;
    const el = document.querySelector('video.html5-main-video') ?? document.querySelector('video');
    if (el !== video) {
      for (const type of EVENTS) video?.removeEventListener(type, tick);
      video = el;
      for (const type of EVENTS) video?.addEventListener(type, tick);
      lastTime = null;
    }
    const id = videoId();
    if (id !== lastVideo) {
      lastVideo = id;
      videoSince = Date.now();
      current = undefined;
      lastTime = null;
      send({ type: 'yt-video', videoId: id });
    }
    // 廣告也用同一個 <video>，那時的時間不是影片的時間
    if (!id || !video || document.querySelector('#movie_player.ad-showing')) return;
    const track = tracks.get(id);
    if (!track) return openCaptions(id);
    const t = video.currentTime;
    const seeked = lastTime === null || t < lastTime || t - lastTime > SEEK_S;
    lastTime = t;
    // 現在這一句：最後一句已經開始的；兩句之間的空檔留著上一句
    const i = track.cues.findLastIndex((c) => c.start <= t);
    const start = i < 0 ? null : track.cues[i].start;
    // timeupdate 大約每 250 毫秒才來一次，等它會比原生 CC 晚換；字幕的開始時間都知道，算好下一句什麼時候開始
    const upcoming = track.cues.find((c) => c.start > t);
    if (upcoming && !video.paused && video.playbackRate > 0) {
      cueTimer = setTimeout(tick, ((upcoming.start - t) / video.playbackRate) * 1000 + 5);
    }
    if (start === current) return;
    current = start;
    send({ type: 'yt-cue', videoId: id, start, seeked });
  }

  let timer = null;
  function setActive(on) {
    active = on;
    clearInterval(timer);
    clearTimeout(cueTimer);
    lastTime = null;
    lastVideo = undefined;
    current = undefined;
    ccTried.clear();
    if (!on) return;
    timer = setInterval(tick, 500); // 分頁在背景時 timeupdate 照樣會來，這個只是保險
    sendTrack(videoId());
    tick();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== 'yt-captions') return;
    if (msg.type === 'probe') {
      const track = tracks.get(videoId());
      sendResponse({ youtube: true, track: track ? { lang: track.lang, asr: track.asr } : null });
    } else if (msg.type === 'start') {
      setActive(true);
    } else if (msg.type === 'stop') {
      setActive(false);
      // CC 是插件打開的：關回去，不改使用者在 YouTube 的設定
      const button = ccButton();
      if (msg.closeCaptions && button?.getAttribute('aria-pressed') === 'true') button.click();
    }
  });

  chrome.runtime.sendMessage({ type: 'yt-hello' }).then((r) => r?.active && setActive(true)).catch(() => {});
})();
