// ax-next mcp add | list | rm <id> | test <id>
//
// CLI provisioning for MCP server configs. Follows the same shape as
// `ax-next credentials set`: bootstrap a minimal plugin set (storage +
// credentials), call into @ax/mcp-client's config I/O helpers, exit with
// a status code. We don't pull the full chat/LLM/sandbox plugin set here
// — provisioning shouldn't need them and we don't want a config-write to
// race the chat path on DB init.
//
// Why credentials is in the bootstrap even for pure config operations:
// `mcp test <id>` opens a real connection, and `createTransport` resolves
// `credentialRefs` / `headerCredentialRefs` via the credentials:get hook.
// Easier to bootstrap it once for every subcommand than branch per-verb.
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  PluginError,
  type AgentContext,
} from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import {
  saveConfig,
  loadConfigs,
  deleteConfig,
  McpConnection,
} from '@ax/mcp-client';

const DEFAULT_SQLITE_PATH = './ax-next-chat.sqlite';

export interface RunMcpOptions {
  /** argv slice starting at the subcommand verb, e.g. ['add'] or ['rm', 'fs']. */
  argv: string[];
  /** For `add`, we read JSON config from this stream to EOF. Unused by other verbs. */
  stdin: NodeJS.ReadableStream | AsyncIterable<Buffer | string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Defaults to ./ax-next-chat.sqlite (same as main()). Tests override. */
  sqlitePath?: string;
}

const USAGE = `usage:
  ax-next mcp add               read JSON config from stdin, save it
  ax-next mcp list              list configured MCP servers
  ax-next mcp rm <id>           remove a configured server
  ax-next mcp test <id>         attempt a one-shot connection and list tools

env:
  AX_CREDENTIALS_KEY  required for 'test' (and harmless to set for other verbs)`;

async function readStdin(
  stream: RunMcpOptions['stdin'],
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function withBus<T>(
  opts: RunMcpOptions,
  fn: (bus: HookBus, ctx: AgentContext) => Promise<T>,
): Promise<T> {
  const bus = new HookBus();
  const handle = await bootstrap({
    bus,
    plugins: [
      createStorageSqlitePlugin({ databasePath: opts.sqlitePath ?? DEFAULT_SQLITE_PATH }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
    ],
    config: {},
  });
  const ctx = makeAgentContext({ sessionId: 'cli', agentId: 'cli', userId: 'cli' });
  try {
    return await fn(bus, ctx);
  } finally {
    // Reverse-topological shutdown so storage-sqlite WAL flushes before exit.
    // Each verb opens a fresh kernel via withBus, so each verb closes its own.
    await handle.shutdown();
  }
}

export async function runMcpCommand(opts: RunMcpOptions): Promise<number> {
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + '\n'));

  const verb = opts.argv[0];

  switch (verb) {
    case 'add': {
      const raw = await readStdin(opts.stdin);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // JSON.parse errors don't include the input string in their message,
        // just the position — safe to echo.
        err(`error: invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      try {
        const cfg = await withBus(opts, async (bus, ctx) => saveConfig(bus, ctx, parsed));
        out(`mcp server '${cfg.id}' added`);
        return 0;
      } catch (e) {
        if (e instanceof PluginError) {
          // PluginError messages from @ax/mcp-client are curated: the
          // inline-secret scan names the field path but never echoes the
          // value, and schema errors don't echo the input.
          err(`error: ${e.message}`);
          return 1;
        }
        // Unexpected failures are kept boring on purpose — don't risk
        // echoing something from `parsed` that shouldn't appear in stderr.
        err('error: unexpected failure');
        return 1;
      }
    }

    case 'list': {
      try {
        const configs = await withBus(opts, async (bus, ctx) => loadConfigs(bus, ctx));
        if (configs.length === 0) {
          out('(no MCP servers configured)');
          return 0;
        }
        for (const c of configs) {
          const target = c.transport === 'stdio' ? c.command : c.url;
          const status = c.enabled ? 'enabled' : 'disabled';
          out(`${c.id}\t${status}\t${c.transport}\t${target}`);
        }
        return 0;
      } catch (e) {
        if (e instanceof PluginError) {
          err(`error: ${e.message}`);
          return 1;
        }
        err('error: unexpected failure');
        return 1;
      }
    }

    case 'rm': {
      const id = opts.argv[1];
      if (id === undefined || id === '') {
        err(USAGE);
        return 2;
      }
      try {
        await withBus(opts, async (bus, ctx) => deleteConfig(bus, ctx, id));
        out(`mcp server '${id}' removed`);
        return 0;
      } catch (e) {
        if (e instanceof PluginError) {
          err(`error: ${e.message}`);
          return 1;
        }
        err('error: unexpected failure');
        return 1;
      }
    }

    case 'test': {
      const id = opts.argv[1];
      if (id === undefined || id === '') {
        err(USAGE);
        return 2;
      }
      try {
        return await withBus(opts, async (bus, ctx) => {
          const configs = await loadConfigs(bus, ctx);
          const config = configs.find((c) => c.id === id);
          if (config === undefined) {
            err(`error: mcp server '${id}' not found`);
            return 1;
          }
          const connection = new McpConnection({ config, bus, ctx });
          try {
            await connection.connect();
          } catch (e) {
            if (e instanceof PluginError) {
              err(`error: ${e.message}`);
            } else {
              err(`error: ${e instanceof Error ? e.message : 'connect failed'}`);
            }
            // connect() left us in 'unhealthy' — disconnect cleans up any
            // half-built transport and clears the reconnect timer so this
            // process can exit promptly.
            await connection.disconnect();
            return 1;
          }
          const listed = await connection.listTools();
          if (!listed.ok) {
            err(`error: ${listed.code}: ${listed.reason}`);
            await connection.disconnect();
            return 1;
          }
          out(`connected to '${id}' (${listed.tools.length} tool${listed.tools.length === 1 ? '' : 's'})`);
          for (const tool of listed.tools) {
            const desc = tool.description !== undefined && tool.description !== ''
              ? `  — ${tool.description}`
              : '';
            out(`  ${tool.name}${desc}`);
          }
          await connection.disconnect();
          return 0;
        });
      } catch (e) {
        if (e instanceof PluginError) {
          err(`error: ${e.message}`);
          return 1;
        }
        err(`error: ${e instanceof Error ? e.message : 'unexpected failure'}`);
        return 1;
      }
    }

    default: {
      err(USAGE);
      return 2;
    }
  }
}
