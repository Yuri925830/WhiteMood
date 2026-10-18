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

  it('updates the ID and password together, keeps the stable user ID, and revokes every prior session', async () => {
    const { db, env, auth } = fixture();
    const created = await register(auth, env);
    const originalUser = (await userBody(created)).user!;
    const firstCookie = sessionCookie(created);
    const otherLogin = await auth.handle(request('login', { id: 'test_user', password }), env);
    const secondCookie = sessionCookie(otherLogin!);
    const changedPassword = '  새로운 비밀번호🙂 123  ';
    const changed = await auth.handle(request('update-account', { currentPassword: password, id: ' ＣＬＯＵＤ_２ ', newPassword: changedPassword }, firstCookie), env);
    expect(changed?.status).toBe(200);
    const updatedUser = { userId: originalUser.userId, id: 'cloud_2' };
    expect(await userBody(changed!)).toEqual({ user: updatedUser });
    const updatedCookie = sessionCookie(changed!);
    expect(updatedCookie).not.toBe(firstCookie);
    expect(changed?.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(await auth.authenticate(request('session', undefined, firstCookie), env)).toBeNull();
    expect(await auth.authenticate(request('session', undefined, secondCookie), env)).toBeNull();
    expect(await auth.authenticate(request('session', undefined, updatedCookie), env)).toEqual(updatedUser);
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').all()).toHaveLength(1);
    expect(db.sqlite.prepare('SELECT * FROM wm_account_sessions').all()).toHaveLength(1);
    expect((await auth.handle(request('login', { id: 'test_user', password }), env))?.status).toBe(401);
    expect((await auth.handle(request('login', { id: 'cloud_2', password }), env))?.status).toBe(401);
    const newLogin = await auth.handle(request('login', { id: 'cloud_2', password: changedPassword }), env);
    expect(newLogin?.status).toBe(200);
    expect(await userBody(newLogin!)).toEqual({ user: updatedUser });
  });

  it('supports an ID-only change and a password-only change without losing the account', async () => {
    const { env, auth } = fixture();
    const created = await register(auth, env);
    const userId = (await userBody(created)).user!.userId;
    const changedId = await auth.handle(request('update-account', { currentPassword: password, id: 'renamed_user' }, sessionCookie(created)), env);
    expect(changedId?.status).toBe(200);
    expect(await userBody(changedId!)).toEqual({ user: { userId, id: 'renamed_user' } });
    const changedPassword = await auth.handle(request('update-account', { currentPassword: password, newPassword: 'New correct password 456' }, sessionCookie(changedId!)), env);
    expect(changedPassword?.status).toBe(200);
    expect(await userBody(changedPassword!)).toEqual({ user: { userId, id: 'renamed_user' } });
    expect((await auth.handle(request('login', { id: 'renamed_user', password: 'New correct password 456' }), env))?.status).toBe(200);
  });

  it('requires an existing session and the current password before changing account data', async () => {
    const { db, env, auth } = fixture();
    const created = await register(auth, env);
    const before = db.sqlite.prepare('SELECT * FROM wm_accounts').get();
    const signedOut = await auth.handle(request('update-account', { currentPassword: password, id: 'renamed_user' }), env);
    expect(signedOut?.status).toBe(401);
    expect((await errorBody(signedOut!)).error.code).toBe('AUTH_REQUIRED');
    const wrongPassword = await auth.handle(request('update-account', { currentPassword: 'Wrong password 123', id: 'renamed_user' }, sessionCookie(created)), env);
    expect(wrongPassword?.status).toBe(401);
    expect((await errorBody(wrongPassword!)).error.code).toBe('INVALID_CREDENTIALS');
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').get()).toEqual(before);
    expect(await auth.authenticate(request('session', undefined, sessionCookie(created)), env)).not.toBeNull();
  });

  it('rejects an occupied ID without altering either account or revoking existing sessions', async () => {
    const { db, env, auth } = fixture();
    const first = await register(auth, env);
    const second = await register(auth, env, 'occupied_id');
    const before = db.sqlite.prepare('SELECT * FROM wm_accounts ORDER BY login_id').all();
    const response = await auth.handle(request('update-account', { currentPassword: password, id: ' ＯＣＣＵＰＩＥＤ_ＩＤ ', newPassword: 'Changed password 123' }, sessionCookie(first)), env);
    expect(response?.status).toBe(409);
    expect((await errorBody(response!)).error.code).toBe('ID_TAKEN');
    expect(response?.headers.get('set-cookie')).toBeNull();
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts ORDER BY login_id').all()).toEqual(before);
    expect(await auth.authenticate(request('session', undefined, sessionCookie(first)), env)).not.toBeNull();
    expect(await auth.authenticate(request('session', undefined, sessionCookie(second)), env)).not.toBeNull();
    expect(db.sqlite.prepare('SELECT * FROM wm_account_sessions').all()).toHaveLength(2);
  });

  it('validates change fields and refuses effective no-ops', async () => {
    const { env, auth } = fixture();
    const created = await register(auth, env);
    const current = sessionCookie(created);
    for (const body of [
      { currentPassword: password },
      { currentPassword: password, id: ' ＴＥＳＴ_ＵＳＥＲ ' },
      { currentPassword: password, newPassword: password },
    ]) {
      const response = await auth.handle(request('update-account', body, current), env);
      expect(response?.status).toBe(400);
      expect((await errorBody(response!)).error.code).toBe('NO_CHANGES');
    }
    for (const body of [
      { currentPassword: password, id: null },
      { currentPassword: password, newPassword: 123 },
      { currentPassword: password, id: 'new_id', email: 'unrequested@example.com' },
      { id: 'new_id' },
    ]) {
      const response = await auth.handle(request('update-account', body, current), env);
      expect(response?.status).toBe(400);
      expect((await errorBody(response!)).error.code).toBe('INVALID_REQUEST');
    }
    const invalidId = await auth.handle(request('update-account', { currentPassword: password, id: 'bad-id' }, current), env);
    expect((await errorBody(invalidId!)).error.code).toBe('INVALID_ID');
    const invalidPassword = await auth.handle(request('update-account', { currentPassword: password, newPassword: 'short' }, current), env);
    expect((await errorBody(invalidPassword!)).error.code).toBe('INVALID_PASSWORD');
  });

  it('shares current-account login quotas with reauthentication and rejects cross-origin changes', async () => {
    const { db, env, auth, hashPassword } = fixture();
    const created = await register(auth, env);
    const current = sessionCookie(created);
    const calls = hashPassword.mock.calls.length;
    const batches = db.batch.mock.calls.length;
    const crossOrigin = await auth.handle(request('update-account', { currentPassword: password, id: 'renamed_user' }, current, { origin: 'https://evil.example' }), env);
    expect(crossOrigin?.status).toBe(403);
    expect(hashPassword.mock.calls).toHaveLength(calls);
    expect(db.batch.mock.calls).toHaveLength(batches);
    for (let i = 0; i < 9; i++) expect((await auth.handle(request('login', { id: 'test_user', password: 'Wrong password 123' }), env))?.status).toBe(401);
    const limited = await auth.handle(request('update-account', { currentPassword: password, id: 'renamed_user' }, current), env);
    expect(limited?.status).toBe(429);
    expect((await errorBody(limited!)).error.code).toBe('AUTH_RATE_LIMITED');
    expect(hashPassword).toHaveBeenCalledTimes(10);
  });

  it('allows only one simultaneous update to succeed and never revokes its replacement session from a stale update', async () => {
    const { db, env, auth } = fixture();
    const created = await register(auth, env);
    const current = sessionCookie(created);
    const results = await Promise.all([
      auth.handle(request('update-account', { currentPassword: password, id: 'first_rename' }, current), env),
      auth.handle(request('update-account', { currentPassword: password, id: 'second_rename' }, current), env),
    ]);
    expect(results.map(response => response!.status).sort()).toEqual([200, 409]);
    const loser = results.find(response => response!.status === 409)!;
    expect((await errorBody(loser)).error.code).toBe('ACCOUNT_CHANGED');
    expect(loser.headers.get('set-cookie')).toBeNull();
    const winner = results.find(response => response!.status === 200)!;
    const winnerUser = (await userBody(winner)).user;
    expect(await auth.authenticate(request('session', undefined, sessionCookie(winner)), env)).toEqual(winnerUser);
    expect(db.sqlite.prepare('SELECT * FROM wm_account_sessions').all()).toHaveLength(1);
    expect(await auth.authenticate(request('session', undefined, current), env)).toBeNull();
  });

  it('does not change credentials or issue a replacement when the active session was revoked during reauthentication', async () => {
    const { db, env, auth, hashPassword } = fixture();
    const created = await register(auth, env);
    const before = db.sqlite.prepare('SELECT * FROM wm_accounts').get();
    hashPassword.mockImplementationOnce(async (value, salt) => {
      db.sqlite.exec('DELETE FROM wm_account_sessions');
      return fastHash(value, salt);
    });
    const response = await auth.handle(request('update-account', { currentPassword: password, newPassword: 'Changed password 123' }, sessionCookie(created)), env);
    expect(response?.status).toBe(409);
    expect((await errorBody(response!)).error.code).toBe('ACCOUNT_CHANGED');
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').get()).toEqual(before);
    expect(db.sqlite.prepare('SELECT * FROM wm_account_sessions').all()).toHaveLength(0);
  });

  it('does not issue an old-password login session when credentials change during password verification', async () => {
    const { db, env, auth, hashPassword } = fixture();
    await register(auth, env);
    hashPassword.mockImplementationOnce(async (value, salt) => {
      db.sqlite.prepare('UPDATE wm_accounts SET password_hash = ?, salt = ?').run('a'.repeat(128), 'b'.repeat(32));
      db.sqlite.exec('DELETE FROM wm_account_sessions');
      return fastHash(value, salt);
    });
    const response = await auth.handle(request('login', { id: 'test_user', password }), env);
    expect(response?.status).toBe(401);
    expect((await errorBody(response!)).error.code).toBe('INVALID_CREDENTIALS');
    expect(response?.headers.get('set-cookie')).toBeNull();
    expect(db.sqlite.prepare('SELECT * FROM wm_account_sessions').all()).toHaveLength(0);
  });

  it('uses the private hasher binding for registration, login, and both password-change hashes', async () => {
    const db = database();
    const hashPassword = vi.fn(fastHash);
    const getByName = vi.fn(() => ({ hashPassword }));
    const env: AccountAuthEnv = { DB: db.binding, REQUIRE_PASSWORD_HASHER: 'true', PASSWORD_HASHER: { getByName } };
    const auth = createAccountAuth({ now: () => start });
    const created = await register(auth, env, 'rpc_account');
    const loggedIn = await auth.handle(request('login', { id: 'rpc_account', password }), env);
    expect(loggedIn?.status).toBe(200);
    const changed = await auth.handle(request('update-account', { currentPassword: password, newPassword: 'Changed RPC password 456' }, sessionCookie(created)), env);
    expect(changed?.status).toBe(200);
    expect(hashPassword).toHaveBeenCalledTimes(4);
    expect(hashPassword.mock.calls.map(([value]) => value)).toEqual([password, password, password, 'Changed RPC password 456']);
    for (let index = 0; index < getByName.mock.calls.length; index++) {
      const salt = hashPassword.mock.calls[index][1];
      expect(getByName.mock.calls[index]).toEqual([`whitemood-password-v1-${Number.parseInt(salt.slice(0, 2), 16) % 4}`]);
    }
    expect(await auth.authenticate(request('session', undefined, sessionCookie(created)), env)).toBeNull();
    expect(await auth.authenticate(request('session', undefined, sessionCookie(changed!)), env)).not.toBeNull();
  });

  it.each([true, 'true'])('fails closed without a private binding when standalone hashing is required=%s', async required => {
    const db = database();
    const auth = createAccountAuth({ now: () => start });
    const response = await auth.handle(request('register', { id: 'missing_rpc', password }), { DB: db.binding, REQUIRE_PASSWORD_HASHER: required });
    expect(response?.status).toBe(503);
    expect((await errorBody(response!)).error.code).toBe('AUTH_UNAVAILABLE');
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').all()).toHaveLength(0);
  });

  it.each(['not-a-hash', null, ['a'.repeat(128)]])('rejects malformed private hasher output without a native fallback (%s)', async result => {
    const db = database();
    const hashPassword = vi.fn(async () => result as string);
    const env: AccountAuthEnv = { DB: db.binding, PASSWORD_HASHER: { getByName: () => ({ hashPassword }) } };
    const auth = createAccountAuth({ now: () => start });
    const response = await auth.handle(request('register', { id: 'bad_rpc', password }), env);
    expect(response?.status).toBe(503);
    expect((await errorBody(response!)).error.code).toBe('AUTH_UNAVAILABLE');
    expect(hashPassword).toHaveBeenCalledOnce();
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').all()).toHaveLength(0);
  });

  it('fails closed on a private hasher RPC error without leaking its message or falling back to native work', async () => {
    const db = database();
    const hashPassword = vi.fn(async () => { throw new Error(`Private RPC error with ${password}`); });
    const env: AccountAuthEnv = { DB: db.binding, PASSWORD_HASHER: { getByName: () => ({ hashPassword }) } };
    const auth = createAccountAuth({ now: () => start });
    const response = await auth.handle(request('register', { id: 'failed_rpc', password }), env);
    expect(response?.status).toBe(503);
    expect(await response!.text()).not.toContain(password);
    expect(hashPassword).toHaveBeenCalledOnce();
    expect(db.sqlite.prepare('SELECT * FROM wm_accounts').all()).toHaveLength(0);
  });
});
