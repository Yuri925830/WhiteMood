declare namespace Cloudflare {
  interface Env {
    GROQ_API_KEY?: string;
    GROQ_CHAT_MODEL?: string;
    GROQ_STT_MODEL?: string;
    SITE_ORIGIN?: string;
    SESSION_SECRET?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
