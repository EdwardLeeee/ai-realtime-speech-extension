// YouTube 原文字幕（插件的 isolated world）：收 yt-caption-hook.js 交過來的字幕，
// 錄音中照影片的播放時間，把播到的每一句交給背景程式（時間是影片本身的時間）。
// 背景程式在錄音開始時用 { target: 'yt-captions', type: 'probe' | 'start' | 'stop' } 找它；
// 錄音中網頁重新整理後，這裡會用 { type: 'yt-hello' } 問背景程式還在不在錄這個分頁。
(() => {
  if (globalThis.__tabTranscriberYtBridge) return;
  globalThis.__tabTranscriberYtBridge = true;
  const TAG = 'tab-transcriber-yt';
  const SEEK_S = 3; // 兩次檢查之間影片時間跳超過這麼多（或往回跳）就當成使用者拖了進度條，只送當下那一句

  const tracks = new Map(); // videoId → { lang, asr, cues }，只留目前這部影片
  const sent = new Set(); // 這次錄音送過的句子（videoId|開始時間），往回拖不會重複
  let active = false;
  let lastTime = null;
  let video = null;

  const videoId = () => new URLSearchParams(location.search).get('v');
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== TAG || e.data.type !== 'track') return;
    const { videoId: id, lang, asr, cues } = e.data;
    if (!id || !Array.isArray(cues)) return;
    tracks.set(id, { lang: String(lang ?? ''), asr: Boolean(asr), cues });
    for (const key of tracks.keys()) if (key !== id) tracks.delete(key);
    if (active && id === videoId()) send({ type: 'yt-track', lang, asr, cues: cues.length });
  });

  function tick() {
    if (!active) return;
    const current = document.querySelector('video.html5-main-video') ?? document.querySelector('video');
    if (current !== video) {
      video?.removeEventListener('timeupdate', tick);
      video = current;
      video?.addEventListener('timeupdate', tick);
      lastTime = null;
    }
    const id = videoId();
    const track = tracks.get(id);
    // 廣告也用同一個 <video>，那時的時間不是影片的時間
    if (!track || !video || document.querySelector('#movie_player.ad-showing')) return;
    const t = video.currentTime;
    const seeked = lastTime === null || t < lastTime || t - lastTime > SEEK_S;
    const due = track.cues.filter((c) =>
      seeked ? c.start <= t && t < Math.max(c.end, c.start + 0.5) : c.start > lastTime && c.start <= t);
    lastTime = t;
    for (const c of seeked ? due.slice(-1) : due) {
      const key = `${id}|${c.start}`;
      if (sent.has(key)) continue;
      sent.add(key);
      send({ type: 'yt-cue', videoId: id, start: c.start, end: c.end, text: c.text, lang: track.lang, asr: track.asr });
    }
  }

  let timer = null;
  function setActive(on) {
    active = on;
    clearInterval(timer);
    lastTime = null;
    if (!on) return;
    timer = setInterval(tick, 500); // 分頁在背景時 timeupdate 照樣會來，這個只是保險
    const track = tracks.get(videoId());
    if (track) send({ type: 'yt-track', lang: track.lang, asr: track.asr, cues: track.cues.length });
    tick();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== 'yt-captions') return;
    if (msg.type === 'probe') {
      const track = tracks.get(videoId());
      sendResponse({ youtube: true, track: track ? { lang: track.lang, asr: track.asr } : null });
    } else if (msg.type === 'start') {
      sent.clear();
      setActive(true);
    } else if (msg.type === 'stop') {
      setActive(false);
    }
  });

  chrome.runtime.sendMessage({ type: 'yt-hello' }).then((r) => r?.active && setActive(true)).catch(() => {});
})();
