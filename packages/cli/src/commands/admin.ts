// ax-next admin <subcommand>
//
// Top-level dispatcher for one-shot admin tooling. Today the only verb is
// `bootstrap` (Task 15 — first-admin creation against /auth/dev-bootstrap).
// Future verbs (e.g. agents create, teams add-member) will land alongside
// it; keeping the dispatcher tiny keeps the surface obvious.
import { runAdminBootstrapCommand } from './admin/bootstrap.js';

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
}

const USAGE = `usage:
  ax-next admin bootstrap [options]   create the first admin user (idempotent)

Run \`ax-next admin bootstrap --help\` for command-specific options.`;

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
  err(`admin: unknown subcommand '${verb}'`);
  err(USAGE);
  return 2;
}
