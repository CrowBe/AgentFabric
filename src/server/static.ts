import type { Handler } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const NOT_BUILT =
  'AgentFabric Web UI is not built. Run `npm run build:web`, or use the REST API at /api.';

/**
 * Serve the built operator UI with SPA fallback. Node-only: `node:fs` is imported lazily
 * so the same app can run on runtimes without a filesystem.
 */
export function createStaticHandler(rootDir: string): Handler {
  return async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    }
    let fs: typeof import('node:fs/promises');
    let path: typeof import('node:path');
    try {
      [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    } catch {
      return c.text(NOT_BUILT, 404);
    }

    const root = path.resolve(rootDir);
    let requested: string;
    try {
      requested = decodeURIComponent(c.req.path);
    } catch {
      return c.text('Bad request', 400);
    }
    if (requested.includes('\0')) return c.text('Bad request', 400);

    const candidate = path.resolve(root, `.${requested}`);
    const inside = candidate === root || candidate.startsWith(root + path.sep);
    const extension = path.extname(candidate).toLowerCase();

    const send = async (file: string, isIndex: boolean): Promise<Response | null> => {
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) return null;
        const body = await fs.readFile(file);
        const headers: Record<string, string> = {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
        };
        if (isIndex) {
          headers['content-security-policy'] = UI_CSP;
          headers['referrer-policy'] = 'no-referrer';
        }
        return new Response(c.req.method === 'HEAD' ? null : body, { headers });
      } catch {
        return null;
      }
    };

    if (inside && extension && candidate !== root) {
      const asset = await send(candidate, false);
      if (asset) return asset;
      return c.text('Not found', 404);
    }
    const index = await send(path.join(root, 'index.html'), true);
    return index ?? c.text(NOT_BUILT, 404);
  };
}
