import { createHostedApi, type HostedApiEnv } from './hosted';
import { createPublicAccessGuard, type PublicAccessEnv } from './publicAccess';
import { createAccountAuth, type AccountAuthEnv } from './accounts';
import { SECURITY_HEADERS } from './api';

export type ApplicationEnv = HostedApiEnv & PublicAccessEnv & AccountAuthEnv;
interface Dependencies {
  auth: ReturnType<typeof createAccountAuth>;
  guard: ReturnType<typeof createPublicAccessGuard>;
  api: ReturnType<typeof createHostedApi>;
}

const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: SECURITY_HEADERS });

/** All AI routes pass through real account authentication, then shared quotas. */
export function createApplicationApi(dependencies: Partial<Dependencies> = {}) {
  const auth = dependencies.auth ?? createAccountAuth();
  const guard = dependencies.guard ?? createPublicAccessGuard();
  const api = dependencies.api ?? createHostedApi();
  return async (request: Request, env: ApplicationEnv): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname.replace(/\/+$/, '');
      if (path === '/api/auth' || path.startsWith('/api/auth/')) {
        return await auth.handle(request, env) ?? fail(404, 'NOT_FOUND', 'This endpoint does not exist.');
      }
      const health = path === '/api/health' && request.method === 'GET';
      const user = health ? null : await auth.authenticate(request, env);
      if (!health && !user) return fail(401, 'AUTH_REQUIRED', 'Please sign in to WhiteMood before continuing.');
      const gate = await guard(request, env, user?.userId);
      if (gate.response) return gate.response;
      const response = await api(request, env);
      if (!gate.setCookie) return response;
      const headers = new Headers(response.headers);
      headers.append('Set-Cookie', gate.setCookie);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      // Never turn database/session failures into anonymous provider access.
      return fail(503, 'AUTH_UNAVAILABLE', 'Account services are temporarily unavailable.');
    }
  };
}
