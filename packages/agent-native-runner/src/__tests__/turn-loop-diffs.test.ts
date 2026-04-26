import { describe, expect, it } from 'vitest';
import {
  createDiffAccumulator,
  createLocalDispatcher,
  type InboxLoop,
  type InboxLoopEntry,
  type IpcClient,
} from '@ax/agent-runner-core';
import type {
  LlmCallResponse,
  ToolCall,
  ToolDescriptor,
  ToolPreCallResponse,
  WorkspaceCommitNotifyResponse,
} from '@ax/ipc-protocol';
import { runTurnLoop } from '../turn-loop.js';

// ---------------------------------------------------------------------------
// Task 7c — multi-tool turn aggregates into one workspace.commit-notify.
//
// The native runner's turn loop drains its DiffAccumulator at turn end
// and ships exactly one commit-notify request per turn, regardless of
// how many file-mutating tools the model called. This test stands up a
// fake IpcClient + dispatcher, wires the file-io tool's `onFileChange`
// observer into the accumulator the way main.ts does, and asserts the
// captured request contains all three operations (in any order, since
// the accumulator stores by path — the wire ordering is implementation
// detail).
// ---------------------------------------------------------------------------

interface CallRecord {
  action: string;
  payload: unknown;
}
interface EventRecord {
  name: string;
  payload: unknown;
}

function makeFakeClient(canned: Record<string, unknown[]>): {
  client: IpcClient;
  calls: CallRecord[];
  events: EventRecord[];
} {
  const calls: CallRecord[] = [];
  const events: EventRecord[] = [];
  const queues: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(canned)) queues[k] = [...v];

  const client: IpcClient = {
    async call(action, payload) {
      calls.push({ action, payload });
      const queue = queues[action];
      if (queue === undefined || queue.length === 0) {
        throw new Error(`fake client: no canned response for ${action}`);
      }
      return queue.shift()!;
    },
    async callGet() {
      throw new Error('fake client: callGet not used');
    },
    async event(name, payload) {
      events.push({ name, payload });
    },
    async close() {},
  };
  return { client, calls, events };
}

function makeFakeInbox(entries: InboxLoopEntry[]): InboxLoop {
  const queue = [...entries];
  let cursor = 0;
  return {
    async next() {
      if (queue.length === 0) throw new Error('fake inbox: exhausted');
      cursor += 1;
      return queue.shift()!;
    },
    get cursor() {
      return cursor;
    },
  };
}

const userMsg = (content: string): InboxLoopEntry => ({
  type: 'user-message',
  payload: { role: 'user', content },
  reqId: 'r-test',
});
const cancel: InboxLoopEntry = { type: 'cancel' };

const tools: ToolDescriptor[] = [
  { name: 'write_file', inputSchema: {}, executesIn: 'sandbox' },
];

function llmWithTool(
  toolName: string,
  input: unknown,
  callId: string,
): LlmCallResponse {
  const call: ToolCall = { id: callId, name: toolName, input };
  return {
    assistantMessage: { role: 'assistant', content: `running ${toolName}` },
    toolCalls: [call],
  };
}
function llmDone(): LlmCallResponse {
  return {
    assistantMessage: { role: 'assistant', content: 'done' },
    toolCalls: [],
  };
}
function preAllow(): ToolPreCallResponse {
  return { verdict: 'allow' };
}

describe('runTurnLoop: per-turn workspace diff aggregation (Task 7c)', () => {
  it('multiple writes within a single user-message turn ship as ONE commit-notify with all changes', async () => {
    const diffs = createDiffAccumulator();

    // Stand in for the file-io impl: register a fake `write_file` executor
    // that ALSO feeds the diff accumulator the same way registerFileIo
    // does. We don't pull in the real impl here — that would require a
    // tmpdir; the contract under test is "accumulator drains at turn end".
    const dispatcher = createLocalDispatcher();
    dispatcher.register('write_file', async (call) => {
      const input = call.input as { path: string; content: string };
      diffs.record({
        path: input.path,
        kind: 'put',
        content: Buffer.from(input.content, 'utf8'),
      });
      return { path: input.path, bytes: input.content.length };
    });
    // Manual delete probe — exercises the accumulator's delete branch
    // even though the production tool catalog has no delete_file yet.
    dispatcher.register('delete_file', async (call) => {
      const input = call.input as { path: string };
      diffs.record({ path: input.path, kind: 'delete' });
      return { path: input.path };
    });

    const commitResponse: WorkspaceCommitNotifyResponse = {
      accepted: true,
      version: 'v1' as never,
      delta: null,
    };

    const { client, calls } = makeFakeClient({
      'llm.call': [
        llmWithTool('write_file', { path: 'a.txt', content: 'AAA' }, 'c1'),
        llmWithTool('write_file', { path: 'b.txt', content: 'BBB' }, 'c2'),
        llmWithTool('delete_file', { path: 'old.txt' }, 'c3'),
        llmDone(),
      ],
      'tool.pre-call': [preAllow(), preAllow(), preAllow()],
      'workspace.commit-notify': [commitResponse],
    });
    const inbox = makeFakeInbox([userMsg('do work'), cancel]);

    const outcome = await runTurnLoop({
      client,
      inbox,
      dispatcher,
      tools,
      diffs,
      commitRefGen: () => 'commit-ref-1',
    });

    expect(outcome.kind).toBe('complete');

    const commitCalls = calls.filter(
      (c) => c.action === 'workspace.commit-notify',
    );
    // Single notify per turn, even though THREE workspace-mutating tool
    // calls fired during the turn.
    expect(commitCalls).toHaveLength(1);

    const payload = commitCalls[0]!.payload as {
      parentVersion: string | null;
      commitRef: string;
      message: string;
      changes: Array<
        | { path: string; kind: 'put'; content: string }
        | { path: string; kind: 'delete' }
      >;
    };
    expect(payload.parentVersion).toBeNull();
    expect(payload.commitRef).toBe('commit-ref-1');
    expect(payload.message).toBe('turn');

    // Aggregate diff: 2 puts + 1 delete = 3 changes. Order is irrelevant —
    // the wire transport doesn't promise ordering.
    expect(payload.changes).toHaveLength(3);
    const byPath = new Map(payload.changes.map((c) => [c.path, c]));
    const a = byPath.get('a.txt');
    const b = byPath.get('b.txt');
    const old = byPath.get('old.txt');
    expect(a?.kind).toBe('put');
    expect(b?.kind).toBe('put');
    expect(old?.kind).toBe('delete');
    if (a?.kind === 'put') {
      expect(Buffer.from(a.content, 'base64').toString('utf8')).toBe('AAA');
    }
    if (b?.kind === 'put') {
      expect(Buffer.from(b.content, 'base64').toString('utf8')).toBe('BBB');
    }
  });

  it('parentVersion advances across turns: turn 2 carries turn 1 result', async () => {
    const diffs = createDiffAccumulator();
    const dispatcher = createLocalDispatcher();
    dispatcher.register('write_file', async (call) => {
      const input = call.input as { path: string; content: string };
      diffs.record({
        path: input.path,
        kind: 'put',
        content: Buffer.from(input.content, 'utf8'),
      });
      return { path: input.path, bytes: input.content.length };
    });

    const { client, calls } = makeFakeClient({
      'llm.call': [
        llmWithTool('write_file', { path: 'a.txt', content: 'A' }, 'c1'),
        llmDone(),
        llmWithTool('write_file', { path: 'b.txt', content: 'B' }, 'c2'),
        llmDone(),
      ],
      'tool.pre-call': [preAllow(), preAllow()],
      'workspace.commit-notify': [
        { accepted: true, version: 'v1', delta: null },
        { accepted: true, version: 'v2', delta: null },
      ],
    });
    const inbox = makeFakeInbox([userMsg('first'), userMsg('second'), cancel]);

    await runTurnLoop({ client, inbox, dispatcher, tools, diffs });

    const commitCalls = calls.filter(
      (c) => c.action === 'workspace.commit-notify',
    );
    expect(commitCalls).toHaveLength(2);

    const first = commitCalls[0]!.payload as { parentVersion: string | null };
    const second = commitCalls[1]!.payload as { parentVersion: string | null };
    expect(first.parentVersion).toBeNull();
    expect(second.parentVersion).toBe('v1');
  });

  it('empty turn (no file changes) skips commit-notify entirely', async () => {
    // Skipping empty notifies keeps the wire quiet when no workspace
    // plugin is registered host-side. event.turn-end carries the
    // heartbeat — commit-notify is reserved for actual diffs.
    const diffs = createDiffAccumulator();
    const dispatcher = createLocalDispatcher();

    const { client, calls } = makeFakeClient({
      'llm.call': [llmDone()],
    });
    const inbox = makeFakeInbox([userMsg('hi'), cancel]);

    await runTurnLoop({ client, inbox, dispatcher, tools, diffs });

    const commitCalls = calls.filter(
      (c) => c.action === 'workspace.commit-notify',
    );
    expect(commitCalls).toHaveLength(0);
  });

  it('commit-notify failure does not terminate the runner', async () => {
    const diffs = createDiffAccumulator();
    const dispatcher = createLocalDispatcher();
    dispatcher.register('write_file', async (call) => {
      const input = call.input as { path: string; content: string };
      diffs.record({
        path: input.path,
        kind: 'put',
        content: Buffer.from(input.content, 'utf8'),
      });
      return { path: input.path, bytes: input.content.length };
    });

    // Build a custom client whose commit-notify throws on the first call
    // and succeeds on the second. Each turn drives a write so the
    // accumulator is non-empty and commit-notify actually fires.
    const calls: CallRecord[] = [];
    const events: EventRecord[] = [];
    let llmIdx = 0;
    const llmCanned: LlmCallResponse[] = [
      llmWithTool('write_file', { path: 'a.txt', content: 'A' }, 'c1'),
      llmDone(),
      llmWithTool('write_file', { path: 'b.txt', content: 'B' }, 'c2'),
      llmDone(),
    ];
    let preIdx = 0;
    const preCanned: ToolPreCallResponse[] = [preAllow(), preAllow()];
    let commitIdx = 0;
    const client: IpcClient = {
      async call(action, payload) {
        calls.push({ action, payload });
        if (action === 'llm.call') {
          const r = llmCanned[llmIdx++];
          if (r === undefined) throw new Error('llm.call exhausted');
          return r;
        }
        if (action === 'tool.pre-call') {
          const r = preCanned[preIdx++];
          if (r === undefined) throw new Error('tool.pre-call exhausted');
          return r;
        }
        if (action === 'workspace.commit-notify') {
          const i = commitIdx++;
          if (i === 0) throw new Error('host down');
          return { accepted: true, version: 'v1', delta: null };
        }
        throw new Error(`unexpected: ${action}`);
      },
      async callGet() {
        throw new Error('not used');
      },
      async event(name, payload) {
        events.push({ name, payload });
      },
      async close() {},
    };

    const inbox = makeFakeInbox([userMsg('one'), userMsg('two'), cancel]);
    const outcome = await runTurnLoop({
      client,
      inbox,
      dispatcher,
      tools,
      diffs,
    });

    expect(outcome.kind).toBe('complete');
    const notifies = calls.filter(
      (c) => c.action === 'workspace.commit-notify',
    );
    expect(notifies).toHaveLength(2);

    // Regression: snapshot-then-drain-on-success preserves the diff
    // through a thrown IPC. Turn 1's commit-notify threw — its `a.txt`
    // change must NOT be lost. Turn 2's notify should carry BOTH paths.
    const turn2Changes = (
      notifies[1]?.payload as { changes: Array<{ path: string }> }
    ).changes;
    const turn2Paths = turn2Changes.map((c) => c.path).sort();
    expect(turn2Paths).toEqual(['a.txt', 'b.txt']);
  });
});
