// AudioWorkletProcessor that streams the tab audio's raw PCM (mono, the context's
// native rate, in 128-sample blocks) back to the offscreen doc, which accumulates
// it for VAD-based subtitle sync. AudioWorklet (not the deprecated
// ScriptProcessorNode) gives clean, contiguous, glitch-free samples.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // Copy — the input buffer is reused by the engine after process() returns.
      this.port.postMessage(channel.slice(0));
    }
    return true; // keep the processor alive
  }
}

registerProcessor("wonder-capture", CaptureProcessor);
