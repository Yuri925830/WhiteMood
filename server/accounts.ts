import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { SECURITY_HEADERS } from './api';

export interface AccountAuthEnv { DB?: D1Database; SITE_ORIGIN?: string }
export interface AccountUser { userId: string; id: string }
export interface AccountAuthOptions {
  now?: () => number;
  /** Tests may inject a deterministic inexpensive hasher. Production must use the default. */
  hashPassword?: (password: string, saltHex: string) => Promise<string>;
}

const COOKIE = 'wm_account_session';
const SESSION_SECONDS = 43_200;
const MAX_BODY = 8192;
const ID = /^[a-z0-9_]{3,24}$/;
const HASH = /^[0-9a-f]{128}$/;
const SALT = /^[0-9a-f]{32}$/;
let scryptInFlight = false;
const quotaSql = `INSERT INTO wm_request_limits (id, count, expires_at) VALUES (?, 1, ?)
  ON CONFLICT(id) DO UPDATE SET count = MIN(wm_request_limits.count + 1, ?) RETURNING count`;

class AuthFailure extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}
function unavailable() { return new AuthFailure(503, 'AUTH_UNAVAILABLE', 'Account access is temporarily unavailable.'); }
function invalidCredentials() { return new AuthFailure(401, 'INVALID_CREDENTIALS', 'The ID or password is incorrect.'); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedId(value: string): string { return value.normalize('NFKC').trim().toLowerCase(); }
function passwordValid(value: string): boolean { const length = [...value].length; return length >= 8 && length <= 128; }
function cookie(value: string, maxAge = SESSION_SECONDS): string {
  return `${COOKIE}=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
function token(request: Request): string | null {
  const entries = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  if (entries.length !== 1) return null;
  const value = entries[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function sameOrigin(request: Request, env: AccountAuthEnv): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  let external = '';
  if (env.SITE_ORIGIN) {
    const value = env.SITE_ORIGIN.trim();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw unavailable();
    external = url.origin;
  }
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin || origin === external;
}
function database(env: AccountAuthEnv): D1Database { if (!env.DB) throw unavailable(); return env.DB; }
async function defaultHash(password: string, saltHex: string): Promise<string> {
  // One native 32 MiB hash per isolate; never queue work across request lifetimes.
  if (scryptInFlight) throw unavailable();
  scryptInFlight = true;
  try {
    return await new Promise<string>((resolve, reject) => {
      scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error); else resolve(key.toString('hex'));
      });
    });
  } finally { scryptInFlight = false; }
}

async function credentials(request: Request): Promise<{ id: string; password: string }> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new AuthFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json for this request.');
  }
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new AuthFailure(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
  if (!request.body) throw new AuthFailure(400, 'INVALID_REQUEST', 'Provide an ID and password.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new AuthFailure(413, 'REQUEST_TOO_LARGE', 'The request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    const value = body as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.password !== 'string' || Object.keys(value).some(key => key !== 'id' && key !== 'password')) throw new Error();
    return { id: normalizedId(value.id), password: value.password };
  } catch { throw new AuthFailure(400, 'INVALID_REQUEST', 'Provide an ID and password.'); }
}

export function createAccountAuth(options: AccountAuthOptions = {}): {
  handle(request: Request, env: AccountAuthEnv): Promise<Response | null>;
  authenticate(request: Request, env: AccountAuthEnv): Promise<AccountUser | null>;
} {
  const now = options.now ?? Date.now;
  const hashPassword = options.hashPassword ?? defaultHash;
  const seconds = () => Math.floor(now() / 1000);

  async function authenticate(request: Request, env: AccountAuthEnv): Promise<AccountUser | null> {
    try {
      if (!sameOrigin(request, env)) return null;
      const value = token(request);
      if (!value) return null;
      const row = await database(env).prepare(`SELECT a.user_id, a.login_id FROM wm_account_sessions s
        JOIN wm_accounts a ON a.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).bind(digest(value), seconds()).first<{ user_id: string; login_id: string }>();
      return row ? { userId: row.user_id, id: row.login_id } : null;
    } catch { throw unavailable(); }
  }

  async function limit(db: D1Database, id: string): Promise<void> {
    const time = seconds();
    const minute = Math.floor(time / 900) * 900;
    const hour = Math.floor(time / 3600) * 3600;
    const limits = [
      { id: `account:id:${digest(id)}:${minute}`, maximum: 10, end: minute + 900 },
      { id: `account:global:${hour}`, maximum: 60, end: hour + 3600 },
    ];
    const results = await db.batch<{ count: number }>([
      ...limits.map(value => db.prepare(quotaSql).bind(value.id, value.end, value.maximum + 1)),
      db.prepare('DELETE FROM wm_request_limits WHERE expires_at < ?').bind(time - 86_400),
    ]);
    if (results.length !== 3 || results.some(result => !result.success)) throw unavailable();
    let wait = 0;
    for (let index = 0; index < limits.length; index++) {
      const count = results[index].results?.[0]?.count;
      if (!Number.isSafeInteger(count) || count < 1) throw unavailable();
      if (count > limits[index].maximum) wait = Math.max(wait, limits[index].end - time);
    }
    if (wait) throw new AuthFailure(429, 'AUTH_RATE_LIMITED', 'Too many account attempts. Please try again later.', Math.max(1, wait));
  }

  function session() {
    const value = randomBytes(32).toString('base64url');
    return { value, hash: digest(value), expires: seconds() + SESSION_SECONDS };
  }

  async function handle(request: Request, env: AccountAuthEnv): Promise<Response | null> {
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const methods: Record<string, string> = { '/api/auth/session': 'GET', '/api/auth/check-id': 'GET', '/api/auth/register': 'POST', '/api/auth/login': 'POST', '/api/auth/logout': 'POST' };
    if (!methods[path]) return null;
    try {
      if (!sameOrigin(request, env)) throw new AuthFailure(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed to use the API.');
      if (request.method !== methods[path]) return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'This method is not supported.' } }, 405, { Allow: methods[path] });
      const db = database(env);
      if (path === '/api/auth/session') return json({ user: await authenticate(request, env) });
      if (path === '/api/auth/logout') {
        const value = token(request);
        if (value) {
          const result = await db.prepare('DELETE FROM wm_account_sessions WHERE token_hash = ?').bind(digest(value)).run();
          if (!result.success) throw unavailable();
        }
        return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
      }
      if (path === '/api/auth/check-id') {
        const id = normalizedId(new URL(request.url).searchParams.get('id') ?? '');
        if (!ID.test(id)) throw new AuthFailure(400, 'INVALID_ID', 'Use 3–24 lowercase letters, numbers or underscores for the ID.');
        const existing = await db.prepare('SELECT user_id FROM wm_accounts WHERE login_id = ?').bind(id).first();
        return json({ available: !existing, id });
      }

      const input = await credentials(request);
      await limit(db, input.id);
      if (path === '/api/auth/register') {
        if (!ID.test(input.id)) throw new AuthFailure(400, 'INVALID_ID', 'Use 3–24 lowercase letters, numbers or underscores for the ID.');
        if (!passwordValid(input.password)) throw new AuthFailure(400, 'INVALID_PASSWORD', 'Use a password with 8–128 characters.');
        const salt = randomBytes(16).toString('hex');
        const passwordHash = await hashPassword(input.password, salt);
        if (!HASH.test(passwordHash)) throw unavailable();
        const user: AccountUser = { userId: randomUUID(), id: input.id };
        const issued = session();
        // The unique login_id constraint resolves concurrent registration in one transaction.
        const results = await db.batch<{ user_id: string }>([
          db.prepare(`INSERT INTO wm_accounts (user_id, login_id, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(login_id) DO NOTHING RETURNING user_id`).bind(user.userId, user.id, passwordHash, salt, seconds()),
          db.prepare(`INSERT INTO wm_account_sessions (token_hash, user_id, expires_at)
            SELECT ?, user_id, ? FROM wm_accounts WHERE user_id = ? RETURNING user_id`).bind(issued.hash, issued.expires, user.userId),
          db.prepare('DELETE FROM wm_account_sessions WHERE expires_at <= ?').bind(seconds()),
        ]);
        if (results.length !== 3 || results.some(result => !result.success)) throw unavailable();
        if (!results[0].results.length) throw new AuthFailure(409, 'ID_TAKEN', 'This ID is already registered.');
        if (results[1].results?.[0]?.user_id !== user.userId) throw unavailable();
        return json({ user }, 201, { 'Set-Cookie': cookie(issued.value) });
      }

      const account = ID.test(input.id) ? await db.prepare('SELECT user_id, login_id, password_hash, salt FROM wm_accounts WHERE login_id = ?')
        .bind(input.id).first<{ user_id: string; login_id: string; password_hash: string; salt: string }>() : null;
      if (account && (!SALT.test(account.salt) || !HASH.test(account.password_hash))) throw unavailable();
      const validPassword = passwordValid(input.password);
      // Unknown IDs and invalid passwords still pay the same native scrypt cost.
      const actual = await hashPassword(validPassword ? input.password : 'invalid-password-input', account?.salt ?? '0'.repeat(32));
      if (!HASH.test(actual)) throw unavailable();
      const matched = timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(account?.password_hash ?? '0'.repeat(128), 'hex'));
      if (!account || !validPassword || !matched) throw invalidCredentials();
      const issued = session();
      const results = await db.batch([
        db.prepare('INSERT INTO wm_account_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(issued.hash, account.user_id, issued.expires),
        db.prepare('DELETE FROM wm_account_sessions WHERE expires_at <= ?').bind(seconds()),
      ]);
      if (results.length !== 2 || results.some(result => !result.success)) throw unavailable();
      return json({ user: { userId: account.user_id, id: account.login_id } }, 200, { 'Set-Cookie': cookie(issued.value) });
    } catch (error) {
      const failure = error instanceof AuthFailure ? error : unavailable();
      return json({ error: { code: failure.code, message: failure.message, ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) } }, failure.status,
        failure.retryAfter ? { 'Retry-After': String(failure.retryAfter) } : {});
    }
  }
  return { handle, authenticate };
}
