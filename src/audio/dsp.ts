import type { VoiceSignals } from '../../shared/types';

export interface UtteranceAudio { samples: Float32Array; sampleRate: number; signals: VoiceSignals }
interface AudioFrame { samples: Float32Array; rms: number; voiced: boolean }

/** Small local signal gate. This measures voice activity, never emotions or diagnoses. */
export class AdaptiveVad {
  private noiseFloor = 0.0012;
  private preRoll: AudioFrame[] = [];
  private frames: AudioFrame[] = [];
  private candidateMs = 0;
  private silenceMs = 0;
  private active = false;
  private totalMs = 0;
  private muted = false;
  private speaking = false;
  private releaseMs: number;
  private roomFrames: Array<{ rms: number; ms: number }> = [];
  private roomDurationMs = 0;
  constructor(private readonly sampleRate: number, silenceMs = 1100) {
    this.releaseMs = clamp(silenceMs, 800, 3000);
  }

  setSilenceMs(value: number) { this.releaseMs = clamp(value, 800, 3000); }
  setSpeaking(value: boolean) { this.speaking = value; }
  setMuted(value: boolean) { this.muted = value; if (value) this.reset(); }
  reset() {
    this.preRoll = []; this.frames = []; this.candidateMs = 0;
    this.silenceMs = 0; this.totalMs = 0; this.active = false;
  }

  process(samples: Float32Array): { level: number; started: boolean; ended?: boolean; utterance?: UtteranceAudio } {
    let sum = 0, peak = 0, crossings = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Number.isFinite(samples[i]) ? samples[i] : 0;
      sum += value * value; peak = Math.max(peak, Math.abs(value));
      if (i && (value >= 0) !== (samples[i - 1] >= 0)) crossings++;
    }
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    // A perceptual display makes ordinary laptop input visible without changing the recording.
    const level = clamp(Math.sqrt(rms) * 2.4, 0, 1);
    if (this.muted || samples.length === 0) return { level: this.muted ? 0 : level, started: false };
    const ms = samples.length / this.sampleRate * 1000;
    // Learn the room's lower energy envelope even after a noisy start opened a candidate.
    // Otherwise a steady fan above the initial threshold can hold a turn open for 45 seconds.
    // Keep the first phrase in the pre-roll instead of discarding audio for a calibration step.
    if (!this.speaking) {
      this.roomFrames.push({ rms, ms }); this.roomDurationMs += ms;
      while (this.roomDurationMs > 2400 && this.roomFrames.length > 1) this.roomDurationMs -= this.roomFrames.shift()!.ms;
      if (this.roomDurationMs >= 600) {
        const levels = this.roomFrames.map(frame => frame.rms).sort((a, b) => a - b);
        this.noiseFloor = clamp(levels[Math.floor(levels.length * 0.15)], 0.0002, 0.05);
      }
    }
    // The old fixed 0.012 RMS floor discarded quiet voices before STT ever ran.
    // Compare to the local room floor instead, with a lower release threshold during a phrase.
    const threshold = Math.max(this.speaking ? 0.012 : this.active ? 0.0018 : 0.0024, this.noiseFloor * (this.speaking ? 4.5 : this.active ? 1.7 : 1.9));
    // Reject near-DC rumbles and high frequency hiss in addition to requiring sustained energy.
    const zcr = crossings / samples.length;
    const voiced = rms > threshold && peak > threshold * 1.3 && zcr > 0.002 && zcr < 0.42;
    const frame = { samples, rms, voiced };
    let started = false;
    if (!this.active) {
      this.preRoll.push(frame);
      while (this.preRoll.length > 1 && duration(this.preRoll, this.sampleRate) > 320) this.preRoll.shift();
      this.candidateMs = voiced ? this.candidateMs + ms : Math.max(0, this.candidateMs - ms * 2);
      if (this.candidateMs < (this.speaking ? 240 : 140)) return { level, started: false };
      this.active = true; this.frames = this.preRoll; this.preRoll = [];
      this.totalMs = duration(this.frames, this.sampleRate); this.silenceMs = 0; started = true;
    } else {
      this.frames.push(frame); this.totalMs += ms;
      this.silenceMs = voiced ? 0 : this.silenceMs + ms;
    }
    if (this.silenceMs < this.releaseMs && this.totalMs < 45000) return { level, started };
    const utterance = this.finish();
    return { level, started, ended: true, utterance };
  }

  private finish(): UtteranceAudio | undefined {
    const frames = this.frames;
    // Retain a short natural tail but do not upload all of the endpoint wait.
    let tailMs = 0;
    while (frames.length > 1 && !frames[frames.length - 1].voiced) {
      const ms = frames[frames.length - 1].samples.length / this.sampleRate * 1000;
      if (tailMs + ms > Math.max(0, this.silenceMs - 240)) break;
      frames.pop(); tailMs += ms;
    }
    const count = frames.reduce((n, frame) => n + frame.samples.length, 0);
    const voicedCount = frames.reduce((n, frame) => n + (frame.voiced ? frame.samples.length : 0), 0);
    const samples = new Float32Array(count);
    let offset = 0, energy = 0, peak = 0;
    for (const frame of frames) {
      samples.set(frame.samples, offset); offset += frame.samples.length;
      energy += frame.rms * frame.samples.length;
      peak = Math.max(peak, frame.rms);
    }
    this.reset();
    if (voicedCount / this.sampleRate < 0.12 || count === 0 || peak <= this.noiseFloor * 1.8) return undefined;
    return { samples, sampleRate: this.sampleRate, signals: {
      durationMs: count / this.sampleRate * 1000,
      voicedRatio: voicedCount / count,
      meanEnergy: energy / count,
      peakEnergy: peak,
    } };
  }
}

function duration(frames: AudioFrame[], rate: number) { return frames.reduce((n, frame) => n + frame.samples.length, 0) / rate * 1000; }
function clamp(value: number, min: number, max: number) { return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min; }

/** Windowed-sinc conversion avoids aliasing when reducing 44.1/48 kHz capture to 16 kHz. */
export function resamplePcm(input: Float32Array, sourceRate: number, targetRate = 16000): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) throw new Error('Invalid audio sample rate');
  if (sourceRate === targetRate) return input.slice();
  const output = new Float32Array(Math.round(input.length * targetRate / sourceRate));
  const ratio = sourceRate / targetRate;
  const cutoff = Math.min(1, targetRate / sourceRate) * 0.94;
  const radius = Math.ceil(16 / cutoff);
  for (let index = 0; index < output.length; index++) {
    const center = index * ratio;
    let sum = 0, weights = 0;
    const first = Math.max(0, Math.ceil(center - radius));
    const last = Math.min(input.length - 1, Math.floor(center + radius));
    for (let j = first; j <= last; j++) {
      const distance = j - center;
      const x = distance * cutoff;
      const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const weight = sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
      sum += input[j] * weight; weights += weight;
    }
    output[index] = weights ? sum / weights : 0;
  }
  return output;
}

export function encodeWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = clamp(samples[i], -1, 1);
    view.setInt16(44 + i * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
