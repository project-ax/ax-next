/**
 * The workspace's SSE reader, at the frame level (TASK-352).
 *
 * Two things are being pinned. The first is that `tool-use`, `tool-result` and
 * `phase` now reach the caller at all — the reader used to see them and drop
 * them on the floor.
 *
 * The second is the one that matters more and can only be written as
 * negative space: a `thinking` frame reaches NOTHING. There is no handler for
 * it, and this asserts that no OTHER handler quietly picks it up either. The
 * workspace route calls `conversations:get` unfiltered and has no
 * `?includeThinking` gate, so the model's scratchpad arriving here would put
 * chain-of-thought on the one surface that never asked for it (invariant J4).
 * A positive test cannot catch that; only looking for its absence can.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi } from '../workspace-api';

/** One SSE response carrying exactly these frames, then a clean close. */
function sseResponse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        for (const f of frames) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        }
        return undefined;
      }
      controller.close();
      return undefined;
    },
  });
  return new Response(body, { status: 200 });
}

function stubStream(frames: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the workspace reply stream', () => {
  it('hands tool calls and their results to the caller', async () => {
    stubStream([
      {
        reqId: 'r1',
        kind: 'tool-use',
        toolCallId: 'tu1',
        toolName: 'mcp__linear__create_issue',
        input: { title: 'x' },
        activityPhrase: 'Filing a Linear issue',
        seq: 1,
      },
      { reqId: 'r1', kind: 'tool-result', toolCallId: 'tu1', output: 'done', seq: 2 },
      { reqId: 'r1', kind: 'text', text: 'Filed it.', seq: 3 },
      { reqId: 'r1', done: true },
    ]);

    const uses: unknown[] = [];
    const results: unknown[] = [];
    const text: string[] = [];
    let done = false;
    await workspaceApi.streamReply('r1', {
      onText: (t) => text.push(t),
      onDone: () => {
        done = true;
      },
      onError: () => undefined,
      onToolUse: (u) => uses.push(u),
      onToolResult: (r) => results.push(r),
    });

    expect(done).toBe(true);
    expect(text.join('')).toBe('Filed it.');
    expect(uses).toEqual([
      {
        toolCallId: 'tu1',
        toolName: 'mcp__linear__create_issue',
        activityPhrase: 'Filing a Linear issue',
        // `input` itself does NOT come through — what does is the one bounded
        // line derived from it, so the row can say which call this was.
        detail: 'x',
      },
    ]);
    // `output` is untrusted tool content with no renderer here, so it is not
    // forwarded — only what the call ended as.
    expect(results).toEqual([{ toolCallId: 'tu1', isError: undefined, held: undefined }]);
  });

  it('carries the failed and held marks through', async () => {
    stubStream([
      { reqId: 'r1', kind: 'tool-result', toolCallId: 'a', output: 'boom', isError: true, seq: 1 },
      { reqId: 'r1', kind: 'tool-result', toolCallId: 'b', output: 'ask', held: true, seq: 2 },
      { reqId: 'r1', done: true },
    ]);
    const results: Array<{
      toolCallId: string;
      isError?: boolean | undefined;
      held?: boolean | undefined;
    }> = [];
    await workspaceApi.streamReply('r1', {
      onText: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
      onToolResult: (r) => results.push(r),
    });
    expect(results[0]?.isError).toBe(true);
    expect(results[1]?.held).toBe(true);
  });

  it('surfaces a phase frame', async () => {
    stubStream([
      { reqId: 'r1', phase: 'sandbox-starting' },
      { reqId: 'r1', phase: 'sandbox-ready' },
      { reqId: 'r1', kind: 'text', text: 'hi', seq: 1 },
      { reqId: 'r1', done: true },
    ]);
    const phases: string[] = [];
    await workspaceApi.streamReply('r1', {
      onText: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
      onPhase: (p) => phases.push(p),
    });
    expect(phases).toEqual(['sandbox-starting', 'sandbox-ready']);
  });

  it('gives a thinking frame to NOBODY — invariant J4', async () => {
    const SCRATCHPAD = 'the user probably wants me to guess here';
    stubStream([
      { reqId: 'r1', kind: 'thinking', text: SCRATCHPAD, seq: 1 },
      { reqId: 'r1', kind: 'text', text: 'Filed it.', seq: 2 },
      { reqId: 'r1', done: true },
    ]);

    /*
      EVERY handler the reader knows about, each recording what it was given.
      The assertion is that the scratchpad turns up in none of them — not that
      one particular handler skipped it, which is what a test written around
      `onText` alone would prove.
    */
    const seen: unknown[] = [];
    await workspaceApi.streamReply('r1', {
      onText: (t) => seen.push(t),
      onDone: () => undefined,
      onError: (m) => seen.push(m),
      onToolUse: (u) => seen.push(u),
      onToolResult: (r) => seen.push(r),
      onPhase: (p) => seen.push(p),
      onDecisionRaised: (d) => seen.push(d),
      onPermissionRequest: (p) => seen.push(p),
    });

    expect(JSON.stringify(seen)).not.toContain(SCRATCHPAD);
    expect(seen).toEqual(['Filed it.']);
  });

  it('tells two calls to the same tool apart, without forwarding the arguments', async () => {
    /*
      TASK-419. Two `Bash` calls in one turn used to reach the caller as two
      identical descriptions, and the panel drew `Bash` twice. The reader could
      not tell what the agent had done, which is the whole point of the panel.

      What this pins is the LIVE half of that fix — the reload half lives in
      `src/__tests__/server/routes-workspace.test.ts`, and the two agreeing on
      screen is `workspace-steps-seam.test.tsx`.
    */
    stubStream([
      {
        reqId: 'r1',
        kind: 'tool-use',
        toolCallId: 'tu1',
        toolName: 'Bash',
        input: { command: 'pnpm build', description: 'build it' },
        seq: 1,
      },
      {
        reqId: 'r1',
        kind: 'tool-use',
        toolCallId: 'tu2',
        toolName: 'Bash',
        input: { command: 'pnpm test', description: 'test it' },
        seq: 2,
      },
      { reqId: 'r1', done: true },
    ]);

    const uses: Array<{ toolName: string; detail?: string | undefined }> = [];
    await workspaceApi.streamReply('r1', {
      onText: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
      onToolUse: (u) => uses.push(u),
    });

    expect(uses.map((u) => u.detail)).toEqual(['pnpm build', 'pnpm test']);
    expect(uses[0]!.detail).not.toBe(uses[1]!.detail);
    // The reach is unchanged: the caller gets the line, never the arguments.
    expect(uses.every((u) => !('input' in u))).toBe(true);
  });

  it('drops a tool frame that is missing the id the row hangs on', async () => {
    stubStream([
      { reqId: 'r1', kind: 'tool-use', toolName: 'Bash', input: {}, seq: 1 },
      { reqId: 'r1', done: true },
    ]);
    const uses: unknown[] = [];
    await workspaceApi.streamReply('r1', {
      onText: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
      onToolUse: (u) => uses.push(u),
    });
    expect(uses).toEqual([]);
  });

  it('(VISUALS-1) forwards a parsed visual and nothing of its html', async () => {
    stubStream([
      { kind: 'tool-use', toolCallId: 'v1', toolName: 'mcp__ax-sandbox-tools__show_visual', input: { title: 'T', summary: 'S', html: '<p>secret-markup</p>' } },
      { kind: 'tool-result', toolCallId: 'v1', output: JSON.stringify({ artifactId: 'a1', title: 'T', summary: 'S' }) },
      { kind: 'tool-use', toolCallId: 'v2', toolName: 'show_visual', input: {} },
      { kind: 'tool-result', toolCallId: 'v2', output: JSON.stringify({ artifactId: 'a2', title: 'T', summary: 'S' }), isError: true },
      { kind: 'tool-use', toolCallId: 'p1', toolName: 'artifact_publish', input: {} },
      { kind: 'tool-result', toolCallId: 'p1', output: JSON.stringify({ artifactId: 'a3', title: 'T', summary: 'S' }) },
      { done: true },
    ]);
    const seen: unknown[] = [];
    await workspaceApi.streamReply('r1', {
      onText() {},
      onDone() {},
      onError() {},
      onToolUse: (c) => seen.push(c),
      onToolResult: (r) => seen.push(r),
      onVisual: (v) => seen.push(v),
    });
    expect(seen.filter((x) => (x as { artifactId?: string }).artifactId)).toEqual([
      { artifactId: 'a1', title: 'T', summary: 'S' },
    ]);
    expect(JSON.stringify(seen)).not.toContain('secret-markup');
  });

  it('claims a published artifact id only from a successful publish result', async () => {
    stubStream([
      { kind: 'tool-use', toolCallId: 'p1', toolName: 'mcp__ax-sandbox-tools__artifact_publish', input: {} },
      { kind: 'tool-result', toolCallId: 'p1', output: JSON.stringify({ artifactId: 'good1', version: 1 }) },
      { kind: 'tool-use', toolCallId: 'p2', toolName: 'artifact_publish', input: {} },
      { kind: 'tool-result', toolCallId: 'p2', output: JSON.stringify({ artifactId: 'bad1', version: 1 }), isError: true },
      { kind: 'tool-use', toolCallId: 'p3', toolName: 'artifact_publish', input: {} },
      { kind: 'tool-result', toolCallId: 'p3', output: JSON.stringify({ artifactId: 'bad2', version: 1 }), held: true },
      // A result for a call that was never a publish claims nothing.
      { kind: 'tool-use', toolCallId: 'b1', toolName: 'Bash', input: {} },
      { kind: 'tool-result', toolCallId: 'b1', output: JSON.stringify({ artifactId: 'bad3', version: 1 }) },
      { done: true },
    ]);
    const claims: string[] = [];
    await workspaceApi.streamReply('r1', {
      onText() {},
      onDone() {},
      onError() {},
      onArtifactClaim: (id) => claims.push(id),
    });
    expect(claims).toEqual(['good1']);
  });

  it('(VISUALS-1) finds a visual even when nobody asked for tool rows, and skips a held one', async () => {
    stubStream([
      { kind: 'tool-use', toolCallId: 'v1', toolName: 'show_visual', input: { html: '<p>x</p>' } },
      { kind: 'tool-result', toolCallId: 'v1', output: JSON.stringify({ artifactId: 'a1', title: 'T', summary: 'S' }) },
      { kind: 'tool-use', toolCallId: 'v2', toolName: 'show_visual', input: {} },
      { kind: 'tool-result', toolCallId: 'v2', output: JSON.stringify({ artifactId: 'a2', title: 'T', summary: 'S' }), held: true },
      { kind: 'tool-result', toolCallId: 'v3', output: JSON.stringify({ artifactId: 'a3', title: 'T', summary: 'S' }) },
      { done: true },
    ]);
    const seen: unknown[] = [];
    await workspaceApi.streamReply('r1', {
      onText() {},
      onDone() {},
      onError() {},
      onVisual: (v) => seen.push(v),
    });
    expect(seen).toEqual([{ artifactId: 'a1', title: 'T', summary: 'S' }]);
  });
});
