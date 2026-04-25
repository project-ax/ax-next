import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Store } from '../store';
import { requireAdmin } from '../auth';
import type { Agent, AgentInput } from '../agents';

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

function newAgentId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('base64url').slice(0, 6);
  return `agent-${ts}-${rand}`;
}

export function adminAgentsMiddleware(
  store: Store,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/admin/agents')) return false;

    const parsed = new URL(url, 'http://x');
    const path = parsed.pathname;
    const method = req.method ?? 'GET';

    const gate = requireAdmin(req, store);
    if ('status' in gate) {
      send(res, gate.status, {});
      return true;
    }

    const agents = store.collection<Agent>('agents');

    if (path === '/api/admin/agents' && method === 'GET') {
      send(res, 200, { agents: agents.list() });
      return true;
    }

    if (path === '/api/admin/agents' && method === 'POST') {
      const body = (await readJsonBody(req)) as AgentInput;
      if (
        !body.owner_id ||
        !body.owner_type ||
        !body.name ||
        !body.model
      ) {
        send(res, 400, { error: 'missing required fields' });
        return true;
      }
      const now = Date.now();
      const agent: Agent = {
        id: newAgentId(),
        owner_id: body.owner_id,
        owner_type: body.owner_type,
        name: body.name,
        tag: body.tag ?? '',
        desc: body.desc ?? '',
        color: body.color ?? '#7aa6c9',
        system_prompt: body.system_prompt ?? '',
        allowed_tools: body.allowed_tools ?? [],
        mcp_config_ids: body.mcp_config_ids ?? [],
        model: body.model,
        created_at: now,
        updated_at: now,
      };
      agents.upsert(agent);
      send(res, 201, { id: agent.id });
      return true;
    }

    const idMatch = path.match(/^\/api\/admin\/agents\/([^/]+)$/);
    if (idMatch && idMatch[1]) {
      const id = idMatch[1];

      if (method === 'PATCH') {
        const existing = agents.get(id);
        if (!existing) {
          send(res, 404, { error: 'not found' });
          return true;
        }
        const body = (await readJsonBody(req)) as AgentInput;
        const next: Agent = {
          ...existing,
          ...(body.owner_id !== undefined ? { owner_id: body.owner_id } : {}),
          ...(body.owner_type !== undefined ? { owner_type: body.owner_type } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.tag !== undefined ? { tag: body.tag } : {}),
          ...(body.desc !== undefined ? { desc: body.desc } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.system_prompt !== undefined ? { system_prompt: body.system_prompt } : {}),
          ...(body.allowed_tools !== undefined ? { allowed_tools: body.allowed_tools } : {}),
          ...(body.mcp_config_ids !== undefined ? { mcp_config_ids: body.mcp_config_ids } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          updated_at: Math.max(Date.now(), existing.updated_at + 1),
        };
        agents.upsert(next);
        send(res, 200, {});
        return true;
      }

      if (method === 'DELETE') {
        agents.remove(id);
        send(res, 204);
        return true;
      }
    }

    return false;
  };
}
