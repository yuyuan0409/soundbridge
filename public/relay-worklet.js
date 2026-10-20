class SoundBridgeRelayPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 96000;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
    this.started = false;
    this.framesPlayed = 0;
    this.underruns = 0;
    this.lastStatsAt = 0;

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'reset') {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        this.started = false;
        return;
      }
      if (message.type === 'push' && message.left && message.right) {
        this.push(message.left, message.right);
      }
    };
  }

  push(left, right) {
    const frames = Math.min(left.length, right.length);
    if (!frames) return;

    if (frames >= this.capacity) {
      left = left.subarray(frames - this.capacity);
      right = right.subarray(frames - this.capacity);
      this.readIndex = 0;
      this.writeIndex = 0;
      this.available = 0;
      this.started = false;
    }

    const overflow = this.available + frames - this.capacity;
    if (overflow > 0) {
      this.readIndex = (this.readIndex + overflow) % this.capacity;
      this.available -= overflow;
    }

    for (let index = 0; index < frames; index += 1) {
      const position = (this.writeIndex + index) % this.capacity;
      this.left[position] = left[index];
      this.right[position] = right[index];
    }

    this.writeIndex = (this.writeIndex + frames) % this.capacity;
    this.available += frames;

    if (!this.started && this.available >= 2400) this.started = true;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;

    const frames = output[0].length;
    if (!this.started) {
      for (let index = 0; index < frames; index += 1) {
        output[0][index] = 0;
        if (output[1]) output[1][index] = 0;
      }
      return true;
    }

    for (let index = 0; index < frames; index += 1) {
      let sampleLeft = 0;
      let sampleRight = 0;

      if (this.available > 0) {
        sampleLeft = this.left[this.readIndex];
        sampleRight = this.right[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.available -= 1;
      } else {
        this.started = false;
        this.underruns += 1;
        break;
      }

      output[0][index] = sampleLeft;
      if (output[1]) output[1][index] = sampleRight;
    }

    this.framesPlayed += frames;
    if (this.framesPlayed - this.lastStatsAt >= 48000) {
      this.lastStatsAt = this.framesPlayed;
      this.port.postMessage({
        type: 'stats',
        framesPlayed: this.framesPlayed,
        available: this.available,
        underruns: this.underruns,
      });
    }

    return true;
  }
}

registerProcessor('soundbridge-relay-player', SoundBridgeRelayPlayer);
