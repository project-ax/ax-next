import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store';
import { authMiddleware } from './auth';
import { chatMiddleware } from './chat';
import { agentsMiddleware } from './agents';
import { adminAgentsMiddleware } from './admin/agents';
import { adminMcpServersMiddleware } from './admin/mcp-servers';
import {
  adminConnectorsMiddleware,
  settingsConnectorsMiddleware,
} from './admin/connectors';
import { adminTeamsMiddleware } from './admin/teams';
import { brandingMiddleware } from './branding';

// Package-relative, NOT process.cwd() — a cwd-relative fallback here would
// scatter its seed JSONs wherever the caller's shell happens to be (which can
// be the repo root). See TASK-376.
const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '.mock-data');

export function createMockHandler(dataDir?: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const dir = dataDir ?? DEFAULT_DATA_DIR;
  const store = new Store(dir);
  store.seed();
  const handlers = [
    brandingMiddleware(),
    authMiddleware(store),
    chatMiddleware(store),
    agentsMiddleware(store),
    adminAgentsMiddleware(store),
    adminMcpServersMiddleware(store),
    adminConnectorsMiddleware(store),
    settingsConnectorsMiddleware(store),
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
