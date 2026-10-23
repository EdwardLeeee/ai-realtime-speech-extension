// 把輸入的聲音混成單聲道，每湊滿 100 ms（16 kHz 下 1600 個樣本）就丟回主執行緒。
const BLOCK = 1600;

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BLOCK);
    this.n = 0;
  }

  process(inputs) {
    const [left, right] = inputs[0];
    if (!left) return true;
    for (let i = 0; i < left.length; i++) {
      this.buf[this.n++] = right ? (left[i] + right[i]) / 2 : left[i];
      if (this.n === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
