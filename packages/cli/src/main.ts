#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  HookBus,
  bootstrap,
  makeChatContext,
  registerChatLoop,
  type ChatOutcome,
  type Plugin,
} from '@ax/core';
import { llmMockPlugin } from '@ax/llm-mock';
import { llmAnthropicPlugin } from '@ax/llm-anthropic';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { auditLogPlugin } from '@ax/audit-log';
import { sandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { toolDispatcherPlugin } from '@ax/tool-dispatcher';
import { toolBashPlugin } from '@ax/tool-bash';
import { toolFileIoPlugin } from '@ax/tool-file-io';
import { loadAxConfig } from './config/load.js';

export interface MainOptions {
  databasePath: string;
  message: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function main(opts: MainOptions): Promise<number> {
  const out = opts.stdout ?? ((line) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line) => process.stderr.write(line + '\n'));

  const cfg = await loadAxConfig(process.cwd());

  const bus = new HookBus();
  registerChatLoop(bus);

  const plugins: Plugin[] = [
    createStorageSqlitePlugin({
      databasePath: cfg.storageSqlite?.databasePath ?? opts.databasePath,
    }),
    auditLogPlugin(),
    sandboxSubprocessPlugin(),
    toolDispatcherPlugin(),
    ...(cfg.tools.includes('bash') ? [toolBashPlugin()] : []),
    ...(cfg.tools.includes('file-io') ? [toolFileIoPlugin()] : []),
    cfg.llm === 'anthropic' ? llmAnthropicPlugin() : llmMockPlugin(),
  ];

  await bootstrap({
    bus,
    plugins,
    config:
      cfg.llm === 'anthropic' && cfg.anthropic
        ? { '@ax/llm-anthropic': cfg.anthropic }
        : {},
  });

  const ctx = makeChatContext({
    sessionId: 'cli-session',
    agentId: 'cli-agent',
    userId: 'cli-user',
  });

  const outcome: ChatOutcome = await bus.call('chat:run', ctx, {
    message: { role: 'user', content: opts.message },
  });

  if (outcome.kind === 'complete') {
    const last = outcome.messages[outcome.messages.length - 1];
    out(last?.content ?? '');
    return 0;
  }
  err(`chat terminated: ${outcome.reason}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databasePath = process.env.AX_DB ?? './ax-next-chat.sqlite';
  const message = process.argv.slice(2).join(' ') || 'hi';
  main({ databasePath, message })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    });
}
