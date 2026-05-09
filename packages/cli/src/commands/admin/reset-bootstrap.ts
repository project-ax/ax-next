// ax-next admin reset-bootstrap [--force]
//
// Operator-driven recovery tool. Mints a fresh bootstrap token, hashes it,
// and resets `bootstrap_state` to `pending`. The default refuses to act on
// a `completed` row — `--force` is the explicit override required to
// re-open a finished setup. That gate is what makes this safe to expose:
// a typo can't accidentally undo a real bootstrap.
//
// Architecturally this CLI is the kernel host (same pattern as
// `credentials.ts`): it bootstraps a minimal kernel with @ax/database-postgres
// + @ax/onboarding, calls the `bootstrap:reset` service hook, and shuts down.
// All onboarding state shape lives inside @ax/onboarding (Invariant I4 —
// one source of truth per concept). The CLI only knows that the hook
// returns a `{ token, baseUrl }` envelope on success.
//
// Output discipline:
//   STDOUT carries the token banner — same format @ax/onboarding prints at
//   first boot — so an operator running `ax admin reset-bootstrap` sees the
//   familiar shape. The token IS sensitive (anyone with it can claim admin)
//   but the operator who just ran the command needs to read it; STDERR is
//   reserved for diagnostics so `2>/dev/null 1>token.txt` keeps everything
//   tidy.
//
// Wire surface:
//   No HTTP. The CLI talks directly to the database via @ax/database-postgres.
//   The onboarding plugin's HTTP routes (which would normally need an
//   http-server) are stubbed out via in-process service registration so
//   verifyCalls passes without standing up a real listener.

import {
  HookBus,
  bootstrap,
  makeAgentContext,
  PluginError,
} from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createAuthBetterPlugin } from '@ax/auth-better';
import { createAgentsPlugin } from '@ax/agents';
import {
  createOnboardingPlugin,
  printTokenToStdout,
  type BootstrapResetOutput,
} from '@ax/onboarding';

const PLUGIN_NAME = '@ax/cli';

const DEFAULT_BASE_URL = 'http://localhost:8080';

const USAGE = `usage: ax-next admin reset-bootstrap [--force]

  --force       allow reset even if bootstrap is already completed.
                Without this, the command refuses on a completed install
                so a typo can't re-open a finished setup.

env:
  DATABASE_URL          required. Postgres connection string.
                        Format: postgres://user:pass@host:port/db
  AX_PUBLIC_BASE_URL    base URL printed in the banner (default: ${DEFAULT_BASE_URL})

The command mints a fresh bootstrap token, stores its hash in
bootstrap_state with status='pending', and prints the token + claim URL
on STDOUT. Re-running on a non-completed install (pending/claimed) is
allowed without --force; that's the recovery path for "I lost the token".

Re-running on a completed install requires --force — that's the
deliberate I6 escape hatch for "I need to redo this from scratch".`;

interface ParsedArgs {
  force: boolean;
}

interface ParseError {
  error: string;
}

function parseArgs(argv: string[]): ParsedArgs | ParseError {
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      return { error: 'help' };
    }
    if (a === '--force') {
      force = true;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  return { force };
}

export interface RunAdminResetBootstrapOptions {
  /** argv slice starting AFTER the `reset-bootstrap` verb. */
  argv: string[];
  /** Defaults to `process.env`. Tests pass an explicit map. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.stdout — receives the token banner on success. */
  stdout?: (line: string) => void;
  /** Defaults to process.stderr — diagnostics + errors. */
  stderr?: (line: string) => void;
  /**
   * Test-only override. When set, takes precedence over `DATABASE_URL`.
   * Production code only reads from env.
   */
  databaseOverride?: { connectionString: string };
}

export async function runAdminResetBootstrapCommand(
  opts: RunAdminResetBootstrapOptions,
): Promise<number> {
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const env = opts.env ?? process.env;

  const parsed = parseArgs(opts.argv);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      out(USAGE);
      return 0;
    }
    err(`admin reset-bootstrap: ${parsed.error}`);
    err(USAGE);
    return 2;
  }

  const connectionString =
    opts.databaseOverride?.connectionString ?? env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    err('admin reset-bootstrap: DATABASE_URL is unset. Set it to your postgres connection string and try again.');
    return 2;
  }

  const baseUrl = env.AX_PUBLIC_BASE_URL ?? DEFAULT_BASE_URL;

  const bus = new HookBus();

  // http:register-route must not throw — auth-better, agents, and
  // onboarding all unconditionally register routes. Stub it so they
  // can boot without standing up an http-server (the CLI never receives
  // an HTTP request anyway).
  bus.registerService(
    'http:register-route',
    'admin-reset-bootstrap-stub',
    async () => ({ unregister: () => {} }),
  );

  let handle;
  try {
    handle = await bootstrap({
      bus,
      // The full plugin set is loaded so each subscriber to
      // `bootstrap:reset-cleanup` is present on this bus when the hook
      // fires. Without auth-better/agents/credentials-store-db here, the
      // cascade would no-op (it fires, but nothing's listening) and the
      // operator would still see "admin already exists; bootstrap
      // refused" on the next wizard run — exactly the bug this CLI
      // exists to recover from.
      //
      // Order is implementation-irrelevant (kernel topo-sorts on
      // declared calls/registers) but follows the host pod's order for
      // readability.
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createStoragePostgresPlugin(),
        createCredentialsPlugin(),
        createCredentialsStoreDbPlugin(),
        createAuthBetterPlugin(),
        createAgentsPlugin(),
        // Silent writers: onboarding's first-boot init prints a token +
        // writes a token file when the row is missing. We're about to
        // OVERWRITE that token via bootstrap:reset, so suppress the
        // init-time noise. The reset-hook's caller (this CLI) prints
        // the real token below.
        createOnboardingPlugin({
          baseUrl,
          stdoutWriter: () => {},
          tokenFileWriter: async () => {},
        }),
      ],
      config: {},
    });
  } catch (e) {
    if (e instanceof PluginError) {
      err(`admin reset-bootstrap: ${e.message}`);
      return 1;
    }
    err(`admin reset-bootstrap: unexpected init failure: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    let result: BootstrapResetOutput;
    try {
      result = await bus.call<{ force?: boolean }, BootstrapResetOutput>(
        'bootstrap:reset',
        makeAgentContext({ sessionId: 'cli', agentId: PLUGIN_NAME, userId: 'system' }),
        parsed.force ? { force: true } : {},
      );
    } catch (e) {
      err(`admin reset-bootstrap: hook call failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }

    if (!result.ok) {
      // Only one rejection reason today; the if-tree future-proofs against
      // additional gates (e.g., a future "reset-locked-by-admin-policy").
      if (result.reason === 'completed-without-force') {
        err('error: bootstrap already completed; use --force to reset anyway');
        return 1;
      }
      // exhaustiveness fallback (TS narrows `result.reason` to never here)
      err(`error: reset refused: ${(result as { reason: string }).reason}`);
      return 1;
    }

    printTokenToStdout(result.token, result.baseUrl, out);
    return 0;
  } finally {
    await handle.shutdown();
  }
}
