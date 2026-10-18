import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorKey } from '../src/core/api';
import type { RespondRequest } from '../shared/types';

const input: RespondRequest = { language: 'en', text: 'Hello', history: [], memories: [] };
const sessionRequired = () => Response.json({ error: { code: 'SESSION_REQUIRED', message: 'Refresh the anonymous session.' } }, { status: 401 });
const health = () => Response.json({ configured: true, provider: 'groq', models: { chat: 'test', stt: 'test' } });
const result = { reply: 'Hello.' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('anonymous client session recovery', () => {
  it('notifies the account gate when a real account session expires without retrying', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.respond(input)).rejects.toMatchObject({ name: 'ApiError', code: 'auth_required' });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0].type).toBe('whitemood:auth-required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('silently refreshes the cookie and replays the original request once with the same signal and body', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sessionRequired())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(Response.json(result));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(api.respond(input, controller.signal)).resolves.toEqual(result);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/respond', '/api/health', '/api/respond']);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('same-origin');
      expect(init?.signal).toBe(controller.signal);
    }
    expect(fetchMock.mock.calls[1][1]?.method).toBeUndefined();
    expect(fetchMock.mock.calls[1][1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[2][1]).toEqual(fetchMock.mock.calls[0][1]);
  });

  it('throws ApiError after a single retry if the cookie is still unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sessionRequired())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(sessionRequired());
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.respond(input)).rejects.toMatchObject({ name: 'ApiError', code: 'session_required' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errorKey(new ApiError('session_required'))).toBe('network');
  });

  it('does not retry a rate limit and preserves its retry-after value', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { code: 'RATE_LIMITED' } }, { status: 429, headers: { 'retry-after': '20' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.respond(input)).rejects.toMatchObject({ name: 'ApiError', code: 'rate_limited', retryAfter: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh or retry when the original signal was canceled during the first request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      controller.abort();
      return sessionRequired();
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.respond(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not replay the POST if cancellation occurs while refreshing the cookie', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sessionRequired())
      .mockImplementationOnce(async () => { controller.abort(); return health(); });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.respond(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not send a request when its signal was already canceled', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController(); controller.abort();

    await expect(api.respond(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 403, 500])('does not add requests for an ordinary HTTP %s error', async status => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { code: 'PROVIDER_ERROR' } }, { status }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.respond(input)).rejects.toMatchObject({ name: 'ApiError', code: 'provider_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not add requests after a network failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.respond(input)).rejects.toMatchObject({ name: 'ApiError', code: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not recursively refresh a rejected health endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(sessionRequired());
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.health()).rejects.toMatchObject({ name: 'ApiError', code: 'session_required' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('replays multipart audio without dropping the blob or its language', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sessionRequired())
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(Response.json({ text: 'Hello' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.transcribe(new Blob(['audio'], { type: 'audio/wav' }), 'ko')).resolves.toEqual({ text: 'Hello' });
    const firstBody = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(fetchMock.mock.calls[2][1]?.body).toBe(firstBody);
    expect(firstBody.get('language')).toBe('ko');
    expect((firstBody.get('file') as File).name).toBe('utterance.wav');
  });
});
