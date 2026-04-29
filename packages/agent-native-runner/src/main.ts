#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  createDiffAccumulator,
  createIpcClient,
  createInboxLoop,
  createLocalDispatcher,
} from '@ax/agent-runner-core';
import type {
  AgentMessage,
  SessionGetConfigResponse,
  ToolListResponse,
} from '@ax/ipc-protocol';
import { registerWithDispatcher as registerBash } from '@ax/tool-bash-impl';
import { registerWithDispatcher as registerFileIo } from '@ax/tool-file-io-impl';
import { readRunnerEnv } from './env.js';
import { runTurnLoop, type TurnLoopOutcome } from './turn-loop.js';

// ---------------------------------------------------------------------------
// Runner entry binary.
//
// Spawned as a child process by a `sandbox:open-session` impl inside an
// isolated sandbox. Communicates back to the host over the URI in
// AX_RUNNER_ENDPOINT (unix:// today, http:// once Task 14 lands), authed
// with AX_AUTH_TOKEN.
//
// The runner holds NO LLM credentials (invariant I5). Every LLM call goes
// via `llm.call` IPC back to the host. That way an attacker who compromises
// the sandbox still can't exfiltrate ANTHROPIC_API_KEY / etc — the key
// never entered this process.
//
// Exit codes (mapped from the runner's `TurnLoopOutcome.kind`):
//   0 — turn loop completed normally (TurnLoopOutcome.kind === 'complete',
//       reached either via an inbox `cancel` entry or the model ending the
//       conversation with no tool calls).
//   1 — turn loop terminated (TurnLoopOutcome.kind === 'terminated' —
//       session-invalid, host-unavailable-after-retries, inbox-loop error).
//   2 — fatal during bootstrap (missing env, initial tool.list failure).
//       These are errors that escape main() before the turn loop starts,
//       so there is no TurnLoopOutcome to report.
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
  const env = readRunnerEnv();
  const client = createIpcClient({
    runnerEndpoint: env.runnerEndpoint,
    token: env.authToken,
  });

  const dispatcher = createLocalDispatcher();
  // Per-turn diff accumulator. The file-io tool registers an observer that
  // pushes every successful write/delete in here; the turn loop drains it
  // at turn boundary into one `workspace.commit-notify` request (Task 7c).
  const diffs = createDiffAccumulator();
  registerBash(dispatcher, { workspaceRoot: env.workspaceRoot });
  registerFileIo(dispatcher, {
    workspaceRoot: env.workspaceRoot,
    onFileChange: (change) => diffs.record(change),
  });

  // Week 9.5: fetch the frozen agent config the orchestrator wrote when it
  // resolved this session's agent. The config is session-lifetime-frozen
  // (Invariant I10). We use systemPrompt to seed the initial chat history;
  // we use allowedTools to filter the tool catalog defensively (the
  // host's tool-dispatcher will filter per Task 7, but a defense-in-depth
  // filter here keeps the runner honest).
  const cfg = (await client.call(
    'session.get-config',
    {},
  )) as SessionGetConfigResponse;
  const agentConfig = cfg.agentConfig;

  // Fetch the tool catalog once. Tools are session-lifetime-immutable; a
  // plugin added mid-session wouldn't reach this runner anyway (the host
  // would have to reload and respawn).
  let { tools } = (await client.call('tool.list', {})) as ToolListResponse;

  // Defensive client-side filter against agentConfig.allowedTools when it
  // is non-empty. Empty list = "no per-agent restriction"; non-empty list
  // overrides what the host returned. Belt-and-suspenders against the
  // dispatcher filter (Task 7) — if either side regresses, the catalog
  // the LLM sees stays bounded.
  if (agentConfig.allowedTools.length > 0) {
    const allow = new Set(agentConfig.allowedTools);
    tools = tools.filter((t) => allow.has(t.name));
  }

  const inbox = createInboxLoop({ client });

  const outcome = await runTurnLoop({
    client,
    inbox,
    dispatcher,
    tools,
    diffs,
    systemPrompt: agentConfig.systemPrompt,
  });

  // Emit the final chat-end event. We AWAIT this one (unlike the mid-loop
  // turn-end / tool-post-call events) because it's the signal the host
  // waits for before tearing the session down. If we fire-and-forget, the
  // process may exit before the event hits the wire.
  //
  // The wire AgentOutcome (see @ax/ipc-protocol/events.ts) differs from
  // our internal TurnLoopOutcome: the terminated variant carries no
  // `messages` field on the wire. Translate here.
  await client
    .event('event.chat-end', { outcome: toWireOutcome(outcome) })
    .catch(() => {
      /* the host may already be gone; nothing we can do */
    });
  await client.close();

  return outcome.kind === 'complete' ? 0 : 1;
}

function toWireOutcome(
  outcome: TurnLoopOutcome,
):
  | { kind: 'complete'; messages: AgentMessage[] }
  | { kind: 'terminated'; reason: string; error?: unknown } {
  if (outcome.kind === 'complete') {
    return { kind: 'complete', messages: outcome.messages };
  }
  // Intentionally drop `messages` on terminated — the wire schema doesn't
  // carry it, and adding it would fail server-side Zod validation.
  return { kind: 'terminated', reason: outcome.reason, error: outcome.error };
}

// ESM main-module guard. `require.main === module` doesn't work in ESM.
// Compare URLs to detect "was this file invoked directly".
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `runner: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    });
}
