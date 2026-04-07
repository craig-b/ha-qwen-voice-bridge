class ResamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputSampleRate = options.processorOptions.inputSampleRate;
    this.outputSampleRate = 16000;
    this.ratio = this.inputSampleRate / this.outputSampleRate;
    this.lastSample = 0;
    this.inputOffset = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input || input.length === 0) return true;

    const outputLength = Math.floor(
      (input.length + this.inputOffset) / this.ratio
    );
    if (outputLength <= 0) {
      this.inputOffset += input.length;
      return true;
    }

    const pcm16 = new Int16Array(outputLength);
    let rmsSum = 0;

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * this.ratio - this.inputOffset;
      let sample;

      if (srcIndex < 0) {
        sample = this.lastSample;
      } else {
        const idx0 = Math.floor(srcIndex);
        const idx1 = Math.min(idx0 + 1, input.length - 1);
        const frac = srcIndex - idx0;
        sample = input[idx0] + frac * (input[idx1] - input[idx0]);
      }

      // Clamp and convert float32 to int16
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      rmsSum += clamped * clamped;
    }

    this.inputOffset =
      (input.length + this.inputOffset) - outputLength * this.ratio;
    this.lastSample = input[input.length - 1];

    this.port.postMessage(
      { pcm16: pcm16.buffer, rms: Math.sqrt(rmsSum / outputLength) },
      [pcm16.buffer]
    );

    return true;
  }
}

registerProcessor("resampler-processor", ResamplerProcessor);
