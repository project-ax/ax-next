#!/usr/bin/env node
// ---------------------------------------------------------------------------
// W3a project acceptance runner (W3 spec §4.9).
//
// The test-harness stub runner speaks IPC but never touches files, and W2's
// sandbox-subprocess canary stub touches files but never speaks IPC. The W3a
// acceptance needs both in ONE turn driven through the orchestrator, so this
// runner:
//
//   1. records that it was spawned (a marker file in AX_TEST_RUNNER_SPAWN_DIR),
//      so the test can prove a refused turn never opened a sandbox;
//   2. calls `session.get-config` over IPC — the conversation id picks this
//      turn's instruction out of the plan file (AX_TEST_PROJECT_PLAN), and the
//      prompt augment is what the host built for this session;
//   3. reads AX_SHARED_FOLDERS (host-stamped `[{ id, path, readOnly }]`) and,
//      in the first folder, writes or reads the planned relative path;
//   4. ends the turn with `event.chat-end { kind: 'complete' }` whose one
//      assistant message is a JSON summary of what it saw.
//
// Plan file: `{ [conversationId]: { op: 'write', path, content } | { op: 'read', path } | { op: 'none' } }`.
// The test writes it before each turn; a conversation with no entry is `none`.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createIpcClient } from '@ax/ipc-protocol';

function need(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`project-runner: missing env ${name}`);
  return v;
}

async function run() {
  const sessionId = need('AX_SESSION_ID');
  const spawnDir = need('AX_TEST_RUNNER_SPAWN_DIR');
  await fs.writeFile(path.join(spawnDir, `${sessionId}.spawned`), '');

  const client = createIpcClient({ runnerEndpoint: need('AX_RUNNER_ENDPOINT'), token: need('AX_AUTH_TOKEN') });
  const config = await client.call('session.get-config', {});
  const conversationId = config.conversationId;
  const augment = config.agentConfig.systemPromptAugment;

  const plan = JSON.parse(await fs.readFile(need('AX_TEST_PROJECT_PLAN'), 'utf-8'));
  const step = (conversationId !== null && plan[conversationId]) || { op: 'none' };

  const rawFolders = process.env.AX_SHARED_FOLDERS;
  const sharedFolders = rawFolders === undefined ? null : JSON.parse(rawFolders);
  const folder = sharedFolders?.[0];

  let wrote = false;
  let readContent = null;
  let error = null;
  try {
    if (step.op === 'write') {
      if (folder === undefined) throw new Error('no shared folder to write to');
      const target = path.join(folder.path, step.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, step.content);
      wrote = true;
    } else if (step.op === 'read') {
      if (folder === undefined) throw new Error('no shared folder to read from');
      readContent = await fs.readFile(path.join(folder.path, step.path), 'utf-8');
    }
  } catch (err) {
    error = String(err);
  }

  const summary = {
    sessionId,
    conversationId,
    op: step.op,
    sharedFolders,
    wrote,
    readContent,
    error,
    augmentHasProjectBlock: augment.includes('## Project:'),
    augment,
  };
  await client.event('event.chat-end', {
    outcome: { kind: 'complete', messages: [{ role: 'assistant', content: JSON.stringify(summary) }] },
  });
  await client.close();
}

run().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`project-runner fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
