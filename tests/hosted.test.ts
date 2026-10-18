import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedApi } from '../server/hosted';
import type { ApiErrorBody, ServiceHealth } from '../shared/types';

const errorBody = async (response: Response): Promise<ApiErrorBody> => await response.json() as ApiErrorBody;
const healthBody = async (response: Response): Promise<ServiceHealth> => await response.json() as ServiceHealth;

const origin = 'https://whitemood.example';
const internalOrigin = 'https://worker.internal';
const input = { language: 'zh', text: '今天有点累', history: [], memories: [] };
const reply = {
  reply: '我在听。',
  speech: { style: 'steady', rate: 1, pitch: 1, pauseMs: 300 },
  reflection: { feeling: '用户自述疲惫', evidence: ['今天有点累'], uncertain: false },
};

function request(base = origin, headers: Record<string, string> = {}) {
  return new Request(`${base}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(input),
  });
}

function provider() {
  const mock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }],
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('owner-private hosted API adapter', () => {
  it('serves health with no secret and does not claim provider availability', async () => {
    const fetch = provider();
    const response = await createHostedApi()(new Request(`${origin}/api/health`), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, provider: 'groq', models: { chat: 'openai/gpt-oss-120b', stt: 'whisper-large-v3-turbo' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns an honest configuration error without a runtime secret', async () => {
    const fetch = provider();
    const response = await createHostedApi()(request(), {});
    expect(response.status).toBe(503);
    expect((await errorBody(response)).error.code).toBe('NOT_CONFIGURED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the runtime secret only in the upstream authorization header', async () => {
    const fetch = provider();
    const response = await createHostedApi()(request(), { GROQ_API_KEY: 'server-only-secret' });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('server-only-secret');
    expect(fetch.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer server-only-secret');
    expect(String(fetch.mock.calls[0][1]?.body)).not.toContain('server-only-secret');
  });

  it('accepts the single configured external origin behind an internal request URL', async () => {
    const fetch = provider();
    const response = await createHostedApi()(request(internalOrigin), { GROQ_API_KEY: 'test', SITE_ORIGIN: origin });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects other, null and spoofed-forwarded origins without calling the provider', async () => {
    const fetch = provider();
    const handle = createHostedApi();
    const env = { GROQ_API_KEY: 'test', SITE_ORIGIN: origin };
    for (const untrusted of ['https://attacker.example', 'null', `${origin}.attacker.example`]) {
      const response = await handle(request(internalOrigin, { origin: untrusted, 'x-forwarded-host': 'whitemood.example', 'x-forwarded-proto': 'https' }), env);
      expect(response.status).toBe(403);
      expect((await errorBody(response)).error.code).toBe('ORIGIN_NOT_ALLOWED');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not implicitly authorize the external origin without SITE_ORIGIN', async () => {
    const fetch = provider();
    const response = await createHostedApi()(request(internalOrigin), { GROQ_API_KEY: 'test' });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed or broad external origin configuration without leaking its value', async () => {
    const fetch = provider();
    for (const value of ['*', 'null', 'http://whitemood.example', `${origin}/`, `${origin}/private`, 'https://user:secret@whitemood.example']) {
      const response = await createHostedApi()(request(), { GROQ_API_KEY: 'private-key', SITE_ORIGIN: value });
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain('HOSTED_CONFIGURATION');
      expect(body).not.toContain('private-key');
      expect(body).not.toContain(value);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps rate buckets across equal fresh env objects and ignores spoofed IP headers', async () => {
    const fetch = provider();
    const handle = createHostedApi();
    const env = { GROQ_API_KEY: 'test' };
    // Missing key requests still count toward the existing handler limit and avoid upstream cost.
    const unconfigured = { ...env, GROQ_API_KEY: '' };
    for (let index = 0; index < 60; index++) {
      const response = await handle(request(origin, { 'cf-connecting-ip': `192.0.2.${index}`, 'x-forwarded-for': `198.51.100.${index}` }), { ...unconfigured });
      expect(response.status).toBe(503);
    }
    const limited = await handle(request(origin, { 'cf-connecting-ip': '203.0.113.2' }), { ...unconfigured });
    expect(limited.status).toBe(429);
    expect((await errorBody(limited)).error.code).toBe('RATE_LIMITED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes the handler after a runtime secret or model change', async () => {
    const fetch = provider();
    const handle = createHostedApi();
    expect((await handle(request(), { GROQ_API_KEY: 'first' })).status).toBe(200);
    expect((await handle(request(), { GROQ_API_KEY: 'second', GROQ_CHAT_MODEL: 'other-chat', GROQ_STT_MODEL: 'other-stt' })).status).toBe(200);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer second');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).model).toBe('other-chat');
    const health = await handle(new Request(`${origin}/api/health`), { GROQ_API_KEY: 'second', GROQ_CHAT_MODEL: 'other-chat', GROQ_STT_MODEL: 'other-stt' });
    expect((await healthBody(health)).models).toEqual({ chat: 'other-chat', stt: 'other-stt' });
  });

  it('preserves unknown API routes as JSON 404 responses', async () => {
    const response = await createHostedApi()(new Request(`${origin}/api/missing`), {});
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await errorBody(response)).error.code).toBe('NOT_FOUND');
  });
});
