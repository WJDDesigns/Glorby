// Hears music through this device's microphone, for the Music effects. Inside Home
// Assistant the lamp's own microphone does this job. The shaping matches core/audio.py.

const SILENCE_AFTER = 1;

export class Mic {
  constructor(audio) {
    this.audio = audio;
    this.bassAvg = 0;
    this.heard = -Infinity;
    this.starting = null;
  }

  /** Ask for the microphone. Call from a click, since browsers only ask then. */
  start() {
    if (this.starting) return this.starting;
    if (!navigator.mediaDevices?.getUserMedia) return Promise.resolve(false);
    this.starting = navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } })
      .then((stream) => {
        const Context = window.AudioContext || window.webkitAudioContext;
        this.context = new Context();
        const source = this.context.createMediaStreamSource(stream);
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.5;
        source.connect(this.analyser);
        this.spectrum = new Uint8Array(this.analyser.frequencyBinCount);
        this.wave = new Uint8Array(this.analyser.fftSize);
        // 16 bands spaced by pitch, from 60 Hz to 12 kHz, like the lamp's sound sync.
        const hz = this.context.sampleRate / this.analyser.fftSize;
        this.edges = Array.from({ length: 17 }, (_, i) => Math.max(1, Math.round((60 * 200 ** (i / 16)) / hz)));
        this.stream = stream;
        return true;
      })
      .catch(() => {
        this.starting = null;
        return false;
      });
    return this.starting;
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close();
    this.analyser = null;
    this.starting = null;
  }

  /** Read the microphone and shape it into values that animate well. */
  update(dt, now) {
    const a = this.audio;
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this.spectrum);
      this.analyser.getByteTimeDomainData(this.wave);
      let sum = 0;
      for (const v of this.wave) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / this.wave.length);
      const bins = this.edges.slice(0, 16).map((low, i) => {
        const high = Math.max(low + 1, this.edges[i + 1]);
        let peak = 0;
        for (let k = low; k < high && k < this.spectrum.length; k++) peak = Math.max(peak, this.spectrum[k]);
        return peak / 255;
      });
      if (rms > 0.002) this.heard = now;
      a.active = true;
      a.bins = a.bins.map((v, i) => v + (bins[i] - v) * (bins[i] > v ? 0.7 : 0.25));
      a.level = Math.min(1, rms * 4);
      const mean = (from, to) => a.bins.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);
      a.bass = mean(0, 3);
      a.mid = mean(3, 9);
      a.treble = mean(9, 16);
      this.bassAvg += (a.bass - this.bassAvg) * 0.04;
      if (a.bass > this.bassAvg * 1.45 && a.bass > 0.2) a.beat = 1;
    }
    a.beat *= Math.exp(-dt * 7);
    if (now - this.heard > SILENCE_AFTER) {
      a.active = !!this.analyser;
      a.bins = a.bins.map((v) => v * Math.exp(-dt * 3));
      a.level = a.bass = a.mid = a.treble = 0;
    }
  }
}
