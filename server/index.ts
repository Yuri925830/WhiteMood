import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler, errorResponse, SECURITY_HEADERS } from './api';
import { ApiFailure } from './validation';

const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const origin = `http://127.0.0.1:${port}`;
const devOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const allowedOrigins = [...devOrigins, ...((process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean))];
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173']);
const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const handler = createApiHandler({
  apiKey: process.env.GROQ_API_KEY,
  chatModel: process.env.GROQ_CHAT_MODEL,
  sttModel: process.env.GROQ_STT_MODEL,
  analysisUrl: process.env.ANALYSIS_API_URL,
  analysisToken: process.env.ANALYSIS_API_TOKEN,
  allowedOrigins,
});

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wav': 'audio/wav',
};
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

async function staticResponse(url: URL, method: string): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return errorResponse(new ApiFailure(405, 'METHOD_NOT_ALLOWED', 'This method is not supported.'));
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return errorResponse(new ApiFailure(400, 'INVALID_REQUEST', 'The request path is invalid.')); }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) {
    return errorResponse(new ApiFailure(404, 'NOT_FOUND', 'This file does not exist.'));
  }
  try {
    const root = await realpath(distPath);
    let requested = resolve(root, '.' + pathname);
    if (requested !== root && !requested.startsWith(root + sep)) throw new Error();
    let info;
    try { info = await stat(requested); } catch { /* Client-side routes can use index.html. */ }
    if (!info || info.isDirectory()) {
      if (extname(pathname)) throw new Error();
      requested = resolve(root, 'index.html');
    }
    const actual = await realpath(requested);
    if (!actual.startsWith(root + sep)) throw new Error();
    const bytes = await readFile(actual);
    return new Response(method === 'HEAD' ? null : new Uint8Array(bytes), {
      headers: { ...SECURITY_HEADERS, 'Content-Type': mime[extname(actual)] || 'application/octet-stream', 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY' },
    });
  } catch {
    return errorResponse(new ApiFailure(404, 'NOT_FOUND', 'The built website is unavailable. Run npm run build before npm start, or use npm run dev.'));
  }
}

async function send(response: Response, res: ServerResponse) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>(resolve => res.once('drain', resolve));
    }
    res.end();
  } catch { res.destroy(); }
  finally { reader.releaseLock(); }
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const abort = new AbortController();
  req.on('aborted', () => abort.abort());
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  try {
    // Loopback binding plus strict Host validation protects a local key from DNS rebinding.
    const host = req.headers.host;
    if (!host || !allowedHosts.has(host)) {
      await send(errorResponse(new ApiFailure(403, 'HOST_NOT_ALLOWED', 'This host is not allowed.')), res);
      return;
    }
    const url = new URL(req.url || '/', `http://${host}`);
    if (url.host !== host || url.protocol !== 'http:') throw new ApiFailure(400, 'INVALID_REQUEST', 'The request URL is invalid.');
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, signal: abort.signal };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
        init.duplex = 'half';
      }
      const response = await handler(new Request(url, init), { clientIp: req.socket.remoteAddress });
      await send(response, res);
    } else {
      await send(await staticResponse(url, req.method || 'GET'), res);
    }
  } catch (error) {
    if (!res.headersSent) await send(errorResponse(error), res);
    else res.destroy();
  }
}

const server = createServer((req, res) => { void route(req, res); });
server.requestTimeout = 45_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.on('error', error => { console.error('WhiteMood API failed to start:', (error as NodeJS.ErrnoException).code || error.name); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`WhiteMood API: ${origin} (loopback only; audio and conversation content are not logged)`);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close());
