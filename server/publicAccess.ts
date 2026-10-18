import { SECURITY_HEADERS } from './api';

export interface PublicAccessEnv {
  SESSION_SECRET?: string;
  DB?: D1Database;
  SITE_ORIGIN?: string;
}
export interface AccessDecision { response?: Response; setCookie?: string }

const COOKIE = 'wm_session';
const DAY = 86_400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
const upsert = `INSERT INTO wm_request_limits (id, count, expires_at) VALUES (?, 1, ?)
  ON CONFLICT(id) DO UPDATE SET count = MIN(wm_request_limits.count + 1, ?)
  RETURNING count`;

function failure(status: number, code: string, message: string, retryAfter?: number): AccessDecision {
  return { response: Response.json({ error: { code, message, ...(retryAfter ? { retryAfter } : {}) } }, {
    status, headers: { ...SECURITY_HEADERS, ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) },
  }) };
}

function allowedOrigin(request: Request, external?: string): boolean {
  const url = new URL(request.url);
  let configured = '';
  if (external) {
    const parsed = new URL(external);
    if (parsed.protocol !== 'https:' || parsed.origin !== external || parsed.username || parsed.password) throw new Error();
    configured = parsed.origin;
  }
  const origin = request.headers.get('origin');
  return origin ? origin === url.origin || origin === configured : request.headers.get('sec-fetch-site') !== 'cross-site';
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Public, anonymous access with signed browser sessions and conservative shared D1 quotas. */
export function createPublicAccessGuard(now: () => number = Date.now) {
  let previousSecret = '';
  let keyPromise: Promise<CryptoKey> | undefined;

  async function sessionId(request: Request, key: CryptoKey, seconds: number): Promise<string | undefined> {
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return undefined;
    const value = cookies[0].slice(COOKIE.length + 1);
    const parts = value.split('.');
    if (parts.length !== 3 || !UUID.test(parts[0]) || !/^\d{10,11}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return undefined;
    const expires = Number(parts[1]);
    if (!Number.isSafeInteger(expires) || expires <= seconds || expires > seconds + DAY) return undefined;
    try {
      const signature = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/') + '='), character => character.charCodeAt(0));
      return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${parts[0]}.${parts[1]}`)) ? parts[0] : undefined;
    } catch { return undefined; }
  }

  return async function authorize(request: Request, env: PublicAccessEnv, authenticatedId?: string): Promise<AccessDecision> {
    try {
      if (!allowedOrigin(request, env.SITE_ORIGIN?.trim())) return failure(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed to use the API.');
      const secret = env.SESSION_SECRET?.trim() ?? '';
      if (encoder.encode(secret).byteLength < 32 || !env.DB) return failure(503, 'ACCESS_UNAVAILABLE', 'The service is temporarily unavailable.');
      if (!keyPromise || secret !== previousSecret) {
        previousSecret = secret;
        keyPromise = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
      }
      const key = await keyPromise;
      const seconds = Math.floor(now() / 1000);
      // Only the account middleware may supply this trusted, server-resolved identity.
      const id = authenticatedId ?? await sessionId(request, key, seconds);
      const path = new URL(request.url).pathname.replace(/\/$/, '');
      if (path === '/api/health' && request.method === 'GET') {
        const payload = `${id ?? crypto.randomUUID()}.${seconds + DAY}`;
        const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
        return { setCookie: `${COOKIE}=${payload}.${signature}; Path=/api; Max-Age=${DAY}; HttpOnly; Secure; SameSite=Strict` };
      }
      // Non-AI routes/methods are still validated by the existing API handler.
      const aiPaths = ['/api/transcribe', '/api/respond', '/api/summarize', '/api/memory/consolidate'];
      if (request.method !== 'POST' || !aiPaths.includes(path)) return {};
      if (!id) return failure(401, 'SESSION_REQUIRED', 'Refresh the page before continuing.');

      const minute = Math.floor(seconds / 60) * 60;
      const day = Math.floor(seconds / DAY) * DAY;
      const limits = [
        { id: `global:minute:${minute}`, limit: 12, end: minute + 60 },
        { id: `global:day:${day}`, limit: 200, end: day + DAY },
        { id: `session:${id}:minute:${minute}`, limit: 10, end: minute + 60 },
        { id: `session:${id}:day:${day}`, limit: 80, end: day + DAY },
      ];
      // D1 batch is transactional. Each RETURNING count is atomic across Worker isolates.
      // Rejected attempts consume quota conservatively; no speech/text/IP enters this table.
      const results = await env.DB.batch<{ count: number }>([
        ...limits.map(limit => env.DB!.prepare(upsert).bind(limit.id, limit.end, limit.limit + 1)),
        env.DB.prepare('DELETE FROM wm_request_limits WHERE expires_at < ?').bind(seconds - DAY),
      ]);
      if (results.length !== 5 || results.some(result => !result.success)) throw new Error();
      let wait = 0;
      for (let index = 0; index < limits.length; index++) {
        const count = results[index].results?.[0]?.count;
        if (!Number.isSafeInteger(count) || count < 1) throw new Error();
        if (count > limits[index].limit) wait = Math.max(wait, limits[index].end - seconds);
      }
      return wait ? failure(429, 'RATE_LIMITED', 'The service limit has been reached. Please wait before retrying.', Math.max(1, wait)) : {};
    } catch {
      return failure(503, 'ACCESS_UNAVAILABLE', 'The service is temporarily unavailable.');
    }
  };
}
