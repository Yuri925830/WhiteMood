import { describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../server/api';

const epoch = 1_800_000_000_000;

function wav(samples = 800): Blob {
  const bytes = new Uint8Array(44 + samples * 2); const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => [...text].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples * 2, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });

function request(frameCount = 2) {
  const form = new FormData(); form.set('file', wav(), 'private.wav'); form.set('language', 'zh');
  for (let index = 0; index < frameCount; index++) {
    form.append('frame', jpeg(), `private-${index}.jpg`);
    form.append('frame_captured_at', String(epoch - 1000 + index));
  }
  return new Request('http://127.0.0.1:8787/api/transcribe', { method: 'POST', body: form });
}

describe('hybrid turn analysis orchestration', () => {
  it('keeps frames local to the analysis service and returns bounded unified evidence', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => {
      if (String(url).startsWith('http://127.0.0.1:8790/')) return Response.json({
        acoustics: { durationMs: 1200, voicedRatio: 0.65, meanEnergy: 0.03, peakEnergy: 0.1, quality: 0.9, pitchMeanHz: 180, pitchRangeHz: 55, pauseCount: 1, pauseDurationMs: 220, maxPauseMs: 220 },
        face: { quality: 0.82, confidence: 0.7, features: { expression_neutral: 0.7, expression_happiness: 0.3 } },
        modules: { acoustics: { status: 'ok', latencyMs: 12, confidence: 0.9 }, face: { status: 'ok', latencyMs: 18, confidence: 0.7 } },
      });
      return Response.json({ text: '我今天还好。' });
    });
    const handler = createApiHandler({ apiKey: 'test', analysisUrl: 'http://127.0.0.1:8790', analysisToken: 'sidecar-secret' }, { fetch, now: () => epoch });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: '我今天还好。',
      voice: { source: 'local', durationMs: 1200, voicedRatio: 0.65, meanEnergy: 0.03, peakEnergy: 0.1, quality: 0.9, pitchMeanHz: 180, pitchRangeHz: 55, pauseCount: 1, pauseDurationMs: 220, maxPauseMs: 220 },
      cv: { source: 'face', capturedAt: epoch - 999, quality: 0.82, features: { expression_neutral: 0.7, expression_happiness: 0.3 } },
      analysis: { modules: { stt: { status: 'ok', latencyMs: 0 }, acoustics: { status: 'ok', latencyMs: 12, confidence: 0.9 }, face: { status: 'ok', latencyMs: 18, confidence: 0.7 } } },
    });
    const analysisCall = fetch.mock.calls.find(([url]) => String(url).startsWith('http://127.0.0.1:8790/'))!;
    expect(new Headers(analysisCall[1]?.headers).get('x-whitemood-analysis-token')).toBe('sidecar-secret');
    const analysisForm = analysisCall[1]?.body as FormData;
    expect(analysisForm.getAll('frames')).toHaveLength(2);
    const groqCall = fetch.mock.calls.find(([url]) => String(url).includes('api.groq.com'))!;
    const groqForm = groqCall[1]?.body as FormData;
    expect(groqForm.getAll('frame')).toEqual([]);
    expect([...groqForm.keys()].sort()).toEqual(['file', 'language', 'model', 'response_format', 'temperature']);
  });

  it('keeps a successful transcript when the optional analysis service is offline', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => {
      if (String(url).startsWith('http://127.0.0.1:8790/')) throw new TypeError('offline');
      return Response.json({ text: 'Transcript survives.' });
    });
    const response = await createApiHandler({ apiKey: 'test', analysisUrl: 'http://127.0.0.1:8790' }, { fetch, now: () => epoch })(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: 'Transcript survives.',
      analysis: { modules: { stt: { status: 'ok', latencyMs: 0 }, acoustics: { status: 'unavailable', latencyMs: 0 }, face: { status: 'unavailable', latencyMs: 0 } } },
    });
  });

  it('rejects incomplete or forged image batches before either upstream is called', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const handler = createApiHandler({ apiKey: 'test', analysisUrl: 'http://127.0.0.1:8790' }, { fetch, now: () => epoch });
    expect((await handler(request(1))).status).toBe(400);
    const forged = request(); const form = await forged.formData(); form.set('frame_captured_at', String(epoch + 10_000));
    expect((await handler(new Request(forged.url, { method: 'POST', body: form }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
