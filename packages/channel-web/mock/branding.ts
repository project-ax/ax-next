import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Offline dev mock for the public branding surface. Returns the unbranded
 * defaults so the SPA's BrandingProvider resolves cleanly in mock mode; logo
 * bytes 404 (no logo configured). The real surface lives in `@ax/branding`.
 */
export function brandingMiddleware(): (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean> {
  return async (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && path === '/api/branding') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: '',
          logoType: 'full',
          light: false,
          dark: false,
          version: '',
        }),
      );
      return true;
    }
    if (req.method === 'GET' && path.startsWith('/api/branding/logo/')) {
      res.statusCode = 404;
      res.end();
      return true;
    }
    return false;
  };
}
