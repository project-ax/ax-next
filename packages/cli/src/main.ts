#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  HookBus,
  bootstrap,
  makeChatContext,
  registerChatLoop,
  type ChatOutcome,
} from '@ax/core';
import { llmMockPlugin } from '@ax/llm-mock';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { auditLogPlugin } from '@ax/audit-log';

export interface MainOptions {
  databasePath: string;
  message: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function main(opts: MainOptions): Promise<number> {
  const out = opts.stdout ?? ((line) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line) => process.stderr.write(line + '\n'));

  const bus = new HookBus();
  registerChatLoop(bus);

  await bootstrap({
    bus,
    plugins: [
      llmMockPlugin(),
      createStorageSqlitePlugin({ databasePath: opts.databasePath }),
      auditLogPlugin(),
    ],
    config: {},
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
