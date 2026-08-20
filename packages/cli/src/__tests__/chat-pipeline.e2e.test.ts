import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import {
  createTestHostToolPlugin,
  createTestProxyPlugin,
  stubRunnerPath,
  type StubRunnerScript,
} from '@ax/test-harness';
import { main, resolveRunnerBinaries } from '../main.js';
import type { AgentContext, Plugin, ToolCall } from '@ax/core';

// ---------------------------------------------------------------------------
// Phase 6.6 Task 7 — chat-pipeline e2e (I_R2).
//
// Library-mode acceptance test that drives the full chat pipeline (sandbox
// spawn → IPC routing → host MCP service hook → pre/post tool subscribers)
// using the stub runner from @ax/test-harness in place of the real
// @ax/agent-claude-sdk-runner. No real Anthropic credentials required.
//
// Replaces the parked claude-sdk-runner.e2e.test.ts placeholder. The stub
// runner is platform-neutral (pure Node IPC client), so unlike the parked
// test there is NO darwin gate.
// ---------------------------------------------------------------------------

interface PreCallRecord {
  kind: 'pre';
  name: string;
  toolCallId: string;
}

interface PostCallRecord {
  kind: 'post';
  name: string;
  toolCallId: string;
}

type Record_ = PreCallRecord | PostCallRecord;

/**
 * The slice of the `sandbox:open-session` input this test asserts on. The
 * authoritative shape lives in @ax/sandbox-protocol / @ax/chat-orchestrator;
 * declaring a local structural view keeps invariant 2 (no cross-plugin
 * imports) intact and keeps the test honest about what it reads.
 */
interface ObservedOpenSession {
  runnerBinary: string;
  owner: { agentConfig: { runner: string; model: string } };
}

// ---------------------------------------------------------------------------
// PR 3 Task 10 — the canary runs once per runner id.
//
// Both iterations drive the REAL host path (dev agents-stub → chat-orchestrator
// → sandbox-subprocess), and the only thing that differs is the runner id the
// dev agents-stub reports: that id flows through agents:resolve → AgentRecord →
// the frozen agentConfig, and the orchestrator uses it to look up a binary in
// ChatOrchestratorConfig.runnerBinaries. Under 'aisdk' the run goes red unless
// `resolveRunnerBinaries` actually has an 'aisdk' key (verified by deleting the
// key and watching only the aisdk iteration fail).
//
// What this proves and what it does NOT: the binary spawned in BOTH iterations
// is the stub runner from @ax/test-harness, because runnerBinaryOverride
// replaces every entry in the map. So this is a check of the host-side
// runner-id → binary → AgentConfig selection path, end to end, for both ids —
// NOT of the two runners behaving alike. Runner-side parity lives in each
// runner package's own tests (packages/agent-aisdk-runner/src/__tests__/).
// ---------------------------------------------------------------------------
describe.each(['claude-sdk', 'aisdk'] as const)(
  '@ax/cli chat pipeline e2e (stub runner, runner=%s)',
  (runnerId) => {
    let tmp: string;
    let originalCredKey: string | undefined;

    beforeEach(async () => {
      tmp = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'ax-chat-pipeline-')),
      );
      originalCredKey = process.env.AX_CREDENTIALS_KEY;
      // @ax/credentials init() requires this even when skipCredentialProxy is
      // true, because the credentials facade is loaded unconditionally.
      process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
    });

    afterEach(async () => {
      if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
      else process.env.AX_CREDENTIALS_KEY = originalCredKey;
      if (tmp) await fs.rm(tmp, { recursive: true, force: true });
    });

    it(
      'fires tool:pre-call and tool:post-call in order for built-in and host-mediated tools',
      { timeout: 20_000 },
      async () => {
        const script: StubRunnerScript = {
          entries: [
            {
              kind: 'tool-call',
              name: 'Bash',
              input: { command: 'echo hi' },
              executesIn: 'sandbox',
              expectPostCall: true,
            },
            {
              kind: 'tool-call',
              name: 'test-host-echo',
              input: { text: 'world' },
              executesIn: 'host',
              expectPostCall: true,
            },
            { kind: 'assistant-text', content: 'ok' },
            { kind: 'finish', reason: 'end_turn' },
          ],
        };

        const records: Record_[] = [];
        const recorderPlugin: Plugin = {
          manifest: {
            name: '@ax/test-chat-pipeline-recorder',
            version: '0.0.0',
            registers: [],
            calls: [],
            subscribes: ['tool:pre-call', 'tool:post-call'],
          },
          init({ bus }) {
            // tool:pre-call fires with the bare ToolCall envelope as the bus
            // payload (see ipc-core/handlers/tool-pre-call.ts: it strips the
            // wire `{ call }` wrapper before bus.fire). tool:post-call, by
            // contrast, fires with `{ toolCall, output }` (see
            // ipc-core/handlers/event-tool-post-call.ts) — the IPC wire field
            // `call` gets renamed to `toolCall` to match chat-loop's existing
            // payload shape. Different shapes per hook is intentional.
            bus.subscribe<ToolCall>(
              'tool:pre-call',
              '@ax/test-chat-pipeline-recorder',
              async (_ctx, call) => {
                records.push({
                  kind: 'pre',
                  name: call.name,
                  toolCallId: call.id,
                });
                // Pass-through verdict — explicit undefined keeps us out of the
                // verdict path. Returning false/null would reject the tool call.
                return undefined;
              },
            );
            bus.subscribe<{ toolCall: ToolCall; output: unknown }>(
              'tool:post-call',
              '@ax/test-chat-pipeline-recorder',
              async (_ctx, payload) => {
                records.push({
                  kind: 'post',
                  name: payload.toolCall.name,
                  toolCallId: payload.toolCall.id,
                });
                return undefined;
              },
            );
          },
        };

        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];

        const rc = await main({
          message: 'go',
          configOverride: { sandbox: 'subprocess', storage: 'sqlite' },
          workspaceRoot: tmp,
          sqlitePath: path.join(tmp, 'chat-pipeline.sqlite'),
          stdout: (line) => stdoutLines.push(line),
          stderr: (line) => stderrLines.push(line),
          runnerBinaryOverride: stubRunnerPath,
          devAgentRunner: runnerId,
          skipCredentialProxy: true,
          extraPlugins: [
            createTestProxyPlugin({ script }),
            createTestHostToolPlugin(),
            recorderPlugin,
          ],
        });

        // Surface stderr context if the chat path failed — diagnostics that
        // would be otherwise hidden by an unhelpful "rc !== 0" assertion.
        if (rc !== 0) {
          throw new Error(
            `main exited ${rc}; stderr:\n${stderrLines.join('\n')}`,
          );
        }
        expect(rc).toBe(0);
        expect(stdoutLines.join('\n')).toContain('ok');

        // Per stub-runner.ts, each script entry runs to completion (pre →
        // optional host execute → post) before the next entry starts. So the
        // pre/post observer sees pairs interleaved per tool, not a "all pres
        // then all posts" sequence:
        //   pre[Bash], post[Bash], pre[test-host-echo], post[test-host-echo]
        const order = records.map((r) => `${r.kind}[${r.name}]`);
        expect(order).toEqual([
          'pre[Bash]',
          'post[Bash]',
          'pre[test-host-echo]',
          'post[test-host-echo]',
        ]);

        // ID-pairing check: pre/post for the same tool share an ID, and the
        // IDs across tools are distinct. Without this, a regression where
        // pre/post fire for mismatched toolCallIds would still pass the
        // (kind, name) order assertion above.
        expect(records[0]!.toolCallId).toBe(records[1]!.toolCallId); // Bash pre = Bash post
        expect(records[2]!.toolCallId).toBe(records[3]!.toolCallId); // test-host-echo pre = test-host-echo post
        expect(records[0]!.toolCallId).not.toBe(records[2]!.toolCallId); // different tools have different IDs
      },
    );

    // -------------------------------------------------------------------------
    // PR 2 Task 9 — invariant 3 (no half-wired plugins): per-agent runner +
    // model selection must be reachable end-to-end, not just unit-tested per
    // hop. This drives the SAME real plugin set as the test above (dev
    // agents-stub → chat-orchestrator → sandbox-subprocess → stub runner) and
    // asserts the three values that PR 2 introduced, all in one run:
    //
    //   1. runnerBinary is the entry of the map main() built that matches THIS
    //      iteration's runner id (chat-orchestrator resolves agent.runner →
    //      ChatOrchestratorConfig.runnerBinaries at the wire boundary),
    //   2. agentConfig.runner survived agents:resolve → AgentRecord → the
    //      frozen agentConfig (a zod strip anywhere on that path drops it
    //      silently — that's what this witnesses),
    //   3. agentConfig.model is the dev stub's prefixed `provider/model-id`
    //      ref, so the runner receives a ref it can parse rather than a bare id.
    //
    // Observation mechanism: `sandbox:open-session` is a SERVICE hook, so it is
    // single-registrant (HookBus.registerService throws `duplicate-service`) —
    // an observer plugin cannot register a second handler alongside the real
    // @ax/sandbox-subprocess one, and replacing it would stop the run being
    // end-to-end. Instead we wrap `bus.call` and delegate to the original, the
    // same technique packages/conversations/src/__tests__/subscribe.test.ts:98
    // uses to witness which service hooks a code path consulted. The wrap
    // happens in an extraPlugin's init, which runs long before agent:invoke
    // fires the call.
    // -------------------------------------------------------------------------
    it(
      "resolves the agent's runner + model end-to-end onto sandbox:open-session",
      { timeout: 20_000 },
      async () => {
        const script: StubRunnerScript = {
          entries: [
            { kind: 'assistant-text', content: 'ok' },
            { kind: 'finish', reason: 'end_turn' },
          ],
        };

        // The exact map main() hands the chat-orchestrator for this run:
        // resolveRunnerBinaries is the production builder, and we feed it the
        // same override the main() call below passes. Asserting against
        // `expectedBinaries[runnerId]` (not `stubRunnerPath` directly, and not
        // "some non-empty path") is what makes this a check of the runner-id →
        // binary lookup rather than a check that a binary was spawned at all —
        // and it is why a missing 'aisdk' key fails here with an undefined
        // expectation instead of quietly passing.
        const expectedBinaries = resolveRunnerBinaries({
          runnerBinaryOverride: stubRunnerPath,
        });

        let observed: ObservedOpenSession | undefined;
        const openSessionObserver: Plugin = {
          manifest: {
            name: '@ax/test-chat-pipeline-open-session-observer',
            version: '0.0.0',
            registers: [],
            calls: [],
            subscribes: [],
          },
          init({ bus }) {
            const originalCall = bus.call.bind(bus);
            bus.call = (async <I, O>(
              hookName: string,
              callCtx: AgentContext,
              input: I,
            ): Promise<O> => {
              if (hookName === 'sandbox:open-session') {
                observed = input as ObservedOpenSession;
              }
              return originalCall<I, O>(hookName, callCtx, input);
            }) as typeof bus.call;
          },
        };

        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];

        const rc = await main({
          message: 'go',
          configOverride: { sandbox: 'subprocess', storage: 'sqlite' },
          workspaceRoot: tmp,
          sqlitePath: path.join(tmp, 'runner-model.sqlite'),
          stdout: (line) => stdoutLines.push(line),
          stderr: (line) => stderrLines.push(line),
          runnerBinaryOverride: stubRunnerPath,
          devAgentRunner: runnerId,
          skipCredentialProxy: true,
          extraPlugins: [createTestProxyPlugin({ script }), openSessionObserver],
        });

        if (rc !== 0) {
          throw new Error(
            `main exited ${rc}; stderr:\n${stderrLines.join('\n')}`,
          );
        }
        expect(rc).toBe(0);
        expect(stdoutLines.join('\n')).toContain('ok');

        // Fail loudly rather than skipping the three assertions below if the
        // hook was never called — a `if (observed) { ... }` guard here would be
        // an always-green test.
        if (observed === undefined) {
          throw new Error('sandbox:open-session was never called');
        }

        // 1. The map lookup, not merely "a path". `expectedBinaries[runnerId]`
        //    must exist — an id the CLI's map doesn't carry would make this
        //    `toBe(undefined)`, which the observed path can never satisfy.
        expect(expectedBinaries[runnerId]).toBeDefined();
        expect(observed.runnerBinary).toBe(expectedBinaries[runnerId]);
        // 2. The runner ID survived every wire copy of AgentConfig — including
        //    the non-default one, which is what makes this loop real rather
        //    than two runs of the same path.
        expect(observed.owner.agentConfig.runner).toBe(runnerId);
        // 3. The model is a `provider/model-id` ref (@ax/cli dev-agents-stub's
        //    default), which is what @ax/agent-claude-sdk-runner parses.
        expect(observed.owner.agentConfig.model).toBe(
          'anthropic/claude-sonnet-4-6',
        );
      },
    );
  },
);
