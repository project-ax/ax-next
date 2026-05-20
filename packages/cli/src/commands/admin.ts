// ax-next admin <subcommand>
//
// Top-level dispatcher for one-shot admin tooling. Today's verbs:
//   - reset-bootstrap  operator escape hatch — mints a fresh bootstrap
//                      token and resets bootstrap_state to pending (Phase 5
//                      Task 5.1).
// Future verbs (e.g. agents create, teams add-member, reset-password)
// will land alongside; keeping the dispatcher tiny keeps the surface
// obvious.
//
// Note: the legacy `bootstrap` verb (POST /auth/dev-bootstrap) was removed
// in Phase 5 once the default presets switched to @ax/auth-better, which
// does not expose that endpoint. First-admin creation is now the
// @ax/onboarding wizard at /setup/*; `reset-bootstrap` covers
// operator-driven recovery.
import { runAdminResetBootstrapCommand } from './admin/reset-bootstrap.js';

export interface RunAdminOptions {
  /** argv slice starting at the subcommand verb, e.g. ['reset-bootstrap']. */
  argv: string[];
  /** Defaults to `process.env`. Tests pass an explicit map. */
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Test-only seam for `reset-bootstrap`. Postgres connection string used
   * in place of `DATABASE_URL`. Production reads only from env.
   */
  databaseOverride?: { connectionString: string };
}

const USAGE = `usage:
  ax-next admin reset-bootstrap [--force]   re-mint the bootstrap token (recovery)

Run \`ax-next admin reset-bootstrap --help\` for command-specific options.`;

export async function runAdminCommand(opts: RunAdminOptions): Promise<number> {
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
  const verb = opts.argv[0];
  if (verb === undefined || verb === '') {
    err(USAGE);
    return 2;
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
