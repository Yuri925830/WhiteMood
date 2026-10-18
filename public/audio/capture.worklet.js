/* Native AudioWorklet: capture mono PCM in fixed 20 ms blocks. No remote audio or models. */
class WhiteMoodCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(Math.round(sampleRate * 0.02));
    this.offset = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input[0]) {
      for (let i = 0; i < input[0].length; i++) {
        let sample = 0;
        for (let channel = 0; channel < input.length; channel++) sample += input[channel][i] || 0;
        this.frame[this.offset++] = sample / input.length;
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Float32Array(Math.round(sampleRate * 0.02));
          this.offset = 0;
        }
      }
    }
    // A zero-output node keeps the graph alive without monitoring the microphone.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('whitemood-capture', WhiteMoodCapture);
