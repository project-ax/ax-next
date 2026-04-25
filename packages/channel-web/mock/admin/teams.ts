import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store';
import { requireAdmin } from '../auth';

export interface Team {
  id: string;
  name: string;
  members: string[];
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  res.statusCode = status;
  if (body === undefined) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload);
}

export function adminTeamsMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/admin/teams')) return false;

    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const method = req.method ?? 'GET';

    const gate = requireAdmin(req, store);
    if ('status' in gate) {
      send(res, gate.status, {});
      return true;
    }

    if (path === '/api/admin/teams' && method === 'GET') {
      send(res, 200, { teams: store.collection<Team>('teams').list() });
      return true;
    }

    return false;
  };
}
