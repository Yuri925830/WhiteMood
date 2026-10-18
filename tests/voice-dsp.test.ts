import { describe, expect, it } from 'vitest';
import { AdaptiveVad, encodeWav, resamplePcm } from '../src/audio/dsp';

function tone(amplitude: number, samples = 960, frequency = 180, rate = 48000) {
  return Float32Array.from({ length: samples }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * index / rate));
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
