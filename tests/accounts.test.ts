import { createHash, scryptSync } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createAccountAuth, type AccountAuthEnv, type AccountUser } from '../server/accounts';
import type { ApiErrorBody } from '../shared/types';

const origin = 'https://whitemood.example';
const start = Date.UTC(2026, 9, 18, 1, 2, 3);
const password = 'Correct password 123';
const fastHash = async (value: string, salt: string) => createHash('sha512').update(salt).update(value).digest('hex');
const errorBody = async (response: Response): Promise<ApiErrorBody> => await response.json() as ApiErrorBody;
const userBody = async (response: Response): Promise<{ user: AccountUser | null }> => await response.json() as { user: AccountUser | null };

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE wm_accounts (user_id TEXT PRIMARY KEY, login_id TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE wm_account_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE wm_request_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
  class Statement {
    values: SQLInputValue[] = [];
    constructor(public sql: string) {}
    bind(...values: SQLInputValue[]) { this.values = values; return this; }
    async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
    async run() { return { success: true, meta: sqlite.prepare(this.sql).run(...this.values) }; }
  }
  const batch = vi.fn(async (statements: Statement[]) => {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => ({ success: true, results: sqlite.prepare(statement.sql).all(...statement.values), meta: {} }));
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  });
  return { sqlite, batch, binding: { prepare: (sql: string) => new Statement(sql), batch } as unknown as D1Database };
}
function request(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}, base = origin) {
  return new Request(`${base}/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function fixture() {
  const db = database();
  const env = { DB: db.binding };
  const hashPassword = vi.fn(fastHash);
  const auth = createAccountAuth({ now: () => start, hashPassword });
  return { db, env, hashPassword, auth };
}
const sessionCookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
async function register(auth: ReturnType<typeof createAccountAuth>, env: AccountAuthEnv, id = 'test_user', value = password) {
  const response = await auth.handle(request('register', { id, password: value }), env);
  expect(response?.status).toBe(201);
  return response!;
}

describe('WhiteMood ID and password accounts', () => {
  it('uses the real native scrypt N32768/r8/p3 configuration and verifies a Unicode password round trip', async () => {
    const db = database();
    const env = { DB: db.binding };
    const auth = createAccountAuth({ now: () => start });
    const unicodePassword = '  마음과心情🙂 password  ';
    const created = await register(auth, env, 'real_hash', unicodePassword);
    const row = db.sqlite.prepare('SELECT password_hash, salt FROM wm_accounts').get()!;
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(row.password_hash).toBe(scryptSync(unicodePassword, Buffer.from(String(row.salt), 'hex'), 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex'));
    expect(row.password_hash).not.toContain(unicodePassword);
    const loggedIn = await auth.handle(request('login', { id: 'real_hash', password: unicodePassword }), env);
    expect(loggedIn?.status).toBe(200);
    expect((await userBody(loggedIn!)).user).toEqual((await userBody(created)).user);
  });

  it('admits only one real native hash per isolate and releases the slot after completion', async () => {
    const db = database();
    const env = { DB: db.binding };
    const first = createAccountAuth({ now: () => start });
    const second = createAccountAuth({ now: () => start });
    const results = await Promise.all([
      first.handle(request('register', { id: 'parallel_one', password }), env),
      second.handle(request('register', { id: 'parallel_two', password }), env),
    ]);
    expect(results.map(response => response!.status).sort()).toEqual([201, 503]);
    expect((await errorBody(results.find(response => response?.status === 503)!)).error.code).toBe('AUTH_UNAVAILABLE');
    const rejectedId = results[0]?.status === 503 ? 'parallel_one' : 'parallel_two';
    expect((await second.handle(request('register', { id: rejectedId, password }), env))?.status).toBe(201);
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').all()).toHaveLength(2);
  });

  it('normalizes IDs with NFKC, trims and lowercases, checks duplicates, and resolves concurrent registrations atomically', async () => {
    const { db, env, auth } = fixture();
    expect(await (await auth.handle(request('check-id?id=%20%EF%BC%B4%EF%BC%A5%EF%BC%B3%EF%BC%B4_%EF%BC%91%20'), env))!.json()).toEqual({ available: true, id: 'test_1' });
    const results = await Promise.all([
      auth.handle(request('register', { id: ' ＴＥＳＴ_１ ', password }), env),
      auth.handle(request('register', { id: 'test_1', password }), env),
    ]);
    expect(results.map(response => response!.status).sort()).toEqual([201, 409]);
    const duplicate = results.find(response => response?.status === 409)!;
    expect((await errorBody(duplicate)).error.code).toBe('ID_TAKEN');
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').all()).toHaveLength(1);
    expect(db.sqlite.prepare('SELECT * FROM wm_account_sessions').all()).toHaveLength(1);
    expect(await (await auth.handle(request('check-id?id=TEST_1'), env))!.json()).toEqual({ available: false, id: 'test_1' });
  });

  it('stores only token hashes, sets secure cookie attributes, authenticates sessions and logs out the current session', async () => {
    const { db, env, auth } = fixture();
    const created = await register(auth, env);
    const header = created.headers.get('set-cookie')!;
    expect(header).toMatch(/^wm_account_session=[A-Za-z0-9_-]{43}; Path=\/api; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
    const cookie = sessionCookie(created);
    const rawToken = cookie.split('=')[1];
    const stored = db.sqlite.prepare('SELECT token_hash FROM wm_account_sessions').get()!;
    expect(stored.token_hash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(rawToken);
    const user = (await userBody(created)).user;
    expect(await auth.authenticate(request('session', undefined, cookie), env)).toEqual(user);
    expect(await userBody((await auth.handle(request('session', undefined, cookie), env))!)).toEqual({ user });
    const logout = await auth.handle(request('logout', {}, cookie), env);
    expect(logout?.status).toBe(200);
    expect(logout?.headers.get('set-cookie')).toContain('Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    expect(await auth.authenticate(request('session', undefined, cookie), env)).toBeNull();
    expect(db.sqlite.prepare('SELECT * FROM wm_account_sessions').all()).toHaveLength(0);
  });

  it('returns the same failure and computes a same-cost hash for unknown IDs and wrong passwords', async () => {
    const { env, auth, hashPassword } = fixture();
    await register(auth, env);
    hashPassword.mockClear();
    const known = await auth.handle(request('login', { id: 'test_user', password: 'Wrong password 123' }), env);
    const unknown = await auth.handle(request('login', { id: 'unknown_user', password: 'Wrong password 123' }), env);
    expect(known?.status).toBe(401);
    expect(unknown?.status).toBe(401);
    expect(await known!.json()).toEqual(await unknown!.json());
    expect(hashPassword).toHaveBeenCalledTimes(2);
    expect(hashPassword.mock.calls.every(call => call[0] === 'Wrong password 123' && call[1].length === 32)).toBe(true);
  });

  it('preserves password whitespace, accepts Unicode characters, and rejects IDs/passwords outside the policy', async () => {
    const { env, auth } = fixture();
    await register(auth, env, 'whitespace', ' 12345678 ');
    expect((await auth.handle(request('login', { id: 'whitespace', password: '12345678' }), env))?.status).toBe(401);
    for (const id of ['ab', 'invalid-id', '中文用户名', 'a'.repeat(25)]) {
      expect((await auth.handle(request('register', { id, password }), env))?.status).toBe(400);
    }
    for (const value of ['short', '🙂'.repeat(129)]) {
      const response = await auth.handle(request('register', { id: `valid_${value.length}`, password: value }), env);
      expect(response?.status).toBe(400);
      expect((await errorBody(response!)).error.code).toBe('INVALID_PASSWORD');
    }
  });

  it('treats missing, malformed, duplicate and expired cookies as signed out', async () => {
    const { db, env, auth } = fixture();
    const created = await register(auth, env);
    const valid = sessionCookie(created);
    for (const value of [undefined, 'wm_account_session=bad', `${valid}; ${valid}`]) {
      expect(await userBody((await auth.handle(request('session', undefined, value), env))!)).toEqual({ user: null });
    }
    db.sqlite.prepare('UPDATE wm_account_sessions SET expires_at = ?').run(Math.floor(start / 1000));
    expect(await auth.authenticate(request('session', undefined, valid), env)).toBeNull();
  });

  it('enforces an ID quota shared by login/register and a global quota across independent auth instances', async () => {
    const { env, auth, hashPassword } = fixture();
    for (let i = 0; i < 10; i++) expect((await auth.handle(request('login', { id: 'missing_user', password }), env))?.status).toBe(401);
    const limited = await auth.handle(request('register', { id: 'MISSING_USER', password }), env);
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('retry-after')).toBe('777');
    expect(hashPassword).toHaveBeenCalledTimes(10);

    const separate = fixture();
    const second = createAccountAuth({ now: () => start, hashPassword: fastHash });
    for (let i = 0; i < 60; i++) expect((await (i % 2 ? separate.auth : second).handle(request('login', { id: `unknown_${i}`, password }), separate.env))?.status).toBe(401);
    expect((await second.handle(request('login', { id: 'another_id', password }), separate.env))?.status).toBe(429);
  });

  it('rejects cross-site/null origins and Sec-Fetch-Site cross-site before reading credentials or touching D1', async () => {
    const { env, auth, db } = fixture();
    const untrusted: Record<string, string>[] = [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin, 'sec-fetch-site': 'cross-site' }];
    for (const headers of untrusted) {
      expect((await auth.handle(request('register', { id: 'valid_id', password }, undefined, headers), env))?.status).toBe(403);
    }
    expect(db.batch).not.toHaveBeenCalled();
    expect((await auth.handle(request('session', undefined, undefined, {}, 'https://internal.worker'), { ...env, SITE_ORIGIN: origin }))?.status).toBe(200);
  });

  it('caps streamed JSON at 8192 bytes and validates media types, methods and object shape', async () => {
    const { env, auth } = fixture();
    expect((await auth.handle(request('register', { id: 'valid_id', password: 'x'.repeat(9000) }), env))?.status).toBe(413);
    expect((await auth.handle(request('register', { id: 'valid_id', password }, undefined, { 'content-type': 'text/plain' }), env))?.status).toBe(415);
    expect((await auth.handle(request('register', { id: 'valid_id', password, extra: true }), env))?.status).toBe(400);
    expect((await auth.handle(request('register'), env))?.status).toBe(405);
    expect(await auth.handle(new Request(`${origin}/api/unrelated`), env)).toBeNull();
  });

  it('keeps SQL injection attempts as data and never grants another account a session', async () => {
    const { db, env, auth } = fixture();
    await register(auth, env);
    const attack = "' OR 1=1 --";
    expect((await auth.handle(request('login', { id: attack, password }), env))?.status).toBe(401);
    expect((await auth.handle(request(`check-id?id=${encodeURIComponent(attack)}`), env))?.status).toBe(400);
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').all()).toHaveLength(1);
    expect(db.sqlite.prepare('SELECT * FROM wm_account_sessions').all()).toHaveLength(1);
  });

  it('fails closed on D1 errors without exposing queries, credentials or database diagnostics', async () => {
    const { env, auth, db } = fixture();
    db.batch.mockRejectedValueOnce(new Error(`private database error ${password}`));
    const failed = await auth.handle(request('register', { id: 'new_user', password }), env);
    expect(failed?.status).toBe(503);
    expect(await failed!.text()).not.toContain(password);
    db.sqlite.exec('DROP TABLE wm_accounts');
    const session = await auth.handle(request('session', undefined, `wm_account_session=${'A'.repeat(43)}`), env);
    expect(session?.status).toBe(503);
    await expect(auth.authenticate(request('session', undefined, `wm_account_session=${'A'.repeat(43)}`), env)).rejects.toThrow('Account access is temporarily unavailable.');
  });
});
