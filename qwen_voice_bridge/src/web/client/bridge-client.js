// Reusable voice bridge client — no DOM dependencies.
// Handles WebSocket protocol, audio capture (mic → 16 kHz PCM16), and playback.
// Extend EventTarget so consumers can listen for statuschange / error / audiolevel.

const FrameType = { HELLO: 0x01, AUDIO: 0x02, END: 0x03, ERROR: 0x04 };

function encodeFrame(type, payload) {
  const p = payload ? new Uint8Array(payload) : new Uint8Array(0);
  const frame = new Uint8Array(3 + p.length);
  frame[0] = type;
  new DataView(frame.buffer).setUint16(1, p.length, false);
  frame.set(p, 3);
  return frame.buffer;
}

function decodeFrame(buffer) {
  const view = new DataView(buffer);
  const type = view.getUint8(0);
  const length = view.getUint16(1, false);
  const payload = buffer.slice(3, 3 + length);
  return { type, payload };
}

export class BridgeClient extends EventTarget {
  #ws = null;
  #audioCtx = null;
  #mediaStream = null;
  #workletNode = null;
  #status = "disconnected";
  #satelliteId;
  #playbackQueue = [];
  #nextPlayTime = 0;

  constructor(satelliteId = "web-client") {
    super();
    this.#satelliteId = satelliteId;
  }

  get status() {
    return this.#status;
  }

  async connect(url) {
    if (this.#ws) return;
    this.#setStatus("connecting");

    try {
      // Set up audio context and mic capture first so we fail fast on permission denial
      this.#audioCtx = new AudioContext({ sampleRate: 48000 });
      this.#mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });

      await this.#initCapturePipeline();

      // Open WebSocket
      this.#ws = new WebSocket(url);
      this.#ws.binaryType = "arraybuffer";

      this.#ws.onopen = () => {
        // Send HELLO
        const id = new TextEncoder().encode(this.#satelliteId);
        this.#ws.send(encodeFrame(FrameType.HELLO, id));
        this.#setStatus("connected");
      };

      this.#ws.onmessage = (ev) => this.#onMessage(ev.data);
      this.#ws.onclose = () => this.#cleanup("disconnected");
      this.#ws.onerror = () => {
        this.dispatchEvent(new CustomEvent("error", { detail: "WebSocket error" }));
        this.#cleanup("disconnected");
      };
    } catch (err) {
      this.dispatchEvent(
        new CustomEvent("error", { detail: err.message || String(err) })
      );
      this.#cleanup("disconnected");
    }
  }

  disconnect() {
    if (!this.#ws) return;
    // Send END frame before closing
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(encodeFrame(FrameType.END));
    }
    this.#cleanup("disconnected");
  }

  // ── Audio capture ──────────────────────────────────────────────

  async #initCapturePipeline() {
    const ctx = this.#audioCtx;
    const source = ctx.createMediaStreamSource(this.#mediaStream);

    try {
      await ctx.audioWorklet.addModule("resampler-processor.js");
      this.#workletNode = new AudioWorkletNode(ctx, "resampler-processor", {
        processorOptions: { inputSampleRate: ctx.sampleRate },
      });
      this.#workletNode.port.onmessage = (ev) => {
        const { pcm16, rms } = ev.data;
        this.dispatchEvent(new CustomEvent("audiolevel", { detail: rms }));
        if (this.#ws?.readyState === WebSocket.OPEN) {
          this.#ws.send(encodeFrame(FrameType.AUDIO, pcm16));
        }
      };
      source.connect(this.#workletNode);
      // Worklet doesn't need to connect to destination — we just capture
      this.#workletNode.connect(ctx.destination); // needed to keep processing alive
    } catch {
      // AudioWorklet unavailable (non-secure context) — fall back to ScriptProcessor
      this.#initScriptProcessorFallback(source);
    }
  }

  #initScriptProcessorFallback(source) {
    const ctx = this.#audioCtx;
    const bufSize = 4096;
    const processor = ctx.createScriptProcessor(bufSize, 1, 1);
    const ratio = ctx.sampleRate / 16000;

    let inputOffset = 0;
    let lastSample = 0;

    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const outputLength = Math.floor((input.length + inputOffset) / ratio);
      if (outputLength <= 0) {
        inputOffset += input.length;
        return;
      }

      const pcm16 = new Int16Array(outputLength);
      let rmsSum = 0;
      for (let i = 0; i < outputLength; i++) {
        const srcIndex = i * ratio - inputOffset;
        let sample;
        if (srcIndex < 0) {
          sample = lastSample;
        } else {
          const idx0 = Math.floor(srcIndex);
          const idx1 = Math.min(idx0 + 1, input.length - 1);
          const frac = srcIndex - idx0;
          sample = input[idx0] + frac * (input[idx1] - input[idx0]);
        }
        const clamped = Math.max(-1, Math.min(1, sample));
        pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        rmsSum += clamped * clamped;
      }

      inputOffset = (input.length + inputOffset) - outputLength * ratio;
      lastSample = input[input.length - 1];

      this.dispatchEvent(
        new CustomEvent("audiolevel", { detail: Math.sqrt(rmsSum / outputLength) })
      );
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(encodeFrame(FrameType.AUDIO, pcm16.buffer));
      }

      // Pass through silence to keep processor alive
      const out = ev.outputBuffer.getChannelData(0);
      out.fill(0);
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  }

  // ── Incoming messages ──────────────────────────────────────────

  #onMessage(data) {
    const { type, payload } = decodeFrame(data);
    switch (type) {
      case FrameType.AUDIO:
        this.#playAudio(payload);
        break;
      case FrameType.END:
        this.#cleanup("disconnected");
        break;
      case FrameType.ERROR: {
        const msg = new TextDecoder().decode(payload);
        this.dispatchEvent(new CustomEvent("error", { detail: msg }));
        this.#cleanup("disconnected");
        break;
      }
    }
  }

  // ── Audio playback ─────────────────────────────────────────────

  #playAudio(pcm16Buffer) {
    const ctx = this.#audioCtx;
    if (!ctx) return;

    const pcm16 = new Int16Array(pcm16Buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, 16000);
    audioBuffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, this.#nextPlayTime);
    source.start(startTime);
    this.#nextPlayTime = startTime + audioBuffer.duration;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  #cleanup(newStatus) {
    if (this.#workletNode) {
      this.#workletNode.disconnect();
      this.#workletNode = null;
    }
    if (this.#mediaStream) {
      this.#mediaStream.getTracks().forEach((t) => t.stop());
      this.#mediaStream = null;
    }
    if (this.#audioCtx) {
      this.#audioCtx.close().catch(() => {});
      this.#audioCtx = null;
    }
    if (this.#ws) {
      this.#ws.onclose = null; // prevent re-entrant cleanup
      if (this.#ws.readyState === WebSocket.OPEN ||
          this.#ws.readyState === WebSocket.CONNECTING) {
        this.#ws.close();
      }
      this.#ws = null;
    }
    this.#nextPlayTime = 0;
    this.#setStatus(newStatus);
  }

  #setStatus(s) {
    if (s === this.#status) return;
    this.#status = s;
    this.dispatchEvent(new CustomEvent("statuschange", { detail: s }));
  }
}
