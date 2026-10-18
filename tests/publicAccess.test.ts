import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createPublicAccessGuard, type PublicAccessEnv } from '../server/publicAccess';
import type { ApiErrorBody } from '../shared/types';

const origin = 'https://whitemood.example';
const secret = 'test-only-session-secret-with-more-than-32-characters';
const start = Date.UTC(2026, 9, 18, 1, 2, 3);
const errorBody = async (response: Response): Promise<ApiErrorBody> => await response.json() as ApiErrorBody;

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE wm_request_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
  class Statement {
    values: SQLInputValue[] = [];
    constructor(public sql: string) {}
    bind(...values: SQLInputValue[]) { this.values = values; return this; }
  }
  const batch = vi.fn(async (statements: Statement[]) => {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => ({ success: true, results: sqlite.prepare(statement.sql).all(...statement.values), meta: {} }));
      sqlite.exec('COMMIT');
      return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  });
  return { sqlite, batch, binding: { prepare: (sql: string) => new Statement(sql), batch } as unknown as D1Database };
}

function req(path = '/api/respond', cookie?: string, headers: Record<string, string> = {}, base = origin) {
  return new Request(`${base}${path}`, {
    method: path === '/api/health' ? 'GET' : 'POST',
    headers: { origin, ...(cookie ? { cookie } : {}), ...headers },
  });
}

async function cookie(guard: ReturnType<typeof createPublicAccessGuard>, env: PublicAccessEnv, existing?: string) {
  const decision = await guard(req('/api/health', existing), env);
  expect(decision.response).toBeUndefined();
  expect(decision.setCookie).toBeTruthy();
  return decision.setCookie!.split(';')[0];
}

describe('public anonymous API access', () => {
  it('issues a secure HttpOnly signed random session without needing a login or database write', async () => {
    const db = database();
    const guard = createPublicAccessGuard(() => start);
    const decision = await guard(req('/api/health'), { SESSION_SECRET: secret, DB: db.binding });
    expect(decision.response).toBeUndefined();
    expect(decision.setCookie).toMatch(/^wm_session=[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}; Path=\/api; Max-Age=86400; HttpOnly; Secure; SameSite=Strict$/);
    expect(decision.setCookie).not.toContain(secret);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('rejects missing, forged, modified, malformed and duplicate cookies before counting or calling AI', async () => {
    const db = database();
    const env = { SESSION_SECRET: secret, DB: db.binding };
    const guard = createPublicAccessGuard(() => start);
    const valid = await cookie(guard, env);
    const forgedSignature = valid.slice(0, -43) + (valid.at(-43) === 'A' ? 'B' : 'A') + valid.slice(-42);
    const invalid = [undefined, 'wm_session=forged', `${valid}x`, forgedSignature, valid.replace(/\d{10}\./, '1999999999.'), `${valid}; ${valid}`];
    for (const value of invalid) {
      const decision = await guard(req('/api/respond', value), env);
      expect(decision.response?.status).toBe(401);
      expect(await errorBody(decision.response!)).toEqual({ error: { code: 'SESSION_REQUIRED', message: 'Refresh the page before continuing.' } });
    }
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('accepts valid cookies across separate Worker guard instances using the same secret', async () => {
    const db = database();
    const env = { SESSION_SECRET: secret, DB: db.binding };
    const signed = await cookie(createPublicAccessGuard(() => start), env);
    expect(await createPublicAccessGuard(() => start)(req('/api/respond', signed), env)).toEqual({});
    expect(db.batch).toHaveBeenCalledOnce();
  });

  it('preserves the anonymous id when health refreshes the cookie and rejects expired or rotated signatures', async () => {
    const db = database();
    const env = { SESSION_SECRET: secret, DB: db.binding };
    let time = start;
    const guard = createPublicAccessGuard(() => time);
    const initial = await cookie(guard, env);
    time += 5_000;
    const refreshed = await cookie(guard, env, initial);
    expect(refreshed.split('.')[0]).toBe(initial.split('.')[0]);
    expect(refreshed).not.toBe(initial);
    expect((await guard(req('/api/respond', refreshed), { ...env, SESSION_SECRET: `${secret}-rotated` })).response?.status).toBe(401);
    time = start + 86_400_000;
    expect((await guard(req('/api/respond', initial), env)).response?.status).toBe(401);
  });

  it('checks Origin before granting cookies or database access, including null and spoofed forwarding headers', async () => {
    const db = database();
    const env = { SESSION_SECRET: secret, DB: db.binding, SITE_ORIGIN: origin };
    const guard = createPublicAccessGuard(() => start);
    for (const untrusted of ['https://attacker.example', 'null', `${origin}.evil.example`]) {
      const decision = await guard(req('/api/health', undefined, { origin: untrusted, 'x-forwarded-host': 'whitemood.example' }), env);
      expect(decision.response?.status).toBe(403);
      expect(decision.setCookie).toBeUndefined();
    }
    const decision = await guard(new Request(`${origin}/api/health`, { headers: { 'sec-fetch-site': 'cross-site' } }), env);
    expect(decision.response?.status).toBe(403);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('accepts a same-origin health fetch without Origin and the configured external origin behind the gateway', async () => {
    const db = database();
    const env = { SESSION_SECRET: secret, DB: db.binding, SITE_ORIGIN: origin };
    const guard = createPublicAccessGuard(() => start);
    expect((await guard(new Request(`${origin}/api/health`), env)).setCookie).toBeTruthy();
    expect((await guard(req('/api/health', undefined, {}, 'https://internal.worker'), env)).setCookie).toBeTruthy();
  });

  it('enforces 10 session requests per minute and recovers at the window boundary', async () => {
    const db = database();
    const env = { SESSION_SECRET: secret, DB: db.binding };
    let time = start;
    const guard = createPublicAccessGuard(() => time);
    const signed = await cookie(guard, env);
    for (let i = 0; i < 10; i++) expect(await guard(req('/api/transcribe', signed), env)).toEqual({});
    const limited = await guard(req('/api/respond', signed), env);
    expect(limited.response?.status).toBe(429);
    expect(limited.response?.headers.get('retry-after')).toBe('57');
    expect((await errorBody(limited.response!)).error.retryAfter).toBe(57);
    time += 60_000;
    expect(await guard(req('/api/respond', signed), env)).toEqual({});
  });

  it('enforces the global minute quota across sessions and concurrent Worker instances', async () => {
    const db = database();
    const env = { SESSION_SECRET: secret, DB: db.binding };
    const a = createPublicAccessGuard(() => start);
    const b = createPublicAccessGuard(() => start);
    const first = await cookie(a, env);
    const second = await cookie(b, env);
    const decisions = await Promise.all(Array.from({ length: 14 }, (_, i) => (i % 2 ? a : b)(req('/api/respond', i % 2 ? first : second), env)));
    expect(decisions.filter(decision => !decision.response)).toHaveLength(12);
    expect(decisions.filter(decision => decision.response?.status === 429)).toHaveLength(2);
  });

  it('enforces the session daily quota across minutes without storing conversation data or IP addresses', async () => {
    const db = database();
    const env = { SESSION_SECRET: secret, DB: db.binding };
    let time = start;
    const guard = createPublicAccessGuard(() => time);
    const signed = await cookie(guard, env);
    for (let i = 0; i < 80; i++) {
      time = start + Math.floor(i / 10) * 60_000;
      expect(await guard(req('/api/summarize', signed, { 'x-forwarded-for': 'sensitive-ip' }), env)).toEqual({});
    }
    time += 60_000;
    const decision = await guard(req('/api/memory/consolidate', signed), env);
    expect(decision.response?.status).toBe(429);
    expect(Number(decision.response?.headers.get('retry-after'))).toBeGreaterThan(60);
    const rows = db.sqlite.prepare('SELECT * FROM wm_request_limits').all();
    expect(JSON.stringify(rows)).not.toContain('sensitive-ip');
    expect(rows.every(row => Object.keys(row).sort().join(',') === 'count,expires_at,id')).toBe(true);
  });

  it('enforces the global daily quota across sessions and clears buckets older than one day', async () => {
    const db = database();
    db.sqlite.prepare('INSERT INTO wm_request_limits VALUES (?, ?, ?)').run('expired', 1, Math.floor(start / 1000) - 86_401);
    const env = { SESSION_SECRET: secret, DB: db.binding };
    let time = start;
    const guard = createPublicAccessGuard(() => time);
    const sessions = await Promise.all(Array.from({ length: 3 }, () => cookie(guard, env)));
    for (let i = 0; i < 200; i++) {
      time = start + Math.floor(i / 10) * 60_000;
      expect(await guard(req('/api/respond', sessions[i % 3]), env)).toEqual({});
    }
    time += 60_000;
    expect((await guard(req('/api/respond', sessions[2]), env)).response?.status).toBe(429);
    expect(db.sqlite.prepare("SELECT * FROM wm_request_limits WHERE id = 'expired'").all()).toHaveLength(0);
  });

  it('fails closed when secrets, the D1 binding, the schema or the database result are unavailable', async () => {
    const db = database();
    const guard = createPublicAccessGuard(() => start);
    for (const env of [{ DB: db.binding }, { SESSION_SECRET: secret }, { SESSION_SECRET: 'short', DB: db.binding }]) {
      expect((await guard(req('/api/health'), env)).response?.status).toBe(503);
    }
    const env = { SESSION_SECRET: secret, DB: db.binding };
    const signed = await cookie(guard, env);
    db.batch.mockResolvedValueOnce([]);
    expect((await guard(req('/api/respond', signed), env)).response?.status).toBe(503);
    db.batch.mockRejectedValueOnce(new Error('private database details'));
    const decision = await guard(req('/api/respond', signed), env);
    expect(decision.response?.status).toBe(503);
    expect(await decision.response?.text()).not.toContain('private database details');
    db.sqlite.exec('DROP TABLE wm_request_limits');
    expect((await guard(req('/api/respond', signed), env)).response?.status).toBe(503);
  });
});
