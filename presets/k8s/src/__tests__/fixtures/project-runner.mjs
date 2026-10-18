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
//      prompt augments (normal and bootstrap) are what the host built for this
//      session;
//   3. reads AX_SHARED_FOLDERS (host-stamped `[{ id, path, readOnly }]`) and,
//      in the first folder, writes or reads the planned relative path;
//   4. ends the turn with `event.chat-end { kind: 'complete' }` whose one
//      assistant message is a JSON summary of what it saw.
//
// Plan file: `{ [conversationId]: { op: 'write', path, content } | { op: 'read', path } | { op: 'none' } }`.
// The test writes it before each turn; a conversation with no entry is `none`.
//
// W3e — WARM mode. A plan entry with `warm: true` makes this runner behave like
// a real keep-alive runner instead of a one-shot: it pulls each user message
// from `session.next-message` (the first one included), runs the step, appends
// the summary as one JSON line to `<AX_TEST_RUNNER_REPORT_DIR>/<conversationId>.jsonl`,
// and ends the turn with `event.turn-end` (stamped with the message's reqId)
// while staying alive for the next message, until the host queues `cancel`
// (the idle / reap path) or kills it. A keep-alive turn resolves with no
// messages, which is why the summary goes to a file. The augment and mounts in
// the summary are the ones this session was SPAWNED with, so a later turn
// routed into the same session reports the same project as its first turn.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createIpcClient } from '@ax/ipc-protocol';

function need(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`project-runner: missing env ${name}`);
  return v;
}

/** One planned step against the first mounted folder. */
async function doStep(step, folder) {
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
  return { wrote, readContent, error };
}

async function runWarm({ client, sessionId, conversationId, augment, bootstrapAugment, sharedFolders, readStep }) {
  const reportDir = need('AX_TEST_RUNNER_REPORT_DIR');
  let cursor = 0;
  let turnIndex = 0;
  for (;;) {
    const resp = await client.callGet('session.next-message', { cursor: String(cursor) });
    if (resp.type === 'timeout') continue;
    cursor = resp.cursor;
    if (resp.type === 'cancel') return;
    if (resp.type !== 'user-message') continue;
    turnIndex += 1;
    const step = await readStep();
    const result = await doStep(step, sharedFolders?.[0]);
    const summary = {
      sessionId,
      conversationId,
      turnIndex,
      op: step.op,
      sharedFolders,
      ...result,
      augmentHasProjectBlock: augment.includes('## Project:'),
      augment,
      bootstrapAugment,
    };
    await fs.appendFile(path.join(reportDir, `${conversationId}.jsonl`), `${JSON.stringify(summary)}\n`);
    await client.event('event.turn-end', {
      reason: 'user-message-wait',
      role: 'assistant',
      ...(typeof resp.reqId === 'string' ? { reqId: resp.reqId } : {}),
    });
  }
}

async function run() {
  const sessionId = need('AX_SESSION_ID');
  const spawnDir = need('AX_TEST_RUNNER_SPAWN_DIR');
  await fs.writeFile(path.join(spawnDir, `${sessionId}.spawned`), '');

  const client = createIpcClient({ runnerEndpoint: need('AX_RUNNER_ENDPOINT'), token: need('AX_AUTH_TOKEN') });
  const config = await client.call('session.get-config', {});
  const conversationId = config.conversationId;
  const augment = config.agentConfig.systemPromptAugment;
  // W3b: what the runner would prepend in bootstrap mode (`rules` + `brief`
  // only). Reported so the test can prove agent-written folder text never
  // reaches it. Absent when the host set nothing.
  const bootstrapAugment = config.agentConfig.systemPromptBootstrapAugment ?? null;

  const readStep = async () => {
    const plan = JSON.parse(await fs.readFile(need('AX_TEST_PROJECT_PLAN'), 'utf-8'));
    return (conversationId !== null && plan[conversationId]) || { op: 'none' };
  };
  const step = await readStep();

  const rawFolders = process.env.AX_SHARED_FOLDERS;
  const sharedFolders = rawFolders === undefined ? null : JSON.parse(rawFolders);
  const folder = sharedFolders?.[0];

  if (step.warm === true) {
    await runWarm({ client, sessionId, conversationId, augment, bootstrapAugment, sharedFolders, readStep });
    return;
  }

  const { wrote, readContent, error } = await doStep(step, folder);

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
    bootstrapAugment,
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
