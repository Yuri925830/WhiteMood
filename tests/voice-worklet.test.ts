import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Processor { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean }

/** Executes the exact public worklet, with synthetic PCM instead of a real user's microphone. */
describe('deployed microphone AudioWorklet', () => {
  it.each([44100, 48000])('preserves mono PCM across browser render quanta at %i Hz and keeps monitoring silent', rate => {
    const frames: Float32Array[] = [];
    let constructor: (new () => Processor) | undefined;
    class AudioWorkletProcessor {
      port = { postMessage: (samples: Float32Array) => { frames.push(Float32Array.from(samples)); } };
    }
    runInNewContext(readFileSync(new URL('../public/audio/capture.worklet.js', import.meta.url), 'utf8'), {
      sampleRate: rate, Float32Array, AudioWorkletProcessor,
      registerProcessor: (name: string, value: new () => Processor) => { expect(name).toBe('whitemood-capture'); constructor = value; },
    });
    const processor = new constructor!();
    const samples: number[] = [];
    for (let block = 0; block < 100; block++) {
      const input = Float32Array.from({ length: 128 }, (_, i) => 0.006 * Math.sin(2 * Math.PI * 180 * (block * 128 + i) / rate));
      samples.push(...input);
      const output = new Float32Array(128).fill(1);
      expect(processor.process([[input]], [[output]])).toBe(true);
      expect(output.every(value => value === 0)).toBe(true);
    }
    const size = Math.round(rate * 0.02);
    expect(frames.length).toBe(Math.floor(samples.length / size));
    expect(frames.every(frame => frame.length === size)).toBe(true);
    expect(frames.flatMap(frame => [...frame])).toEqual(samples.slice(0, frames.length * size));
  });

  it('does not invent audio when the input track stops supplying samples', () => {
    const frames: Float32Array[] = [];
    let constructor: (new () => Processor) | undefined;
    class AudioWorkletProcessor { port = { postMessage: (samples: Float32Array) => { frames.push(samples); } }; }
    runInNewContext(readFileSync(new URL('../public/audio/capture.worklet.js', import.meta.url), 'utf8'), {
      sampleRate: 48000, Float32Array, AudioWorkletProcessor,
      registerProcessor: (_name: string, value: new () => Processor) => { constructor = value; },
    });
    const processor = new constructor!();
    for (let i = 0; i < 100; i++) processor.process([[]], [[new Float32Array(128)]]);
    expect(frames).toHaveLength(0);
  });
});
