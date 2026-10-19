import type { AnalysisModuleStatus, CvObservation, TurnAnalysis, VoiceSignals } from '../shared/types';
import { ApiFailure } from './validation';

const MAX_RESULT_BYTES = 64 * 1024;
const featureName = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

export interface AnalysisConfig {
  url?: string;
  token?: string;
  timeoutMs?: number;
}

export interface AnalysisFrame {
  image: Blob;
  capturedAt: number;
}

export interface LocalAnalysisResult {
  voice?: VoiceSignals;
  cv?: CvObservation;
  analysis: Omit<TurnAnalysis, 'modules'> & { modules: Pick<TurnAnalysis['modules'], 'acoustics' | 'face'> };
}

type Obj = Record<string, unknown>;

const object = (value: unknown): Obj | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : undefined;
const bounded = (value: unknown, min: number, max: number): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
const round = (value: number) => Math.round(value * 1000) / 1000;

function baseUrl(input: string): string {
  try {
    const url = new URL(input);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new ApiFailure(503, 'ANALYSIS_CONFIGURATION', 'The local analysis service URL needs configuration.');
  }
}

async function limitedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESULT_BYTES)) throw new Error();
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESULT_BYTES) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function moduleStatus(value: unknown, fallback: AnalysisModuleStatus['status']): AnalysisModuleStatus {
  const item = object(value);
  const status = item && ['ok', 'skipped', 'unavailable', 'error'].includes(String(item.status))
    ? item.status as AnalysisModuleStatus['status'] : fallback;
  const latencyMs = bounded(item?.latencyMs, 0, 120_000) ?? 0;
  const confidence = bounded(item?.confidence, 0, 1);
  return { status, latencyMs: Math.round(latencyMs), ...(confidence === undefined ? {} : { confidence: round(confidence) }) };
}

function acoustic(value: unknown): VoiceSignals | undefined {
  const item = object(value); if (!item) return undefined;
  const durationMs = bounded(item.durationMs, 0, 120_000);
  const voicedRatio = bounded(item.voicedRatio, 0, 1);
  const meanEnergy = bounded(item.meanEnergy, 0, 1);
  const peakEnergy = bounded(item.peakEnergy, 0, 1);
  const quality = bounded(item.quality, 0, 1);
  if ([durationMs, voicedRatio, meanEnergy, peakEnergy, quality].some(value => value === undefined)) return undefined;
  const result: VoiceSignals = { source: 'local', durationMs: Math.round(durationMs!), voicedRatio: round(voicedRatio!), meanEnergy: round(meanEnergy!), peakEnergy: round(peakEnergy!), quality: round(quality!) };
  const optional: Array<[keyof VoiceSignals, number, number, boolean?]> = [
    ['pitchMeanHz', 40, 2000], ['pitchRangeHz', 0, 2000], ['pitchStdHz', 0, 2000],
    ['pauseCount', 0, 100, true], ['pauseDurationMs', 0, 120_000, true], ['maxPauseMs', 0, 120_000, true],
  ];
  for (const [key, min, max, integer] of optional) {
    const parsed = bounded(item[key], min, max);
    if (parsed !== undefined) Object.assign(result, { [key]: integer ? Math.round(parsed) : round(parsed) });
  }
  return result;
}

function face(value: unknown, capturedAt: number): CvObservation | undefined {
  const item = object(value); if (!item) return undefined;
  const quality = bounded(item.quality, 0.5, 1); if (quality === undefined) return undefined;
  const raw = object(item.features); if (!raw) return undefined;
  const entries = Object.entries(raw).filter(([key, score]) => featureName.test(key) && bounded(score, 0, 1) !== undefined).slice(0, 32);
  if (!entries.length) return undefined;
  return { source: 'face', capturedAt, quality: round(quality), features: Object.fromEntries(entries.map(([key, score]) => [key, round(score as number)])) };
}

export function createAnalysisClient(config: AnalysisConfig, fetcher: typeof globalThis.fetch, now: () => number) {
  const configured = Boolean(config.url?.trim());
  const endpoint = configured ? `${baseUrl(config.url!.trim())}/v1/analyze/turn` : '';
  const token = config.token?.trim() ?? '';
  if (token.length > 4096) throw new ApiFailure(503, 'ANALYSIS_CONFIGURATION', 'The local analysis service token is invalid.');
  const timeoutMs = Math.max(500, Math.min(config.timeoutMs ?? 15_000, 60_000));

  return {
    configured,
    async analyze(audio: Blob, frames: AnalysisFrame[], signal: AbortSignal): Promise<LocalAnalysisResult> {
      const faceFallback = frames.length ? 'unavailable' : 'skipped';
      if (!configured) return { analysis: { modules: { acoustics: moduleStatus(null, 'unavailable'), face: moduleStatus(null, faceFallback) } } };
      const form = new FormData(); form.set('audio', audio, 'utterance.wav');
      for (const [index, frame] of frames.entries()) {
        form.append('frames', frame.image, `frame-${index + 1}.jpg`);
        form.append('captured_at', String(frame.capturedAt));
      }
      const controller = new AbortController(); let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        const headers = new Headers(); if (token) headers.set('X-WhiteMood-Analysis-Token', token);
        const response = await fetcher(endpoint, { method: 'POST', headers, body: form, signal: controller.signal });
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
        const result = object(await limitedJson(response)); if (!result) throw new Error();
        const voice = acoustic(result.acoustics);
        const capturedAt = frames.length ? frames.reduce((latest, frame) => Math.max(latest, frame.capturedAt), 0) : now();
        const cv = face(result.face, capturedAt);
        const modules = object(result.modules);
        const acoustics = moduleStatus(modules?.acoustics, voice ? 'ok' : 'error');
        const faceStatus = moduleStatus(modules?.face, cv ? 'ok' : (frames.length ? 'error' : 'skipped'));
        return {
          ...(voice ? { voice } : {}), ...(cv ? { cv } : {}),
          analysis: { modules: {
            acoustics: voice && acoustics.status !== 'ok' ? { ...acoustics, status: 'ok', confidence: voice.quality } : acoustics,
            face: cv && faceStatus.status !== 'ok' ? { ...faceStatus, status: 'ok', confidence: cv.quality } : faceStatus,
          } },
        };
      } catch {
        const status = timedOut ? 'error' : 'unavailable';
        return { analysis: { modules: { acoustics: moduleStatus(null, status), face: moduleStatus(null, frames.length ? status : 'skipped') } } };
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
      }
    },
  };
}
