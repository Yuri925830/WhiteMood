import { createApiHandler, errorResponse } from './api';
import { ApiFailure } from './validation';

/** Runtime bindings only. These values must never be included in the client build. */
export interface HostedApiEnv {
  GROQ_API_KEY?: string;
  GROQ_CHAT_MODEL?: string;
  GROQ_STT_MODEL?: string;
  ANALYSIS_API_URL?: string;
  ANALYSIS_API_TOKEN?: string;
  /** The one external HTTPS origin, if the hosting gateway uses an internal request URL. */
  SITE_ORIGIN?: string;
}

interface CachedApi {
  apiKey: string;
  chatModel: string;
  sttModel: string;
  analysisUrl: string;
  analysisToken: string;
  siteOrigin: string;
  handle: ReturnType<typeof createApiHandler>;
}

function externalOrigin(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    // An exact origin prevents accidentally authorizing paths, credentials, wildcards or null.
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error();
    return url.origin;
  } catch {
    throw new ApiFailure(503, 'HOSTED_CONFIGURATION', 'The hosted API origin needs configuration.');
  }
}

/**
 * Adapt the existing Fetch API handler. Authentication and distributed quotas are
 * enforced by the publicAccess guard in the Worker before this core is invoked.
 *
 * Reuse the handler across requests with equal bindings, even when the runtime creates
 * a new env object. Its fixed-window buckets are only isolate-local supplemental limits.
 */
export function createHostedApi(): (request: Request, env: HostedApiEnv) => Promise<Response> {
  let cached: CachedApi | undefined;
  return async (request, env) => {
    try {
      const apiKey = env.GROQ_API_KEY?.trim() ?? '';
      const chatModel = env.GROQ_CHAT_MODEL?.trim() || 'openai/gpt-oss-120b';
      const sttModel = env.GROQ_STT_MODEL?.trim() || 'whisper-large-v3-turbo';
      const analysisUrl = env.ANALYSIS_API_URL?.trim() ?? '';
      const analysisToken = env.ANALYSIS_API_TOKEN?.trim() ?? '';
      const siteOrigin = externalOrigin(env.SITE_ORIGIN?.trim() ?? '');

      if (!cached || cached.apiKey !== apiKey || cached.chatModel !== chatModel
        || cached.sttModel !== sttModel || cached.analysisUrl !== analysisUrl
        || cached.analysisToken !== analysisToken || cached.siteOrigin !== siteOrigin) {
        cached = {
          apiKey, chatModel, sttModel, analysisUrl, analysisToken, siteOrigin,
          handle: createApiHandler({ apiKey, chatModel, sttModel, analysisUrl, analysisToken, allowedOrigins: siteOrigin ? [siteOrigin] : [] }),
        };
      }

      // Do not rewrite the request URL or trust caller-controlled forwarding/IP headers.
      // With no verified per-visitor IP binding, the local limiter uses one shared bucket.
      return await cached.handle(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
