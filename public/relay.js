export class RelayEngine {
  static get senderSupported() {
    return (
      typeof window !== 'undefined' &&
      typeof window.AudioEncoder === 'function' &&
      typeof window.MediaStreamTrackProcessor === 'function' &&
      typeof window.AudioWorkletNode === 'function'
    );
  }

  static get receiverSupported() {
    return (
      typeof window !== 'undefined' &&
      typeof window.AudioDecoder === 'function' &&
      typeof window.AudioWorkletNode === 'function'
    );
  }

  static get supported() {
    return RelayEngine.senderSupported && RelayEngine.receiverSupported;
  }

  constructor(options = {}) {
    this.onFrame = options.onFrame || null;
    this.onPlayback = options.onPlayback || null;
    this.onError = options.onError || null;
    this.onSenderEnd = options.onSenderEnd || null;

    this.sender = null;
    this.receiver = null;
    this.receiverPromise = null;

    this.sentChunks = 0;
    this.sentBytes = 0;
    this.receivedPackets = 0;
    this.decodedBlocks = 0;
    this.decodedFrames = 0;
    this.inputFrames = 0;
    this.lastError = '';
  }

  get senderActive() {
    return Boolean(this.sender);
  }

  get receiverActive() {
    return Boolean(this.receiver);
  }

  get stats() {
    return {
      sentChunks: this.sentChunks,
      sentBytes: this.sentBytes,
      receivedPackets: this.receivedPackets,
      decodedBlocks: this.decodedBlocks,
      decodedFrames: this.decodedFrames,
      inputFrames: this.inputFrames,
      senderActive: this.senderActive,
      receiverActive: this.receiverActive,
      contextState: this.receiver ? this.receiver.context.state : null,
      lastError: this.lastError,
    };
  }

  emitError(scope, error) {
    this.lastError = scope + ': ' + (error && error.message ? error.message : String(error));
    if (this.onError) this.onError(this.lastError, scope);
  }

  async startSender(track) {
    if (this.sender) return;
    if (!RelayEngine.senderSupported) throw new Error('当前浏览器不支持 WebCodecs 音频编码');
    if (!track) throw new Error('没有可发送的音频轨道');

    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    const token = {
      stopped: false,
      reader,
      processor,
      encoder: null,
    };

    const encoder = new AudioEncoder({
      output: (chunk) => this.handleEncodedChunk(token, chunk),
      error: (error) => {
        if (!token.stopped) this.emitError('encoder', error);
      },
    });

    const config = {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 96_000,
    };

    try {
      const support = await AudioEncoder.isConfigSupported(config);
      if (!support.supported) throw new Error('当前浏览器不支持 Opus 音频编码');
      encoder.configure(config);
    } catch (error) {
      try {
        reader.cancel();
      } catch {
        // Ignore.
      }
      throw error;
    }

    token.encoder = encoder;
    this.sender = token;
    this.runSender(token).catch((error) => {
      if (!token.stopped) this.emitError('sender', error);
    });
  }

  async runSender(token) {
    try {
      while (!token.stopped) {
        const { value, done } = await token.reader.read();
        if (done) break;
        if (!value) continue;

        this.inputFrames += value.numberOfFrames;
        if (token.stopped || !token.encoder || token.encoder.state !== 'configured') {
          value.close();
          break;
        }

        try {
          token.encoder.encode(value);
        } finally {
          value.close();
        }
      }
    } catch (error) {
      if (!token.stopped) this.emitError('sender', error);
    } finally {
      if (this.sender === token) {
        this.sender = null;
        if (this.onSenderEnd) this.onSenderEnd();
      }
    }
  }

  handleEncodedChunk(token, chunk) {
    if (!this.sender || this.sender !== token || token.stopped) return;
    if (!chunk.byteLength) return;

    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);

    const buffer = new ArrayBuffer(9 + payload.byteLength);
    const view = new DataView(buffer);
    view.setUint8(0, 1);
    view.setFloat64(1, Math.max(0, Number(chunk.timestamp) || 0), true);
    new Uint8Array(buffer, 9).set(payload);

    this.sentChunks += 1;
    this.sentBytes += payload.byteLength;
    if (this.onFrame) this.onFrame(buffer);
  }

  stopSender() {
    const token = this.sender;
    if (!token) return;
    token.stopped = true;
    this.sender = null;

    try {
      token.reader.cancel();
    } catch {
      // Ignore.
    }
    try {
      token.encoder.close();
    } catch {
      // Ignore.
    }
  }

  async activateReceiver() {
    if (this.receiver) {
      await this.resume();
      return this.receiver;
    }
    if (this.receiverPromise) return this.receiverPromise;

    this.receiverPromise = this.createReceiver();
    try {
      return await this.receiverPromise;
    } finally {
      this.receiverPromise = null;
    }
  }

  async createReceiver() {
    if (!RelayEngine.receiverSupported) throw new Error('当前浏览器不支持 WebCodecs 音频解码');

    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    try {
      await context.audioWorklet.addModule('/relay-worklet.js');
      const node = new AudioWorkletNode(context, 'soundbridge-relay-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const destination = context.createMediaStreamDestination();
      node.connect(destination);

      const decoder = new AudioDecoder({
        output: (data) => this.handleDecodedData(data),
        error: (error) => this.emitError('decoder', error),
      });
      decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });

      if (context.state === 'suspended') {
        await context.resume().catch(() => {});
      }

      this.receiver = { context, node, destination, decoder };
      if (this.onPlayback) this.onPlayback(destination.stream);
      return this.receiver;
    } catch (error) {
      try {
        await context.close();
      } catch {
        // Ignore.
      }
      throw error;
    }
  }

  handleDecodedData(data) {
    const frames = data.numberOfFrames;
    const channels = data.numberOfChannels;

    try {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
      if (channels > 1) {
        data.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
      } else {
        right.set(left);
      }
      data.close();

      if (!this.receiver) return;
      this.decodedBlocks += 1;
      this.decodedFrames += frames;
      this.receiver.node.port.postMessage(
        { type: 'push', left, right },
        [left.buffer, right.buffer],
      );
    } catch (error) {
      try {
        data.close();
      } catch {
        // Ignore.
      }
      this.emitError('decoded-output', error);
    }
  }

  async receivePacket(buffer) {
    if (!this.receiver) await this.activateReceiver();
    if (!this.receiver) return;

    const view = new DataView(buffer);
    if (view.byteLength <= 9 || view.getUint8(0) !== 1) return;

    const timestamp = view.getFloat64(1, true);
    const payload = new Uint8Array(buffer, 9);
    const decoder = this.receiver.decoder;

    if (!decoder || decoder.state !== 'configured') return;

    try {
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp,
          data: payload,
        }),
      );
      this.receivedPackets += 1;
    } catch (error) {
      this.emitError('decoder-input', error);
    }
  }

  async resume() {
    if (!this.receiver) return;
    if (this.receiver.context.state === 'suspended') {
      await this.receiver.context.resume().catch(() => {});
    }
  }

  stopReceiver() {
    const receiver = this.receiver;
    this.receiver = null;
    if (!receiver) return;

    try {
      receiver.decoder.close();
    } catch {
      // Ignore.
    }
    try {
      receiver.node.port.postMessage({ type: 'reset' });
    } catch {
      // Ignore.
    }
    try {
      receiver.context.close();
    } catch {
      // Ignore.
    }
    if (this.onPlayback) this.onPlayback(null);
  }

  close() {
    this.stopSender();
    this.stopReceiver();
  }
}
