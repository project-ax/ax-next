import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store';
import { authMiddleware } from './auth';
import { chatMiddleware } from './chat';
import { agentsMiddleware } from './agents';
import { adminAgentsMiddleware } from './admin/agents';
import { adminMcpServersMiddleware } from './admin/mcp-servers';
import { adminTeamsMiddleware } from './admin/teams';

export function createMockHandler(dataDir?: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const dir = dataDir ?? resolve(process.cwd(), '.mock-data');
  const store = new Store(dir);
  store.seed();
  const handlers = [
    authMiddleware(store),
    chatMiddleware(store),
    agentsMiddleware(store),
    adminAgentsMiddleware(store),
    adminMcpServersMiddleware(store),
    adminTeamsMiddleware(store),
  ];
  return async (req, res) => {
    for (const h of handlers) {
      if (await h(req, res)) return true;
    }
    return false;
  };
}

export function mockMiddleware(dataDir?: string): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const handler = createMockHandler(dataDir);
  return (req, res, next) => {
    handler(req, res).then((handled) => {
      if (!handled) next();
    }).catch((err) => {
      console.error('[mock] error', err);
      res.statusCode = 500;
      res.end();
    });
  };
}
