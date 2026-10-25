// 錄分頁聲音，不播回喇叭，只量音量。
let st = null;

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.target !== 'off') return;
  if (m.type === 'start') {
    navigator.mediaDevices
      .getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId } }, video: false })
      .then((stream) => {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(analyser);
        st = { ctx, track: stream.getAudioTracks()[0], max: 0 };
        const buf = new Float32Array(2048);
        setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          st && (st.max = Math.max(st.max, Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)));
        }, 50);
        reply({ ok: true });
      }, (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (m.type === 'level') {
    reply(st && { track: st.track.readyState, rms: Number(st.max.toFixed(4)) });
    if (st) st.max = 0;
  }
});
