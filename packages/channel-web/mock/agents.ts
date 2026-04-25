import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store';
import { canUseAgent, requireSession } from './auth';

export interface Agent {
  id: string;
  owner_id: string;
  owner_type: 'user' | 'team';
  name: string;
  tag: string;
  desc: string;
  color: string;
  system_prompt: string;
  allowed_tools: string[];
  mcp_config_ids: string[];
  model: string;
  created_at: number;
  updated_at: number;
}

export interface AgentInput {
  // All Agent fields except id/created_at/updated_at — server fills those.
  // owner_id + owner_type required on POST; optional on PATCH (admin can transfer ownership).
  owner_id?: string;
  owner_type?: 'user' | 'team';
  name?: string;
  tag?: string;
  desc?: string;
  color?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  mcp_config_ids?: string[];
  model?: string;
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

export function agentsMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/agents')) return false;

    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/agents' && method === 'GET') {
      const user = requireSession(req, store);
      if (!user) return send(res, 401, {}), true;
      const all = store.collection<Agent>('agents').list();
      const usable = all
        .filter((a) => canUseAgent(user, a, store))
        .sort((a, b) => a.name.localeCompare(b.name));
      send(res, 200, { agents: usable });
      return true;
    }

    return false;
  };
}
