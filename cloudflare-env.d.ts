declare namespace Cloudflare {
  interface Env {
    GROQ_API_KEY?: string;
    GROQ_CHAT_MODEL?: string;
    GROQ_STT_MODEL?: string;
    SITE_ORIGIN?: string;
    SESSION_SECRET?: string;
    ASSETS?: Fetcher;
    PASSWORD_HASHER?: DurableObjectNamespace<import("./server/passwordHasher").PasswordHasher>;
    REQUIRE_PASSWORD_HASHER?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
