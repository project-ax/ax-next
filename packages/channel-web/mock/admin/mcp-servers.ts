import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Store } from '../store';
import { requireAdmin } from '../auth';

export interface McpServer {
  id: string;
  name: string;
  url: string;
  transport: 'http' | 'stdio' | 'sse';
  credentials_id?: string;
  created_at: number;
  updated_at: number;
}

export interface McpServerInput {
  name?: string;
  url?: string;
  transport?: 'http' | 'stdio' | 'sse';
  credentials_id?: string;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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

function newMcpId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('base64url').slice(0, 6);
  return `mcp-${ts}-${rand}`;
}

const VALID_TRANSPORTS = new Set(['http', 'stdio', 'sse']);

export function adminMcpServersMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/admin/mcp-servers')) return false;

    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const method = req.method ?? 'GET';

    const gate = requireAdmin(req, store);
    if ('status' in gate) {
      send(res, gate.status, {});
      return true;
    }

    const servers = store.collection<McpServer>('mcp-servers');

    if (path === '/api/admin/mcp-servers' && method === 'GET') {
      send(res, 200, { servers: servers.list() });
      return true;
    }

    if (path === '/api/admin/mcp-servers' && method === 'POST') {
      const body = (await readJsonBody(req)) as McpServerInput;
      if (!body.name || !body.url || !body.transport || !VALID_TRANSPORTS.has(body.transport)) {
        send(res, 400, { error: 'missing or invalid fields' });
        return true;
      }
      const now = Date.now();
      const server: McpServer = {
        id: newMcpId(),
        name: body.name,
        url: body.url,
        transport: body.transport,
        ...(body.credentials_id !== undefined ? { credentials_id: body.credentials_id } : {}),
        created_at: now,
        updated_at: now,
      };
      servers.upsert(server);
      send(res, 201, { id: server.id });
      return true;
    }

    // /api/admin/mcp-servers/:id  and  /api/admin/mcp-servers/:id/test
    const idMatch = path.match(/^\/api\/admin\/mcp-servers\/([^/]+)(\/test)?$/);
    if (idMatch && idMatch[1]) {
      const id = idMatch[1];
      const isTest = !!idMatch[2];

      if (isTest && method === 'POST') {
        // Mock always succeeds. Future task could simulate failure via header.
        send(res, 200, { ok: true });
        return true;
      }

      if (!isTest && method === 'PATCH') {
        const existing = servers.get(id);
        if (!existing) {
          send(res, 404, { error: 'not found' });
          return true;
        }
        const body = (await readJsonBody(req)) as McpServerInput;
        if (body.transport !== undefined && !VALID_TRANSPORTS.has(body.transport)) {
          send(res, 400, { error: 'invalid transport' });
          return true;
        }
        const next: McpServer = {
          ...existing,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.url !== undefined ? { url: body.url } : {}),
          ...(body.transport !== undefined ? { transport: body.transport } : {}),
          ...(body.credentials_id !== undefined ? { credentials_id: body.credentials_id } : {}),
          updated_at: Math.max(Date.now(), existing.updated_at + 1),
        };
        servers.upsert(next);
        send(res, 200, {});
        return true;
      }

      if (!isTest && method === 'DELETE') {
        servers.remove(id);
        send(res, 204);
        return true;
      }
    }

    return false;
  };
}
