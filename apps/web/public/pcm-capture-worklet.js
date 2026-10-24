/* global registerProcessor, AudioWorkletProcessor */
// Posts each 128-sample mono input block to the main thread as a Float32Array copy.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
