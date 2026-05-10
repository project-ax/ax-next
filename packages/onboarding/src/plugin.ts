import {
  createLogger,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { runOnboardingMigration, type OnboardingDatabase } from './migrations.js';
import { createOnboardingStore, type OnboardingStore } from './store.js';
import {
  generateToken,
  hashToken,
  printTokenToStdout,
  writeTokenFile,
} from './token.js';
import { createRateLimiter } from './rate-limit.js';
import { createBootstrapSessionStore } from './sessions.js';
import { createOnboardingRouteHandlers, type RouteRequest, type RouteResponse } from './routes.js';
import type {
  BootstrapCompleteInput,
  BootstrapResetInput,
  BootstrapResetOutput,
  BootstrapStatusOutput,
  OnboardingConfig,
} from './types.js';

const PLUGIN_NAME = '@ax/onboarding';
const DEFAULT_TOKEN_FILE_PATH = '/var/run/ax/bootstrap-token';

interface AnyHttpReq {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  cookies: Record<string, string>;
  query: Record<string, string>;
  params: Record<string, string>;
  signedCookie(name: string): string | null;
}
interface AnyHttpRes {
  status(n: number): AnyHttpRes;
  header(name: string, value: string): AnyHttpRes;
  json(v: unknown): void;
  text(s: string): void;
  body(buf: Buffer, contentType?: string): void;
  end(): void;
  redirect(url: string, status?: number): void;
  setSignedCookie(name: string, value: string, opts?: unknown): void;
  clearCookie(name: string, opts?: unknown): void;
}

function asRouteReq(req: AnyHttpReq): RouteRequest {
  return req as RouteRequest;
}
function asRouteRes(res: AnyHttpRes): RouteResponse {
  return res as RouteResponse;
}

async function registerRoute(
  bus: HookBus,
  initCtx: AgentContext,
  input: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    handler: (req: AnyHttpReq, res: AnyHttpRes) => Promise<void>;
  },
): Promise<() => void> {
  const result = await bus.call<unknown, { unregister: () => void }>(
    'http:register-route',
    initCtx,
    input,
  );
  return result.unregister;
}

export function createOnboardingPlugin(config: OnboardingConfig): Plugin {
  let store: OnboardingStore | undefined;
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['bootstrap:status', 'bootstrap:complete', 'bootstrap:reset'],
      calls: [
        'database:get-instance',
        'http:register-route',
        'auth:create-bootstrap-user',
        'auth:complete-bootstrap-user',
        'auth:require-user',
        'db:transact',
        'credentials:set',
        'agents:create',
        'bootstrap:complete',
        'storage:set',
      ],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      const log = createLogger({ reqId: PLUGIN_NAME });

      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      const db = shared as Kysely<OnboardingDatabase>;
      await runOnboardingMigration(db);
      store = createOnboardingStore(db);
      const localStore = store;

      // bootstrap:initialize logic ----------------------------------------
      const existing = await localStore.read();
      if (existing?.status === 'completed') {
        log.info('bootstrap already completed; skipping');
      } else {
        const env = config.envOverride ?? process.env;
        const envToken = env['AX_BOOTSTRAP_TOKEN'];
        if (envToken !== undefined && envToken.length > 0) {
          const hash = await hashToken(envToken);
          await localStore.initializeWithHash(hash);
          // No print: the operator already knows the token (they set it).
        } else if (existing === null) {
          // First boot, no env override → generate fresh.
          const token = generateToken();
          const hash = await hashToken(token);
          await localStore.initializeWithHash(hash);

          let stdoutOk = true;
          let fileOk = true;

          const stdoutFn =
            config.stdoutWriter ??
            ((line: string) => {
              process.stdout.write(line + '\n');
            });
          try {
            printTokenToStdout(token, config.baseUrl, stdoutFn);
          } catch {
            stdoutOk = false;
          }

          const fileFn = config.tokenFileWriter ?? writeTokenFile;
          const filePath = config.tokenFilePath ?? DEFAULT_TOKEN_FILE_PATH;
          try {
            await fileFn(filePath, token);
          } catch {
            fileOk = false;
          }

          if (!stdoutOk && !fileOk) {
            throw new PluginError({
              code: 'bootstrap-token-unreachable',
              plugin: PLUGIN_NAME,
              message:
                'cannot expose bootstrap token: both stdout and token file write failed',
            });
          }
        }
        // else: existing row with status pending|claimed, no env override → leave alone.
      }

      // bootstrap:status service hook -------------------------------------
      bus.registerService<unknown, BootstrapStatusOutput>(
        'bootstrap:status',
        PLUGIN_NAME,
        async () => {
          const row = await localStore.read();
          if (row === null) return { status: 'uninitialized' };
          if (row.status === 'completed') {
            const out: BootstrapStatusOutput = { status: 'completed' };
            if (row.completed_at !== null) out.completedAt = row.completed_at;
            return out;
          }
          return { status: row.status };
        },
      );

      // bootstrap:complete service hook -----------------------------------
      bus.registerService<BootstrapCompleteInput, void>(
        'bootstrap:complete',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const opts: { tx?: import('kysely').Transaction<unknown> } = {};
          if (input.tx !== undefined) opts.tx = input.tx;
          await localStore.complete(opts);
        },
      );

      // bootstrap:reset service hook --------------------------------------
      // Operator-driven escape hatch from I6's one-way state machine. The
      // CLI (`ax admin reset-bootstrap`) calls this; the hook does not
      // print or write a token file — that's the caller's job, so a CLI
      // tool can decide where the token goes (stdout vs. file vs. neither).
      // `force=true` is required to overwrite a `completed` row.
      bus.registerService<BootstrapResetInput, BootstrapResetOutput>(
        'bootstrap:reset',
        PLUGIN_NAME,
        async (ctx, input) => {
          const token = generateToken();
          const hash = await hashToken(token);
          const result = await localStore.resetToPending(hash, {
            allowCompletedReset: input.force === true,
          });
          if (!result.ok) {
            return { ok: false, reason: result.reason };
          }
          // Best-effort fan-out so plugins owning bootstrap-installed state
          // (auth users/sessions, the default agent, the Anthropic API key,
          // …) can wipe their own rows. Subscribers that throw get logged
          // by HookBus.fire but do not fail the reset — operator already
          // paid the I6 escape-hatch (`--force`) and a half-cleaned state
          // is still recoverable by re-running reset-bootstrap.
          await bus.fire('bootstrap:reset-cleanup', ctx, {});
          return {
            ok: true,
            token,
            baseUrl: config.baseUrl,
            previousStatus: result.previousStatus,
          };
        },
      );

      // /setup/claim route -----------------------------------------------
      const rateLimit = createRateLimiter({
        tokensPerWindow: 5,
        windowMs: 60_000,
        matchPath: (path) => path === '/setup/claim',
      });
      const sessions = createBootstrapSessionStore();
      const handlers = createOnboardingRouteHandlers({
        store: localStore,
        sessions,
        rateLimit,
        bus,
        initCtx,
        ...(config.validationTimeoutMs !== undefined
          ? { validationTimeoutMs: config.validationTimeoutMs }
          : {}),
      });

      // GET /admin/bootstrap-status — public read-only status echo so
      // unauthenticated channel-web (and the relocated wizard) can decide
      // whether to redirect / → /setup or vice-versa. Never gated by I11:
      // every state including 'completed' is a legitimate answer.
      unregisterRoutes.push(
        await registerRoute(bus, initCtx, {
          method: 'GET',
          path: '/admin/bootstrap-status',
          handler: async (_req, res) => {
            const row = await localStore.read();
            const out: BootstrapStatusOutput =
              row === null
                ? { status: 'uninitialized' }
                : row.status === 'completed'
                  ? row.completed_at !== null
                    ? { status: 'completed', completedAt: row.completed_at }
                    : { status: 'completed' }
                  : { status: row.status };
            res.status(200).json(out);
          },
        }),
      );

      unregisterRoutes.push(
        await registerRoute(bus, initCtx, {
          method: 'POST',
          path: '/setup/claim',
          handler: async (req, res) =>
            handlers.claim(asRouteReq(req), asRouteRes(res)),
        }),
      );

      unregisterRoutes.push(
        await registerRoute(bus, initCtx, {
          method: 'POST',
          path: '/setup/admin',
          handler: async (req, res) =>
            handlers.admin(asRouteReq(req), asRouteRes(res)),
        }),
      );

      unregisterRoutes.push(
        await registerRoute(bus, initCtx, {
          method: 'POST',
          path: '/setup/model',
          handler: async (req, res) =>
            handlers.model(asRouteReq(req), asRouteRes(res)),
        }),
      );

      // SPA routes are NOT registered here. The wizard now lives inside
      // @ax/channel-web (single design language, single shadcn install —
      // see CLAUDE.md invariant #6) and is served by @ax/static-files'
      // SPA fallback at /setup. The wizard hits /admin/bootstrap-status
      // (above) to know whether to render or redirect, and the existing
      // /setup/{claim,admin,model} POSTs continue to handle the real
      // state transitions with I11 lockdown after completion.
    },

    async shutdown() {
      for (const unregister of unregisterRoutes) unregister();
      unregisterRoutes.length = 0;
      store = undefined;
    },
  };
}
