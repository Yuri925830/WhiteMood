import type { ApiErrorBody, ConsolidateRequest, ConsolidateResult, Language, RespondRequest, RespondResult, ServiceHealth, SummarizeRequest, SummarizeResult, TranscriptionResult } from '../../shared/types';
import type { CvFrame } from '../integrations/cv';

export class ApiError extends Error {
  constructor(public code: string, public retryAfter = 0) { super(code); this.name = 'ApiError'; }
}

async function request<T>(path: string, init: RequestInit = {}, sessionRefreshed = false): Promise<T> {
  init.signal?.throwIfAborted();
  let response: Response;
  try { response = await fetch(path, { ...init, credentials: 'same-origin' }); }
  catch (error) { init.signal?.throwIfAborted(); if ((error as Error).name === 'AbortError') throw error; throw new ApiError('network'); }
  // Some transports can settle after cancellation. A disposed account's late
  // response must never expire the currently signed-in account's UI session.
  init.signal?.throwIfAborted();
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorBody | null;
    init.signal?.throwIfAborted();
    const code = body?.error?.code?.toLowerCase() ?? (response.status === 429 ? 'rate_limited' : 'provider_error');
    if (response.status === 401 && code === 'auth_required' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('whitemood:auth-required'));
    }
    if (response.status === 401 && code === 'session_required' && path !== '/api/health' && !sessionRefreshed) {
      init.signal?.throwIfAborted();
      await request<ServiceHealth>('/api/health', { signal: init.signal }, true);
      return request<T>(path, init, true);
    }
    throw new ApiError(code, body?.error?.retryAfter ?? Number(response.headers.get('retry-after') || 0));
  }
  const body = await response.json() as T;
  init.signal?.throwIfAborted();
  return body;
}

function json<T>(path: string, body: unknown, signal?: AbortSignal) {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
}

export const api = {
  health: (signal?: AbortSignal) => request<ServiceHealth>('/api/health', { signal }),
  transcribe: (audio: Blob, language: Language, signal?: AbortSignal, frames: CvFrame[] = []) => {
    const form = new FormData(); form.append('file', audio, 'utterance.wav'); form.append('language', language);
    for (const [index, frame] of frames.slice(-5).entries()) {
      form.append('frame', frame.image, `frame-${index + 1}.jpg`);
      form.append('frame_captured_at', String(frame.capturedAt));
    }
    return request<TranscriptionResult>('/api/transcribe', { method: 'POST', body: form, signal });
  },
  respond: (body: RespondRequest, signal?: AbortSignal) => json<RespondResult>('/api/respond', body, signal),
  summarize: (body: SummarizeRequest, signal?: AbortSignal) => json<SummarizeResult>('/api/summarize', body, signal),
  consolidate: (body: ConsolidateRequest, signal?: AbortSignal) => json<ConsolidateResult>('/api/memory/consolidate', body, signal),
};

export function errorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (/config|unavailable|missing_key|not_configured/.test(error.code)) return 'service_unavailable';
    if (/rate|quota/.test(error.code)) return 'rate_limited';
    if (/network|timeout|session_required|auth_required/.test(error.code)) return 'network';
    return 'provider_error';
  }
  if (error instanceof Error) {
    if (error.name === 'MicrophoneError' && /microphone_(interrupted|stalled)/.test(error.message)) return error.message;
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'microphone_denied';
    if (error.name === 'NotFoundError' || error.name === 'NotReadableError') return 'microphone_missing';
    if (/voice|locale|language/i.test(error.message)) return 'voice_unavailable';
    if (/unsupported|AudioWorklet|secure context/i.test(error.message)) return 'audio_unsupported';
  }
  return 'unknown';
}

export const aborted = (error: unknown) => error instanceof Error && error.name === 'AbortError';
