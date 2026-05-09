// ax-next admin <subcommand>
//
// Top-level dispatcher for one-shot admin tooling. Today's verbs:
//   - bootstrap        first-admin creation against /auth/dev-bootstrap (Task 15).
//   - reset-bootstrap  operator escape hatch — mints a fresh bootstrap
//                      token and resets bootstrap_state to pending (Phase 5
//                      Task 5.1).
// Future verbs (e.g. agents create, teams add-member, reset-password)
// will land alongside; keeping the dispatcher tiny keeps the surface
// obvious.
import { runAdminBootstrapCommand } from './admin/bootstrap.js';
import { runAdminResetBootstrapCommand } from './admin/reset-bootstrap.js';

export interface RunAdminOptions {
  /** argv slice starting at the subcommand verb, e.g. ['bootstrap']. */
  argv: string[];
  /** Defaults to `process.env`. Tests pass an explicit map. */
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Test-only seam. When set, replaces the global `fetch` for HTTP calls.
   * Production callers use the runtime's built-in fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test-only seam for `reset-bootstrap`. Postgres connection string used
   * in place of `DATABASE_URL`. Production reads only from env.
   */
  databaseOverride?: { connectionString: string };
}

const USAGE = `usage:
  ax-next admin bootstrap [options]         create the first admin user (idempotent)
  ax-next admin reset-bootstrap [--force]   re-mint the bootstrap token and reset state

Run \`ax-next admin <verb> --help\` for command-specific options.`;

export async function runAdminCommand(opts: RunAdminOptions): Promise<number> {
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const verb = opts.argv[0];
  if (verb === undefined || verb === '') {
    err(USAGE);
    return 2;
  }
  if (verb === 'bootstrap') {
    const subOpts: Parameters<typeof runAdminBootstrapCommand>[0] = {
      argv: opts.argv.slice(1),
    };
    if (opts.env !== undefined) subOpts.env = opts.env;
    if (opts.stdout !== undefined) subOpts.stdout = opts.stdout;
    if (opts.stderr !== undefined) subOpts.stderr = opts.stderr;
    if (opts.fetchImpl !== undefined) subOpts.fetchImpl = opts.fetchImpl;
    return runAdminBootstrapCommand(subOpts);
  }
  if (verb === 'reset-bootstrap') {
    const subOpts: Parameters<typeof runAdminResetBootstrapCommand>[0] = {
      argv: opts.argv.slice(1),
    };
    if (opts.env !== undefined) subOpts.env = opts.env;
    if (opts.stdout !== undefined) subOpts.stdout = opts.stdout;
    if (opts.stderr !== undefined) subOpts.stderr = opts.stderr;
    if (opts.databaseOverride !== undefined) subOpts.databaseOverride = opts.databaseOverride;
    return runAdminResetBootstrapCommand(subOpts);
  }
  err(`admin: unknown subcommand '${verb}'`);
  err(USAGE);
  return 2;
}
