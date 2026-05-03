// @ax/cli serve-routes plugin.
//
// Registers `POST /chat` + `GET /health` against @ax/http-server via
// `http:register-route`. Replaces the standalone `http.createServer` the
// `serve` subcommand used to spin up — see issue #39 for the half-wired
// listener collision this plugin closes.
//
// Auth: optional bearer token via AX_SERVE_TOKEN. If unset, /chat is open
// to anything that can route to the public listener. The serve subcommand
// logs a loud warning at boot when unset; this plugin keeps the bearer
// check inside the handler so headless CLI use (`curl -H "Authorization:
// Bearer …"`) keeps working unchanged after the move.
//
// CSRF: @ax/http-server's built-in subscriber enforces CSRF on state-
// changing methods. POST /chat callers must EITHER carry an Origin in
// `AX_HTTP_ALLOWED_ORIGINS` OR set `X-Requested-With: ax-admin`. Headless
// CLI callers should add the latter; the chart sets
// `AX_HTTP_ALLOW_NO_ORIGINS=1` to silence the http-server's empty-allow-
// list warning so this stays the documented kind/canary path.
//
// /health is unauthenticated (k8s probes hit it). GET methods aren't
// subject to CSRF.
//
// Manifest:
//   - registers: nothing (this plugin contributes HTTP routes, not bus hooks)
//   - calls: http:register-route, session:create, agent:invoke
//   - subscribes: nothing
//
// Why a plugin and not inline route registration in serve.ts: the kernel
// topologically sorts on `manifest.calls`, so http:register-route is
// guaranteed to be wired before this plugin's init() runs. Doing it inline
// would mean racing http-server's init().

import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  PluginError,
  makeAgentContext,
  type AgentContext,
  type AgentMessage,
  type AgentOutcome,
  type HookBus,
  type Plugin,
} from '@ax/core';

const PLUGIN_NAME = '@ax/cli/serve-routes';

// Bound the request body. Chat messages can be long but they're not files —
// 1 MiB is more than enough and matches @ax/http-server's MAX_BODY_BYTES
// (which already enforces the same cap before our handler runs).
const MAX_BODY_BYTES = 1 * 1024 * 1024;

export interface ServeRoutesConfig {
  /** Bearer token for /chat. When undefined or empty, /chat is open. */
  serveToken: string | undefined;
}

// Duck-typed request/response shapes. Mirror @ax/http-server's HttpRequest /
// HttpResponse minus the import (Invariant I2 — no @ax/http-server import
// in cli code). Re-declared structurally so this plugin stays free of the
// http-server dep.
interface RouteRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface RegisterRouteInput {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: RouteHandler;
}

interface RegisterRouteOutput {
  unregister(): void;
}

export function createServeRoutesPlugin(config: ServeRoutesConfig): Plugin {
  const unregisters: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['http:register-route', 'session:create', 'agent:invoke'],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      const healthHandler: RouteHandler = async (_req, res) => {
        res.status(200).json({ ok: true });
      };

      const chatHandler: RouteHandler = async (req, res) => {
        await handleChat(req, res, bus, config.serveToken);
      };

      const healthResult = await bus.call<RegisterRouteInput, RegisterRouteOutput>(
        'http:register-route',
        initCtx,
        { method: 'GET', path: '/health', handler: healthHandler },
      );
      unregisters.push(healthResult.unregister);

      const chatResult = await bus.call<RegisterRouteInput, RegisterRouteOutput>(
        'http:register-route',
        initCtx,
        { method: 'POST', path: '/chat', handler: chatHandler },
      );
      unregisters.push(chatResult.unregister);
    },

    async shutdown() {
      while (unregisters.length > 0) {
        const fn = unregisters.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
    },
  };
}

async function handleChat(
  req: RouteRequest,
  res: RouteResponse,
  bus: HookBus,
  serveToken: string | undefined,
): Promise<void> {
  // Auth: when serveToken is set, /chat requires Bearer <token>.
  // timingSafeEqual prevents byte-by-byte timing leaks in the comparison;
  // the byte-length pre-check is required (timingSafeEqual throws on
  // unequal-length inputs) AND is itself a leak channel, but only on
  // total-length — not on token contents. The token never appears in any
  // error response regardless of whether the compare passes.
  if (serveToken !== undefined && serveToken !== '') {
    const auth = req.headers['authorization'] ?? '';
    const expected = `Bearer ${serveToken}`;
    const authBuf = Buffer.from(auth, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (
      authBuf.length !== expectedBuf.length ||
      !timingSafeEqual(authBuf, expectedBuf)
    ) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'invalid or missing bearer token' },
      });
      return;
    }
  }

  // Content-type
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    res.status(415).json({
      error: { code: 'VALIDATION', message: 'content-type must be application/json' },
    });
    return;
  }

  // http-server already capped body at MAX_BODY_BYTES (1 MiB) and returned
  // 413 before we got here. We still defensively check the buffer size in
  // case the cap shifts; matches the original serve.ts contract.
  if (req.body.length > MAX_BODY_BYTES) {
    res.status(413).json({
      error: { code: 'VALIDATION', message: 'body too large' },
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: `invalid json: ${e instanceof Error ? e.message : String(e)}`,
      },
    });
    return;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    res.status(400).json({
      error: { code: 'VALIDATION', message: 'body must be a JSON object' },
    });
    return;
  }
  const message = (parsed as { message?: unknown }).message;
  if (typeof message !== 'string' || message.length === 0) {
    res.status(400).json({
      error: { code: 'VALIDATION', message: 'message must be a non-empty string' },
    });
    return;
  }
  const sessionIdRaw = (parsed as { sessionId?: unknown }).sessionId;
  if (
    sessionIdRaw !== undefined &&
    (typeof sessionIdRaw !== 'string' || sessionIdRaw.length === 0)
  ) {
    res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: 'sessionId must be a non-empty string when provided',
      },
    });
    return;
  }

  // Always mint a fresh session for each chat. Sharing sessionIds across
  // requests is a multi-tenant concern (Week 9.5) — for the canary scenario
  // we want each request to be independent unless the caller pins one.
  const finalSessionId =
    sessionIdRaw !== undefined ? (sessionIdRaw as string) : `serve-${randomUUID()}`;
  const workspaceRoot = '/'; // synthetic — not used for workspace ops in http backend

  try {
    await bus.call('session:create', makeServeCtx(finalSessionId, workspaceRoot), {
      sessionId: finalSessionId,
      workspaceRoot,
    });
  } catch (e) {
    if (e instanceof PluginError) {
      res.status(400).json({ error: { code: e.code, message: e.message } });
      return;
    }
    throw e;
  }

  const ctx = makeServeCtx(finalSessionId, workspaceRoot);
  const chatMessage: AgentMessage = { role: 'user', content: message };
  let outcome: AgentOutcome;
  try {
    outcome = await bus.call('agent:invoke', ctx, { message: chatMessage });
  } catch (e) {
    if (e instanceof PluginError) {
      res.status(500).json({ error: { code: e.code, message: e.message } });
      return;
    }
    res.status(500).json({
      error: {
        code: 'INTERNAL',
        message: e instanceof Error ? e.message : String(e),
      },
    });
    return;
  }

  res.status(200).json({ sessionId: finalSessionId, outcome });
}

function makeServeCtx(sessionId: string, workspaceRoot: string): AgentContext {
  return makeAgentContext({
    sessionId,
    agentId: 'serve',
    userId: 'serve',
    workspace: { rootPath: workspaceRoot },
  });
}
