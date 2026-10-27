// 在看不見的背景頁錄分頁聲音：照常播給使用者聽，同時轉成 16 kHz，在講話停頓處切成一段段送去轉文字。

const RATE = 16000;
const BLOCK = 1600; // 每塊 100 ms，和 pcm-worklet.js 一致
const BLOCK_S = BLOCK / RATE;
const MIN_CHUNK_BLOCKS = 60; // 一段至少 6 秒才開始找停頓切
const MAX_CHUNK_BLOCKS = 250; // 最長 25 秒，到了就在最後 3 秒內最安靜的地方切
const GAP_BLOCKS = 4; // 連續 0.4 秒安靜算一個停頓
const LEAD_BLOCKS = 5; // 還沒出聲前最多保留 0.5 秒
const MIN_VOICED_BLOCKS = 3; // 有聲音不到 0.3 秒的段落不送
// 遊戲、觀眾、配樂一直有聲音時永遠等不到絕對的安靜，每段都拖到 25 秒才切。所以也拿最近 10 秒最安靜的一成當背景音量，
// 比它大 1.5 倍才算有人聲（模擬背景聲比講話小 10 dB 到大 3 dB：一段從 23 秒回到約 7 秒，送出的講話一樣多；研究筆記第 13 節）
const FLOOR_BLOCKS = 100;
const FLOOR_RATIO = 1.5;
const LEVEL_EVERY = 5; // 每 0.5 秒回報一次音量給側邊欄
const PARTIAL_EVERY_BLOCKS = 10; // 這一句還沒講完時，每 1 秒把目前聽到的部分送去轉，當即時字幕

let capture = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    startCapture(msg.streamId).then(
      () => sendResponse({ ok: true, playback: capture.playback.state }),
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true;
  }
  if (msg.type === 'stop') stopCapture('stopped');
});

async function startCapture(streamId) {
  if (capture) throw new Error('已經在錄音中');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  // 被錄音的分頁會變成靜音，所以把聲音接回喇叭。
  const playback = new AudioContext();
  playback.createMediaStreamSource(stream).connect(playback.destination);
  // 另開一個 16 kHz 的 context，降取樣交給瀏覽器做。
  const tap = new AudioContext({ sampleRate: RATE });
  await tap.audioWorklet.addModule('pcm-worklet.js');
  const node = new AudioWorkletNode(tap, 'pcm-tap');
  tap.createMediaStreamSource(stream).connect(node);
  node.connect(tap.destination); // 要接到輸出才會被處理；node 本身只輸出靜音
  await Promise.all([playback.resume(), tap.resume()]);
  if (tap.state !== 'running') {
    stream.getTracks().forEach((t) => t.stop());
    playback.close();
    tap.close();
    throw new Error(`錄音元件沒有啟動（狀態：${tap.state}）`);
  }

  const c = {
    stream,
    playback,
    tap,
    node,
    blocks: [], // 這一段還沒送出的聲音
    loud: [], // 每塊是否有人聲
    rms: [],
    recent: [], // 最近 FLOOR_BLOCKS 塊的音量，估背景聲
    startBlock: 0, // 這一段第一塊是從錄音開始算的第幾塊
    silentRun: 0,
    speech: 0.05, // 講話音量的移動平均，用來決定「安靜」的門檻
    nextId: 1,
    partialAt: 0, // 上次送即時字幕時這一段有幾塊
    partialSent: false,
    levelMax: 0,
    levelCount: 0,
  };
  node.port.onmessage = (e) => onBlock(c, e.data);
  stream.getAudioTracks()[0].addEventListener('ended', () => stopCapture('ended'));
  capture = c;
}

function onBlock(c, samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  c.recent.push(rms);
  if (c.recent.length > FLOOR_BLOCKS) c.recent.shift();
  const floor = [...c.recent].sort((a, b) => a - b)[Math.floor(c.recent.length / 10)];
  const loud = rms > Math.max(0.003, c.speech * 0.12, floor * FLOOR_RATIO);
  if (loud) c.speech = c.speech * 0.95 + rms * 0.05;

  c.blocks.push(samples);
  c.loud.push(loud);
  c.rms.push(rms);
  c.silentRun = loud ? 0 : c.silentRun + 1;

  c.levelMax = Math.max(c.levelMax, rms);
  if (++c.levelCount === LEVEL_EVERY) {
    chrome.runtime.sendMessage({ type: 'level', value: c.levelMax }).catch(() => {});
    c.levelMax = 0;
    c.levelCount = 0;
  }

  const n = c.blocks.length;
  if (!c.loud.includes(true)) {
    // 還沒出聲：只留最後一小段當開頭，時間軸照樣往前走。
    if (n > LEAD_BLOCKS) emit(c, n - LEAD_BLOCKS);
  } else if (n >= MIN_CHUNK_BLOCKS && c.silentRun >= GAP_BLOCKS) {
    emit(c, n);
  } else if (n >= MAX_CHUNK_BLOCKS) {
    let cut = n - 30;
    for (let i = cut; i < n; i++) if (c.rms[i] < c.rms[cut]) cut = i;
    emit(c, cut + 1);
  }

  const len = c.blocks.length;
  if (len - c.partialAt >= PARTIAL_EVERY_BLOCKS && c.loud.includes(true)) {
    c.partialAt = len;
    c.partialSent = true;
    const offset = c.startBlock * BLOCK_S;
    chrome.runtime.sendMessage({ type: 'partial', id: c.nextId, offset, pcm: encode(c.blocks) }).catch(() => {});
  }
}

// 把前 count 塊切成一段；有足夠人聲才送去轉文字，否則只推進時間軸。
function emit(c, count) {
  const blocks = c.blocks.splice(0, count);
  const voiced = c.loud.splice(0, count).filter(Boolean).length;
  c.rms.splice(0, count);
  const offset = c.startBlock * BLOCK_S;
  c.startBlock += count;
  c.partialAt = 0;
  const hadPartial = c.partialSent;
  c.partialSent = false;
  if (voiced < MIN_VOICED_BLOCKS) {
    // 這段不送去定稿，已經顯示的即時字幕要收掉。
    if (hadPartial) chrome.runtime.sendMessage({ type: 'partial-reset' }).catch(() => {});
    return;
  }
  chrome.runtime.sendMessage({ type: 'chunk', id: c.nextId++, offset, pcm: encode(blocks) }).catch(() => {});
}

function encode(blocks) {
  const pcm = new Int16Array(blocks.length * BLOCK);
  blocks.forEach((b, i) => {
    for (let j = 0; j < BLOCK; j++) {
      const s = Math.max(-1, Math.min(1, b[j]));
      pcm[i * BLOCK + j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  });
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function stopCapture(reason) {
  const c = capture;
  capture = null;
  if (c) {
    c.node.port.onmessage = null;
    if (c.blocks.length) emit(c, c.blocks.length);
    c.stream.getTracks().forEach((t) => t.stop());
    c.playback.close();
    c.tap.close();
  }
  chrome.runtime.sendMessage({ type: reason }).catch(() => {});
}
