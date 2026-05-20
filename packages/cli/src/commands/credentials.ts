// ax-next credentials set <ref>     — stdin-only secret writer (Phase 1b)
//
// `set`: reads the secret from stdin so it doesn't leak to `ps` /
// `/proc/<pid>/cmdline` / shell history. We also don't echo it back on
// stdout or stderr; the only confirmation is the ref. Paranoid? Sure.
// Also correct.
import { HookBus, bootstrap, makeAgentContext, PluginError } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';

const DEFAULT_SQLITE_PATH = './ax-next-chat.sqlite';
// Single-tenant CLI default. Phase 9.5+ multi-tenant replaces this with a
// real auth identity. The (userId, ref) storage key (Phase 3, I14) keeps
// the door open without forcing the change today.
const CLI_USER_ID = 'cli';

export interface RunCredentialsOptions {
  /** argv slice starting at the subcommand args, e.g. ['set', 'gh-token']. */
  argv: string[];
  /** The secret source. Reads all chunks to EOF, UTF-8 decodes, strips one trailing \n. */
  stdin: NodeJS.ReadableStream | AsyncIterable<Buffer | string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Defaults to ./ax-next-chat.sqlite (same as main()). Tests override. */
  sqlitePath?: string;
}

const USAGE = `usage:
  ax-next credentials set <ref>
    <ref> must match [a-z0-9][a-z0-9_.-]{0,127}
    the secret is read from stdin (NOT argv) — pipe or paste then EOF

  ax-next credentials migrate [--yes]
    Copies legacy v1 storage keys (credential:<userId>:<ref>) to v2 keys
    (credential:v2:user:<userId>:<ref>) so the new scope-aware admin UI
    can list them. v1 rows stay in place as a read-fallback. Run with
    --yes to actually mutate; bare invocation is a dry-run summary.

env:
  AX_CREDENTIALS_KEY  required, 32 bytes (64 hex chars or 44 base64 chars)`;

export async function runCredentialsCommand(opts: RunCredentialsOptions): Promise<number> {
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));

  const verb = opts.argv[0];
  if (verb === 'migrate') {
    return runMigrateCommand(opts, out, err);
  }
  if (verb !== 'set') {
    err(USAGE);
    return 2;
  }
  const ref = opts.argv[1];
  if (ref === undefined || ref === '') {
    err(USAGE);
    return 2;
  }

  // Read stdin to a Buffer (preserves bytes), then UTF-8 decode.
  const chunks: Buffer[] = [];
  for await (const chunk of opts.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  let value = Buffer.concat(chunks).toString('utf8');
  // Strip exactly one trailing \n — covers `echo $TOKEN | ax-next ...` and a
  // single hand-typed newline before EOF. Don't trim aggressively: the user
  // might genuinely want trailing whitespace inside their token.
  if (value.endsWith('\n')) value = value.slice(0, -1);

  const bus = new HookBus();
  let handle;
  try {
    handle = await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: opts.sqlitePath ?? DEFAULT_SQLITE_PATH }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
      ],
      config: {},
    });
  } catch (e) {
    // bootstrap errors (e.g. credentials plugin init when AX_CREDENTIALS_KEY
    // is missing) come through here. No handle yet — nothing to shut down.
    if (e instanceof PluginError) {
      err(`error: ${e.message}`);
      return 1;
    }
    err('error: unexpected failure');
    return 1;
  }

  try {
    try {
      await bus.call(
        'credentials:set',
        makeAgentContext({ sessionId: 'cli', agentId: 'cli', userId: CLI_USER_ID }),
        {
          scope: 'user',
          ownerId: CLI_USER_ID,
          ref,
          kind: 'api-key',
          payload: new TextEncoder().encode(value),
        },
      );
    } catch (e) {
      if (e instanceof PluginError) {
        // PluginError messages are curated by @ax/credentials specifically to
        // avoid echoing plaintext. Still — only surface `.message`, never `.cause`.
        err(`error: ${e.message}`);
        return 1;
      }
      // Unexpected failure. We don't stringify `e` because it might (somehow) have
      // captured the secret value in a message. Be boring on purpose.
      err('error: unexpected failure');
      return 1;
    }

    out(`credential '${ref}' stored`);
    return 0;
  } finally {
    await handle.shutdown();
  }
}

// ── credentials migrate ─────────────────────────────────────────────
//
// Copies v1 storage keys (`credential:<userId>:<ref>`) to v2 keys
// (`credential:v2:user:<userId>:<ref>`). The v1 rows stay in place — the
// store-blob layer reads v1 as a fallback when scope='user', so existing
// code paths keep working. The migration is needed because the new
// `credentials:list` hook only walks v2 keys (v1 had no concept of
// scope, so admin UI can't list them).
//
// Idempotent: skips keys that already match `credential:v2:`. Safe to
// re-run. Bare invocation is a dry-run; pass --yes to actually mutate.

async function runMigrateCommand(
  opts: RunCredentialsOptions,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const bus = new HookBus();
  let handle;
  try {
    handle = await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: opts.sqlitePath ?? DEFAULT_SQLITE_PATH }),
      ],
      config: {},
    });
  } catch (e) {
    if (e instanceof PluginError) {
      err(`error: ${e.message}`);
      return 1;
    }
    err('error: unexpected failure');
    return 1;
  }

  try {
    const ctx = makeAgentContext({ sessionId: 'cli', agentId: 'cli', userId: CLI_USER_ID });

    // Find every key under the `credential:` prefix, then filter out v2
    // (already migrated) and any other shape that doesn't look like
    // `credential:<userId>:<ref>`.
    const list = await bus.call<
      { prefix: string },
      { entries: Array<{ key: string; value: Uint8Array }> }
    >('storage:list-prefix', ctx, { prefix: 'credential:' });
    const v1Entries = list.entries.filter((e) => !e.key.startsWith('credential:v2:'));

    if (v1Entries.length === 0) {
      out('no v1 credentials found; nothing to migrate');
      return 0;
    }

    if (!opts.argv.includes('--yes')) {
      // Dry-run: informational, not an error. Exiting 0 lets shell
      // pipelines like `credentials migrate || abort` use this as a
      // preflight without false-positive failures. Reserve non-zero for
      // real errors (catch block below).
      out(`would migrate ${v1Entries.length} credentials. Re-run with --yes to proceed.`);
      return 0;
    }

    let migrated = 0;
    for (const e of v1Entries) {
      // Key shape: `credential:<userId>:<ref>` — split on the FIRST colon
      // after the prefix. Refs may contain `.` and `-` but never `:`, so
      // anything after the first colon is the ref.
      const rest = e.key.slice('credential:'.length);
      const colon = rest.indexOf(':');
      if (colon < 0) continue;
      const userId = rest.slice(0, colon);
      const ref = rest.slice(colon + 1);
      const newKey = `credential:v2:user:${userId}:${ref}`;
      await bus.call('storage:set', ctx, { key: newKey, value: e.value });
      migrated++;
    }

    out(`migrated ${migrated} credentials from v1 to v2 (scope=user)`);
    out(
      'v1 keys are still present and readable as a fallback. Remove them only after verifying.',
    );
    return 0;
  } catch (e) {
    if (e instanceof PluginError) {
      err(`error: ${e.message}`);
      return 1;
    }
    err('error: unexpected failure');
    return 1;
  } finally {
    await handle.shutdown();
  }
}
