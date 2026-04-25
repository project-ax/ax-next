import { makeChatContext, PluginError, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { runAuthMigration, type AuthDatabase } from './migrations.js';
import type {
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  GetUserInput,
  GetUserOutput,
  RequireUserInput,
  RequireUserOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/auth';

/**
 * Task 3 scaffold: registers the hook surface as not-implemented stubs and
 * runs the schema migration. Task 4 lands the OIDC + dev-bootstrap flows
 * that fill the stubs in.
 *
 * Manifest declares `http:register-route` in `calls` so the kernel's
 * topological sort sees the dependency now — Task 4's routes will mount
 * without a manifest churn that would otherwise reorder boot.
 */
export function createAuthPlugin(): Plugin {
  let db: Kysely<AuthDatabase> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'auth:require-user',
        'auth:get-user',
        'auth:create-bootstrap-user',
      ],
      calls: ['database:get-instance', 'http:register-route'],
      // auth:user-signed-in / auth:user-signed-out are subscriber hooks
      // FIRED by Task 4's flow — other plugins subscribe to them. They are
      // not declared here because (a) we register no service for them and
      // (b) they aren't fired yet. No half-wired hooks (Invariant I3).
      subscribes: [],
    },
    async init({ bus }) {
      const initCtx = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      // Cast at the edge — the bus contract is `Kysely<unknown>`; we own
      // the `auth_v1_*` namespace via our migration.
      db = shared as Kysely<AuthDatabase>;
      await runAuthMigration(db);

      const notImplemented = (hook: string): PluginError =>
        new PluginError({
          code: 'not-implemented',
          plugin: PLUGIN_NAME,
          message: `${hook}: Task 4 implements this`,
        });

      bus.registerService<RequireUserInput, RequireUserOutput>(
        'auth:require-user',
        PLUGIN_NAME,
        async () => {
          throw notImplemented('auth:require-user');
        },
      );

      bus.registerService<GetUserInput, GetUserOutput>(
        'auth:get-user',
        PLUGIN_NAME,
        async () => {
          throw notImplemented('auth:get-user');
        },
      );

      bus.registerService<CreateBootstrapUserInput, CreateBootstrapUserOutput>(
        'auth:create-bootstrap-user',
        PLUGIN_NAME,
        async () => {
          throw notImplemented('auth:create-bootstrap-user');
        },
      );
    },
  };
}
