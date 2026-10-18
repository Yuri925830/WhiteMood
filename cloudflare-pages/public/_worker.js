export default {
  async fetch(request, env) {
    if (!env.WHITEMOOD_APP || typeof env.WHITEMOOD_APP.fetch !== 'function') {
      return unavailable();
    }
    try {
      // The private service binding carries the original request unchanged,
      // including its public origin, streaming body, and account cookies.
      return await env.WHITEMOOD_APP.fetch(request);
    } catch {
      return unavailable();
    }
  },
};

function unavailable() {
  return new Response('WhiteMood is temporarily unavailable. Please try again later.', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Retry-After': '30',
    },
  });
}
