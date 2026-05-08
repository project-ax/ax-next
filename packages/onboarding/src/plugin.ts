import {
  makeAgentContext,
  PluginError,
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
import type { BootstrapStatusOutput, OnboardingConfig } from './types.js';

const PLUGIN_NAME = '@ax/onboarding';
const DEFAULT_TOKEN_FILE_PATH = '/var/run/ax/bootstrap-token';

export function createOnboardingPlugin(config: OnboardingConfig): Plugin {
  let store: OnboardingStore | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['bootstrap:status'],
      calls: ['database:get-instance'],
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
    },

    async shutdown() {
      store = undefined;
    },
  };
}
