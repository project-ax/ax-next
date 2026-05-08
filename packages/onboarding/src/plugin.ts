import {
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
import type { BootstrapCompleteInput, BootstrapStatusOutput, OnboardingConfig } from './types.js';

const PLUGIN_NAME = '@ax/onboarding';
const DEFAULT_TOKEN_FILE_PATH = '/var/run/ax/bootstrap-token';

interface AnyHttpReq {
  headers: Record<string, string>;
  body: Buffer;
  cookies: Record<string, string>;
  query: Record<string, string>;
  signedCookie(name: string): string | null;
}
interface AnyHttpRes {
  status(n: number): unknown;
  json(v: unknown): void;
  text(s: string): void;
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
      registers: ['bootstrap:status', 'bootstrap:complete'],
      calls: [
        'database:get-instance',
        'http:register-route',
        'auth:create-bootstrap-user',
        'auth:complete-bootstrap-user',
      ],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

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
        console.log('[ax-onboarding] bootstrap already completed; skipping');
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
      });

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
    },

    async shutdown() {
      for (const unregister of unregisterRoutes) unregister();
      unregisterRoutes.length = 0;
      store = undefined;
    },
  };
}
