import { describe, expect, it, vi } from 'vitest';
import { createApplicationApi } from '../server/applicationApi';
import type { AccountUser } from '../server/accounts';

function setup(user: AccountUser | null = null) {
  const auth = { handle: vi.fn(async () => Response.json({ user })), authenticate: vi.fn(async () => user) };
  const guard = vi.fn(async () => ({}));
  const api = vi.fn(async () => Response.json({ ok: true }));
  return { auth, guard, api, handle: createApplicationApi({ auth, guard, api }) };
}
const origin = 'https://whitemood.example';

describe('account-protected application routing', () => {
  it.each(['/api/respond', '/api/respond/', '/api/transcribe', '/api/memory/consolidate'])('never invokes AI for an unsigned visitor at %s', async path => {
    const test = setup();
    const response = await test.handle(new Request(origin + path, { method: 'POST' }), {});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: expect.any(String) } });
    expect(test.api).not.toHaveBeenCalled(); expect(test.guard).not.toHaveBeenCalled();
  });

  it('binds quota use to the authenticated account, independent of browser cookie rotation', async () => {
    const test = setup({ userId: 'stable-user-uuid', id: 'alice' });
    const request = new Request(origin + '/api/respond', { method: 'POST' });
    expect((await test.handle(request, {})).status).toBe(200);
    expect(test.guard).toHaveBeenCalledWith(request, {}, 'stable-user-uuid');
    expect(test.api).toHaveBeenCalledWith(request, {});
  });

  it('permits real account endpoints without asking for a ChatGPT identity', async () => {
    const test = setup(); const request = new Request(origin + '/api/auth/register', { method: 'POST' });
    await test.handle(request, {});
    expect(test.auth.handle).toHaveBeenCalledWith(request, {});
    expect(test.auth.authenticate).not.toHaveBeenCalled(); expect(test.api).not.toHaveBeenCalled();
  });

  it('fails closed when account storage fails and never reaches the provider', async () => {
    const test = setup(); test.auth.authenticate.mockRejectedValueOnce(new Error('internal database details'));
    const response = await test.handle(new Request(origin + '/api/respond', { method: 'POST' }), {});
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('internal database details');
    expect(test.guard).not.toHaveBeenCalled(); expect(test.api).not.toHaveBeenCalled();
  });
});
