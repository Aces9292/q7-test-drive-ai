// Turns the phone mic into 16 kHz, 16-bit PCM chunks (100 ms each) for the Gemini Live API.
// Downsamples by averaging, which works for any device sample rate (44.1k, 48k, ...).
const TARGET_RATE = 16000;
const CHUNK = 1600; // 100 ms at 16 kHz

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.acc = 0;
    this.sum = 0;
    this.count = 0;
    this.buf = new Int16Array(CHUNK);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.count++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        let v = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        this.buf[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.len === CHUNK) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Int16Array(CHUNK);
          this.len = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
