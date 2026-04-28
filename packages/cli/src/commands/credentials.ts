// ax-next credentials set <ref>
//
// A stdin-only path for writing a secret. The secret value NEVER appears in
// argv — we read it from stdin so it doesn't leak to `ps` / `/proc/<pid>/cmdline`
// / shell history. We also don't echo it back on stdout or stderr; the only
// confirmation is the ref. Paranoid? Sure. Also correct.
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

const USAGE = `usage: ax-next credentials set <ref>
  <ref> must match [a-z0-9][a-z0-9_.-]{0,127}
  the secret is read from stdin (NOT argv) — pipe or paste then EOF

env:
  AX_CREDENTIALS_KEY  required, 32 bytes (64 hex chars or 44 base64 chars)`;

export async function runCredentialsCommand(opts: RunCredentialsOptions): Promise<number> {
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));

  const verb = opts.argv[0];
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
          ref,
          userId: CLI_USER_ID,
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
