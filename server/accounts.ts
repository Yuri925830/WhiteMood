import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SECURITY_HEADERS } from './api';
import { nativePasswordHash } from './passwordHash';

export interface PasswordHasherNamespace {
  getByName(name: string): { hashPassword(password: string, saltHex: string): Promise<string> };
}
export interface AccountAuthEnv {
  DB?: D1Database;
  SITE_ORIGIN?: string;
  PASSWORD_HASHER?: PasswordHasherNamespace;
  REQUIRE_PASSWORD_HASHER?: boolean | string;
}
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

async function requestObject(request: Request): Promise<Record<string, unknown>> {
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
    return body as Record<string, unknown>;
  } catch { throw new AuthFailure(400, 'INVALID_REQUEST', 'Provide an ID and password.'); }
}
async function credentials(request: Request): Promise<{ id: string; password: string }> {
  const value = await requestObject(request);
  if (typeof value.id !== 'string' || typeof value.password !== 'string' || Object.keys(value).some(key => key !== 'id' && key !== 'password')) {
    throw new AuthFailure(400, 'INVALID_REQUEST', 'Provide an ID and password.');
  }
  return { id: normalizedId(value.id), password: value.password };
}
async function accountChanges(request: Request): Promise<{ currentPassword: string; id?: string; newPassword?: string }> {
  const value = await requestObject(request);
  if (typeof value.currentPassword !== 'string' || ('id' in value && typeof value.id !== 'string') ||
      ('newPassword' in value && typeof value.newPassword !== 'string') ||
      Object.keys(value).some(key => !['currentPassword', 'id', 'newPassword'].includes(key))) {
    throw new AuthFailure(400, 'INVALID_REQUEST', 'Provide the current password and the account changes.');
  }
  return {
    currentPassword: value.currentPassword,
    ...('id' in value ? { id: normalizedId(value.id as string) } : {}),
    ...('newPassword' in value ? { newPassword: value.newPassword as string } : {}),
  };
}

export function createAccountAuth(options: AccountAuthOptions = {}): {
  handle(request: Request, env: AccountAuthEnv): Promise<Response | null>;
  authenticate(request: Request, env: AccountAuthEnv): Promise<AccountUser | null>;
} {
  const now = options.now ?? Date.now;
  async function hashForEnvironment(env: AccountAuthEnv, password: string, saltHex: string): Promise<string> {
    if (options.hashPassword) return options.hashPassword(password, saltHex);
    if (env.PASSWORD_HASHER) {
      if (!SALT.test(saltHex)) throw unavailable();
      const shard = Number.parseInt(saltHex.slice(0, 2), 16) % 4;
      const result = await env.PASSWORD_HASHER.getByName(`whitemood-password-v1-${shard}`).hashPassword(password, saltHex);
      if (typeof result !== 'string' || !HASH.test(result)) throw unavailable();
      return result;
    }
    if (env.REQUIRE_PASSWORD_HASHER === true || env.REQUIRE_PASSWORD_HASHER === 'true') throw unavailable();
    return nativePasswordHash(password, saltHex);
  }
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
    const methods: Record<string, string> = { '/api/auth/session': 'GET', '/api/auth/check-id': 'GET', '/api/auth/register': 'POST', '/api/auth/login': 'POST', '/api/auth/logout': 'POST', '/api/auth/update-account': 'POST' };
    if (!methods[path]) return null;
    try {
      const hashPassword = (password: string, saltHex: string) => hashForEnvironment(env, password, saltHex);
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

      if (path === '/api/auth/update-account') {
        const user = await authenticate(request, env);
        if (!user) throw new AuthFailure(401, 'AUTH_REQUIRED', 'Sign in to update your account.');
        const input = await accountChanges(request);
        await limit(db, user.id);
        if (input.id !== undefined && !ID.test(input.id)) throw new AuthFailure(400, 'INVALID_ID', 'Use 3–24 lowercase letters, numbers or underscores for the ID.');
        if (input.newPassword !== undefined && !passwordValid(input.newPassword)) throw new AuthFailure(400, 'INVALID_PASSWORD', 'Use a password with 8–128 characters.');
        const account = await db.prepare('SELECT user_id, login_id, password_hash, salt FROM wm_accounts WHERE user_id = ?')
          .bind(user.userId).first<{ user_id: string; login_id: string; password_hash: string; salt: string }>();
        if (!account || !SALT.test(account.salt) || !HASH.test(account.password_hash)) throw unavailable();
        const validPassword = passwordValid(input.currentPassword);
        const actual = await hashPassword(validPassword ? input.currentPassword : 'invalid-password-input', account.salt);
        if (!HASH.test(actual)) throw unavailable();
        if (!validPassword || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(account.password_hash, 'hex'))) throw invalidCredentials();
        const nextId = input.id ?? account.login_id;
        const nextPassword = input.newPassword ?? input.currentPassword;
        if (nextId === account.login_id && nextPassword === input.currentPassword) throw new AuthFailure(400, 'NO_CHANGES', 'Provide a different ID or password.');
        // The new random salt is also the transaction marker for an ID-only change.
        // Follow-up session writes can run only when this exact update succeeded.
        const nextSalt = randomBytes(16).toString('hex');
        const nextHash = await hashPassword(nextPassword, nextSalt);
        if (!HASH.test(nextHash)) throw unavailable();
        const issued = session();
        const marker = [account.user_id, nextId, nextHash, nextSalt];
        const results = await db.batch<{ user_id: string }>([
          db.prepare(`UPDATE OR IGNORE wm_accounts SET login_id = ?, password_hash = ?, salt = ?
            WHERE user_id = ? AND login_id = ? AND password_hash = ? AND salt = ?
            AND EXISTS (SELECT 1 FROM wm_account_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?)
            RETURNING user_id`).bind(nextId, nextHash, nextSalt, account.user_id, account.login_id, account.password_hash, account.salt, digest(token(request)!), account.user_id, seconds()),
          db.prepare(`DELETE FROM wm_account_sessions WHERE user_id = ? AND EXISTS
            (SELECT 1 FROM wm_accounts WHERE user_id = ? AND login_id = ? AND password_hash = ? AND salt = ?)`)
            .bind(account.user_id, ...marker),
          db.prepare(`INSERT INTO wm_account_sessions (token_hash, user_id, expires_at)
            SELECT ?, user_id, ? FROM wm_accounts WHERE user_id = ? AND login_id = ? AND password_hash = ? AND salt = ? RETURNING user_id`)
            .bind(issued.hash, issued.expires, ...marker),
          db.prepare('DELETE FROM wm_account_sessions WHERE expires_at <= ?').bind(seconds()),
        ]);
        if (results.length !== 4 || results.some(result => !result.success)) throw unavailable();
        if (!results[0].results.length) {
          const owner = await db.prepare('SELECT user_id FROM wm_accounts WHERE login_id = ?').bind(nextId).first<{ user_id: string }>();
          if (owner && owner.user_id !== account.user_id) throw new AuthFailure(409, 'ID_TAKEN', 'This ID is already registered.');
          throw new AuthFailure(409, 'ACCOUNT_CHANGED', 'Your account or session changed. Sign in again before retrying.');
        }
        if (results[2].results?.[0]?.user_id !== account.user_id) throw unavailable();
        return json({ user: { userId: account.user_id, id: nextId } }, 200, { 'Set-Cookie': cookie(issued.value) });
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
      const results = await db.batch<{ user_id: string }>([
        // Re-check the verified credentials inside the session transaction so a
        // concurrent password change cannot mint a session using the old password.
        db.prepare(`INSERT INTO wm_account_sessions (token_hash, user_id, expires_at)
          SELECT ?, user_id, ? FROM wm_accounts WHERE user_id = ? AND login_id = ? AND password_hash = ? AND salt = ? RETURNING user_id`)
          .bind(issued.hash, issued.expires, account.user_id, account.login_id, account.password_hash, account.salt),
        db.prepare('DELETE FROM wm_account_sessions WHERE expires_at <= ?').bind(seconds()),
      ]);
      if (results.length !== 2 || results.some(result => !result.success)) throw unavailable();
      if (results[0].results?.[0]?.user_id !== account.user_id) throw invalidCredentials();
      return json({ user: { userId: account.user_id, id: account.login_id } }, 200, { 'Set-Cookie': cookie(issued.value) });
    } catch (error) {
      const failure = error instanceof AuthFailure ? error : unavailable();
      return json({ error: { code: failure.code, message: failure.message, ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) } }, failure.status,
        failure.retryAfter ? { 'Retry-After': String(failure.retryAfter) } : {});
    }
  }
  return { handle, authenticate };
}
