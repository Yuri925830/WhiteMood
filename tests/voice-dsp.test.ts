import { describe, expect, it } from 'vitest';
import { AdaptiveVad, encodeWav, resamplePcm } from '../src/audio/dsp';

function tone(amplitude: number, samples = 960, frequency = 180, rate = 48000) {
  return Float32Array.from({ length: samples }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * index / rate));
}

function roomNoise(frameCount: number, rms: number): Float32Array[] {
  let seed = 47, filtered = 0;
  const samples = Float32Array.from({ length: frameCount * 960 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    filtered = 0.85 * filtered + 0.15 * (seed / 0xffffffff * 2 - 1);
    return filtered;
  });
  const energy = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  return Array.from({ length: frameCount }, (_, i) => samples.slice(i * 960, (i + 1) * 960).map(value => value * rms / energy));
}

describe('real captured PCM processing', () => {
  it('writes mono 16-bit WAV metadata, signed values and saturation', async () => {
    const blob = encodeWav(new Float32Array([-2, -1, 0, 1, 2]));
    const view = new DataView(await blob.arrayBuffer());
    expect(blob.type).toBe('audio/wav');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(10);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(0);
    expect(view.getInt16(52, true)).toBe(32767);
  });

  it('preserves duration while suppressing frequencies above the new Nyquist limit', () => {
    const speechBand = resamplePcm(tone(0.5, 48000, 1000), 48000);
    const aboveNyquist = resamplePcm(tone(0.5, 48000, 12000), 48000);
    const rms = (values: Float32Array) => Math.sqrt(values.slice(100, -100).reduce((sum, value) => sum + value * value, 0) / (values.length - 200));
    expect(speechBand.length).toBe(16000);
    expect(rms(speechBand)).toBeCloseTo(0.3535, 2);
    expect(rms(aboveNyquist)).toBeLessThan(0.015);
  });
});

describe('automatic local turn detection', () => {
  it('learns a fan above the initial threshold and ends a voice turn after returning to that same noise', () => {
    const vad = new AdaptiveVad(48000, 1000);
    const noise = roomNoise(250, 0.004);
    const startup = noise.slice(0, 100).map(frame => vad.process(frame));
    expect(startup.some(result => result.ended)).toBe(true);
    expect(startup.some(result => result.utterance)).toBe(false);
    const speech = noise.slice(100, 150).map((frame, index) => {
      const voice = tone(0.024 * (0.8 + 0.2 * Math.sin(index / 4)));
      return vad.process(frame.map((value, i) => value + voice[i]));
    });
    const pause = noise.slice(150, 250).map(frame => vad.process(frame));
    expect(speech.filter(result => result.started)).toHaveLength(1);
    expect(pause.flatMap(result => result.utterance ? [result.utterance] : [])).toHaveLength(1);
    expect(pause.findIndex(result => !!result.utterance)).toBeLessThan(70);
  });

  it.each([44100, 48000])('captures a quiet laptop-level voice at %i Hz after room noise without a sensitivity setting', rate => {
    const vad = new AdaptiveVad(rate, 1000);
    const frame = (amplitude: number) => tone(amplitude, Math.round(rate * 0.02), 180, rate);
    for (let i = 0; i < 250; i++) expect(vad.process(frame(0.001)).started).toBe(false);
    const results = Array.from({ length: 35 }, (_, i) => vad.process(frame(0.006 + 0.001 * Math.sin(i / 3))));
    results.push(...Array.from({ length: 60 }, () => vad.process(frame(0.001))));
    expect(results.filter(result => result.started)).toHaveLength(1);
    const utterances = results.flatMap(result => result.utterance ? [result.utterance] : []);
    expect(utterances).toHaveLength(1);
    expect(utterances[0].signals.meanEnergy).toBeLessThan(0.006);
    expect(utterances[0].signals.durationMs).toBeGreaterThan(500);
  });

  it('retains the start of a quiet first phrase without making the user wait for room calibration', () => {
    const vad = new AdaptiveVad(48000, 1000);
    const first = tone(0.006);
    const results = Array.from({ length: 35 }, () => vad.process(first));
    results.push(...Array.from({ length: 75 }, () => vad.process(tone(0))));
    const utterance = results.find(result => result.utterance)?.utterance;
    expect(utterance).toBeDefined();
    expect(utterance!.samples.slice(0, first.length)).toEqual(first);
    expect(results.filter(result => result.started)).toHaveLength(1);
  });

  it('does not let assistant playback raise the noise floor and suppress the next quiet user turn', () => {
    const vad = new AdaptiveVad(48000, 1000);
    vad.setSpeaking(true);
    for (let i = 0; i < 500; i++) expect(vad.process(tone(0.014)).started).toBe(false);
    vad.setSpeaking(false);
    const results = Array.from({ length: 30 }, () => vad.process(tone(0.006)));
    results.push(...Array.from({ length: 60 }, () => vad.process(tone(0.001))));
    expect(results.filter(result => result.started)).toHaveLength(1);
    expect(results.some(result => result.utterance)).toBe(true);
  });

  it('ignores ambient noise and a one-frame transient instead of opening a turn', () => {
    const vad = new AdaptiveVad(48000, 600);
    const results = Array.from({ length: 30 }, () => vad.process(tone(0.003)));
    results.push(vad.process(tone(0.4)));
    results.push(...Array.from({ length: 60 }, () => vad.process(tone(0.003))));
    expect(results.some(result => result.started || result.utterance)).toBe(false);
  });

  it('captures sustained speech with pre-roll and a short tail, using actual sample duration', () => {
    const vad = new AdaptiveVad(48000, 600);
    for (let i = 0; i < 30; i++) vad.process(tone(0.003));
    const results = Array.from({ length: 20 }, () => vad.process(tone(0.08)));
    results.push(...Array.from({ length: 40 }, () => vad.process(tone(0.003))));
    expect(results.filter(result => result.started)).toHaveLength(1);
    const completed = results.flatMap(result => result.utterance ? [result.utterance] : []);
    expect(completed).toHaveLength(1);
    expect(completed[0].signals.durationMs).toBe(completed[0].samples.length / 48);
    expect(completed[0].signals.durationMs).toBeGreaterThan(600);
    expect(completed[0].signals.durationMs).toBeLessThan(1000);
    expect(completed[0].signals.voicedRatio).toBeGreaterThan(0.4);
    expect(completed[0].signals.peakEnergy).toBeGreaterThan(0.05);
  });

  it('requires sustained barge-in and discards muted/pending audio', () => {
    const vad = new AdaptiveVad(48000, 600);
    vad.setSpeaking(true);
    for (let i = 0; i < 10; i++) expect(vad.process(tone(0.08)).started).toBe(false);
    expect(vad.process(tone(0.08)).started).toBe(false);
    expect(vad.process(tone(0.08)).started).toBe(true);
    vad.setMuted(true);
    for (let i = 0; i < 50; i++) expect(vad.process(tone(0.2))).toEqual({ level: 0, started: false });
    vad.setMuted(false);
    for (let i = 0; i < 40; i++) expect(vad.process(tone(0)).utterance).toBeUndefined();
  });

  it.each([
    { value: 3000, frames: 150, update: false },
    { value: 3000, frames: 150, update: true },
    { value: 10000, frames: 150, update: true },
    { value: 0, frames: 40, update: true },
  ])('honors the UI pause range with $value ms (runtime update: $update)', ({ value, frames, update }) => {
    const vad = new AdaptiveVad(48000, update ? 1400 : value);
    if (update) vad.setSilenceMs(value);
    for (let i = 0; i < 20; i++) vad.process(tone(0.08));
    for (let i = 0; i < frames - 1; i++) expect(vad.process(tone(0)).utterance).toBeUndefined();
    expect(vad.process(tone(0)).utterance).toBeDefined();
  });
});
