// YouTube 原文字幕（頁面本身的 world，document_start 就執行）：跟著播放器拿字幕。
// YouTube 的字幕檔要帶播放器自己算出來的通行碼（pot）才拿得到，插件自己去抓只會拿到空的（研究筆記第 13 節），
// 所以只看播放器打開 CC 時自己抓回來的那一份，不另外發任何請求。解析好就用 postMessage 交給同一頁的
// yt-caption-bridge.js；這裡不存、不上傳，也不管有沒有在錄音。
(() => {
  if (window.__tabTranscriberYtHook) return;
  window.__tabTranscriberYtHook = true;
  const TAG = 'tab-transcriber-yt';

  function parse(url, body) {
    const u = new URL(url, location.href);
    // 只要原文：tlang 是 YouTube 的機器翻譯
    if (!u.pathname.endsWith('/api/timedtext') || u.searchParams.has('tlang') || !body) return;
    let data;
    try {
      data = JSON.parse(body); // 播放器用 fmt=json3
    } catch {
      return;
    }
    const cues = [];
    for (const e of data.events ?? []) {
      // 自動字幕一個字一個字出現：aAppend 的事件只是換行
      if (!e.segs || e.aAppend) continue;
      const text = e.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
      if (text) cues.push({ start: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs ?? 0)) / 1000, text });
    }
    if (!cues.length) return;
    window.postMessage(
      { source: TAG, type: 'track', videoId: u.searchParams.get('v'), lang: u.searchParams.get('lang') ?? '',
        asr: u.searchParams.get('kind') === 'asr', cues },
      location.origin,
    );
  }

  const fetch = window.fetch;
  window.fetch = function (input) {
    const result = fetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (url.includes('/api/timedtext')) {
      result.then((r) => r.clone().text()).then((body) => parse(url, body)).catch(() => {});
    }
    return result;
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(url).includes('/api/timedtext')) {
      this.addEventListener('load', () => {
        try {
          const body = this.responseType === 'json' ? JSON.stringify(this.response)
            : this.responseType === 'arraybuffer' ? new TextDecoder().decode(this.response)
            : this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
          parse(String(url), body);
        } catch {}
      });
    }
    return open.apply(this, arguments);
  };
})();
