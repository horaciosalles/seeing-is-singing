// ── pitch-worklet.js ──────────────────────────────────────────────────────────
// AudioWorklet that posts overlapping frames of the newest microphone samples
// at a fixed hop, stamped with audio time. Detection runs on the main thread.
// ─────────────────────────────────────────────────────────────────────────────

class FrameTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { frame = 2048, hop = 512 } = options.processorOptions || {};
    this.buf = new Float32Array(frame);
    this.hop = hop;
    this.filled = 0;
    this.sinceHop = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const F = this.buf.length, n = ch.length;
    this.buf.copyWithin(0, n);
    this.buf.set(ch, F - n);
    this.filled = Math.min(F, this.filled + n);
    this.sinceHop += n;
    if (this.sinceHop >= this.hop && this.filled === F) {
      this.sinceHop -= this.hop;
      this.port.postMessage({ samples: this.buf.slice(), t: currentTime });
    }
    return true;
  }
}

registerProcessor('frame-tap', FrameTap);
