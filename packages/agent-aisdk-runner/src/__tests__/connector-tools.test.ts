import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHoldLatch, type PreToolVerdict, type ToolPolicy } from '@ax/agent-runner-core';
import {
  connectConnectorTools,
  MAX_ERROR_CHARS,
  MAX_TOOLS_PER_CONNECTOR,
  MAX_TOOLS_PER_SESSION,
  type ConnectorTools,
} from '../tools/connector-tools.js';
import { HOLD_LATCH, POLICY_WRAPPED, type WrappedExecute } from '../tools/policy-wrap.js';
import { startHangingServer, startMcpTestServer, type TestTool } from './helpers/mcp-test-server.js';

const NS = 'c0123456789';
const NS2 = 'cabcdef0123';
const PH = 'ax-cred:' + 'a'.repeat(32);

function fakePolicy(over: Partial<ToolPolicy> = {}): ToolPolicy & {
  preToolUse: ReturnType<typeof vi.fn>;
  postToolUse: ReturnType<typeof vi.fn>;
} {
  return {
    preToolUse: vi.fn(async (): Promise<PreToolVerdict> => ({ decision: 'allow' })),
    postToolUse: vi.fn(async () => ({})),
    ...over,
  } as never;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function connect(
  servers: Record<string, { url: string; headers?: Record<string, string>; bundle: string }>,
  over: Partial<Parameters<typeof connectConnectorTools>[0]> = {},
): Promise<ConnectorTools & { logs: string[]; policy: ReturnType<typeof fakePolicy> }> {
  const logs: string[] = [];
  const policy = fakePolicy();
  const ct = await connectConnectorTools({
    servers,
    fetch: undefined,
    policy,
    holdLatch: createHoldLatch(),
    onHold: () => {},
    onToolFailure: () => {},
    disallowed: [],
    log: (l) => logs.push(l),
    ...over,
  });
  cleanups.push(() => ct.close());
  return { ...ct, logs, policy: (over.policy as ReturnType<typeof fakePolicy>) ?? policy };
}

const exec = (ct: ConnectorTools, name: string, input: unknown, signal?: AbortSignal) =>
  (ct.tools[name]!.execute as WrappedExecute)(input, {
    toolCallId: 'call-1',
    ...(signal ? { abortSignal: signal } : {}),
  });

async function testServer(
  tools: TestTool[],
  extra: Omit<Parameters<typeof startMcpTestServer>[0], 'tools'> = {},
) {
  const s = await startMcpTestServer({ tools, ...extra });
  cleanups.push(() => s.close());
  return s;
}

/**
 * `echo` + `crash`. `crash` tears the whole HTTP server down mid-request
 * (every open socket destroyed, nothing answered) — what a connector process
 * dying under a call looks like from the client's side.
 */
async function echoCrashServer() {
  const ref: { self?: Awaited<ReturnType<typeof startMcpTestServer>> } = {};
  ref.self = await testServer([
    {
      name: 'echo',
      description: 'echo the input text verbatim',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: (args) => ({ content: [{ type: 'text', text: String(args['text'] ?? '') }] }),
    },
    {
      name: 'crash',
      description: 'drop the server mid-call',
      handler: () => {
        void ref.self?.close();
        return new Promise(() => {});
      },
    },
  ]);
  return ref.self;
}

describe('connectConnectorTools', () => {
  it('offers tools as mcp__<ns>__<tool>, gates them as mcp.<ns>.<tool>, and round-trips a call', async () => {
    const stub = await echoCrashServer();
    const ct = await connect({ [NS]: { url: stub.url, bundle: 'conn-a' } });

    expect(Object.keys(ct.tools).sort()).toEqual([`mcp__${NS}__crash`, `mcp__${NS}__echo`]);
    expect(ct.loadedBundles).toEqual(new Set(['conn-a']));
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'hi there' })).resolves.toBe('hi there');
    expect(ct.policy.preToolUse).toHaveBeenCalledWith(`mcp.${NS}.echo`, { text: 'hi there' }, 'call-1');
    expect(ct.policy.postToolUse).toHaveBeenCalledWith(
      `mcp.${NS}.echo`, 'call-1', { text: 'hi there' }, 'hi there', false,
    );
  });

  it('wraps every tool with the policy and the ONE shared latch', async () => {
    const stub = await echoCrashServer();
    const holdLatch = createHoldLatch();
    const ct = await connect({ [NS]: { url: stub.url, bundle: 'b' } }, { holdLatch });
    for (const t of Object.values(ct.tools)) {
      const ex = t.execute as WrappedExecute;
      expect(ex[POLICY_WRAPPED]).toBe(true);
      expect(ex[HOLD_LATCH]).toBe(holdLatch);
    }
  });

  it('a server crash mid-call is a failed tool call; another connector keeps working', async () => {
    const crashy = await echoCrashServer();
    const healthy = await testServer([
      { name: 'ping', handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) },
    ]);
    const ct = await connect({
      [NS]: { url: crashy.url, bundle: 'a' },
      [NS2]: { url: healthy.url, bundle: 'b' },
    });
    await expect(exec(ct, `mcp__${NS}__crash`, {})).rejects.toThrow();
    await expect(exec(ct, `mcp__${NS2}__ping`, {})).resolves.toBe('pong');
  });

  it('an isError result throws with the server text (parity: tool-error, turn continues)', async () => {
    const s = await testServer([
      { name: 'boom', handler: () => ({ content: [{ type: 'text', text: 'quota exceeded' }], isError: true }) },
    ]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    await expect(exec(ct, `mcp__${NS}__boom`, {})).rejects.toThrow('quota exceeded');
  });

  it('a denied connector tool is not offered; its siblings are', async () => {
    const stub = await echoCrashServer();
    const ct = await connect({ [NS]: { url: stub.url, bundle: 'b' } }, { disallowed: [`mcp.${NS}.crash`, 'Bash'] });
    expect(Object.keys(ct.tools)).toEqual([`mcp__${NS}__echo`]);
    expect(ct.logs.join('\n')).toMatch(/crash.*denied/);
  });

  it('an unreachable or wedged server loses only its own tools, within the bound, in parallel', async () => {
    const hang1 = await startHangingServer();
    const hang2 = await startHangingServer();
    cleanups.push(() => hang1.close(), () => hang2.close());
    const ok = await testServer([{ name: 'ping', handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) }]);
    const started = Date.now();
    const ct = await connect(
      {
        c0000000001: { url: hang1.url, bundle: 'h1' },
        c0000000002: { url: hang2.url, bundle: 'h2' },
        c0000000003: { url: 'http://127.0.0.1:1/mcp', bundle: 'dead' },
        [NS]: { url: ok.url, bundle: 'ok' },
      },
      { connectTimeoutMs: 300 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(Object.keys(ct.tools)).toEqual([`mcp__${NS}__ping`]);
    expect(ct.loadedBundles).toEqual(new Set(['ok']));
    expect(ct.logs.filter((l) => /^c000000000[123]: /.test(l))).toHaveLength(3);
  });

  it('drops a connector that answers 401 (e.g. an expired token) without failing', async () => {
    const s = await testServer([{ name: 'ping' }], { status: 401 });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { connectTimeoutMs: 2_000 });
    expect(ct.tools).toEqual({});
    expect(ct.loadedBundles.size).toBe(0);
    expect(ct.logs.join('\n')).toMatch(new RegExp(`^${NS}: `, 'm'));
  });

  it('drops the whole connector when a listed tool has a non-object inputSchema (SDK list validation)', async () => {
    const s = await testServer([
      { name: 'good' },
      { name: 'bad', inputSchema: { type: 'string' } },
    ]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    expect(ct.tools).toEqual({});
    expect(ct.loadedBundles.size).toBe(0);
  });

  it('skips over-long / illegal names and duplicates with a log line, never renaming', async () => {
    const s = await testServer([
      { name: 'x'.repeat(60) },          // mcp__c0123456789__ + 60 = 78 chars > 64
      { name: 'has.dot' },
      { name: 'fine' },
      { name: 'fine' },
    ]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    expect(Object.keys(ct.tools)).toEqual([`mcp__${NS}__fine`]);
    const log = ct.logs.join('\n');
    expect(log).toMatch(/not a valid model tool name/);
    expect(log).toMatch(/has\.dot/);
    expect(log).toMatch(/duplicate/);
    expect(ct.loadedBundles).toEqual(new Set(['b']));
  });

  it(`follows nextCursor and caps at ${MAX_TOOLS_PER_CONNECTOR} tools per connector`, async () => {
    const tools = Array.from({ length: 300 }, (_, i) => ({ name: `t${i}` }));
    const s = await testServer(tools, { pageSize: 25 });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    expect(Object.keys(ct.tools)).toHaveLength(MAX_TOOLS_PER_CONNECTOR);
    expect(ct.tools[`mcp__${NS}__t255`]).toBeDefined();
    expect(ct.tools[`mcp__${NS}__t256`]).toBeUndefined();
    expect(ct.logs.join('\n')).toMatch(/256/);
  });

  it('stops after 16 list pages and says so', async () => {
    const tools = Array.from({ length: 20 }, (_, i) => ({ name: `t${i}` }));
    const s = await testServer(tools, { pageSize: 1 });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    expect(Object.keys(ct.tools)).toHaveLength(16);
    expect(ct.tools[`mcp__${NS}__t15`]).toBeDefined();
    expect(ct.tools[`mcp__${NS}__t16`]).toBeUndefined();
    expect(ct.logs).toContain(`${NS}: tools/list still had more pages after 16 — the rest are not offered`);
    expect(ct.loadedBundles).toEqual(new Set(['b']));
  });

  it('aborts an in-flight call on Stop instead of waiting out the call timeout', async () => {
    const s = await testServer([{ name: 'slow', handler: () => new Promise(() => {}) }]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    const stop = new AbortController();
    const started = Date.now();
    const p = exec(ct, `mcp__${NS}__slow`, {}, stop.signal);
    setTimeout(() => stop.abort(), 50);
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('progress notifications extend a call past the per-call timeout', async () => {
    let sawProgressToken = false;
    const s = await testServer([
      {
        name: 'slow',
        handler: async (_args, extra) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken !== undefined) {
            sawProgressToken = true;
            for (let i = 1; i <= 9; i++) {
              await new Promise((r) => setTimeout(r, 100));
              await extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: i },
              });
            }
          } else {
            await new Promise((r) => setTimeout(r, 900));
          }
          return { content: [{ type: 'text', text: 'pong' }] };
        },
      },
    ]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { callTimeoutMs: 300 });
    await expect(exec(ct, `mcp__${NS}__slow`, {})).resolves.toBe('pong');
    expect(sawProgressToken).toBe(true);
  });

  it('a silent call fails at the per-call timeout', async () => {
    const s = await testServer([
      {
        name: 'silent',
        handler: async () => {
          await new Promise((r) => setTimeout(r, 900));
          return { content: [{ type: 'text', text: 'pong' }] };
        },
      },
    ]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { callTimeoutMs: 300 });
    await expect(exec(ct, `mcp__${NS}__silent`, {})).rejects.toThrow();
  });

  it('sends the ax-cred placeholder through the injected fetch — the runner never holds a real secret', async () => {
    const s = await testServer([{ name: 'ping', handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) }]);
    const seenByFetch: string[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      seenByFetch.push(new Headers(init?.headers).get('authorization') ?? '<none>');
      return fetch(input, init);
    };
    const ct = await connect(
      { [NS]: { url: s.url, headers: { Authorization: `Bearer ${PH}` }, bundle: 'b' } },
      { fetch: recordingFetch },
    );
    await expect(exec(ct, `mcp__${NS}__ping`, {})).resolves.toBe('pong');
    // Every request — initialize, list, call — went through OUR fetch (the
    // proxy dispatcher in production) and carried only the placeholder.
    expect(seenByFetch.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seenByFetch)).toEqual(new Set([`Bearer ${PH}`]));
    expect(s.seenHeaders.every((h) => h.authorization === `Bearer ${PH}`)).toBe(true);
  });

  it('close() resolves and is safe to call twice', async () => {
    const stub = await echoCrashServer();
    const ct = await connect({ [NS]: { url: stub.url, bundle: 'b' } });
    await ct.close();
    await ct.close();
  });

  it('a call that fails with a huge HTTP error body is clipped before it reaches the model / transcript', async () => {
    const huge = ('A'.repeat(99) + '\n').repeat(10_000); // ~1 MB with newlines
    const s = await testServer([{ name: 'ping' }], {
      methodError: { method: 'tools/call', status: 500, body: huge },
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    const err = await exec(ct, `mcp__${NS}__ping`, {}).then(
      () => { throw new Error('expected the call to fail'); },
      (e: unknown) => e as Error,
    );
    expect(err.message.length).toBeLessThanOrEqual(MAX_ERROR_CHARS + 200);
    expect(err.message).toContain('[truncated]');
    expect(err.message).toContain(`connector tool 'ping' failed`);
    // postToolUse saw the clipped text too, never the 1 MB body.
    for (const call of ct.policy.postToolUse.mock.calls) {
      expect(JSON.stringify(call).length).toBeLessThan(MAX_ERROR_CHARS * 2 + 1_000);
    }
  });

  it('a list failure with a huge, newline-laden body logs ONE bounded, escaped line', async () => {
    const body = 'x'.repeat(150_000) + '\nrunner: FORGED LINE\n' + 'y'.repeat(150_000);
    const s = await testServer([{ name: 'ping' }], {
      methodError: { method: 'tools/list', status: 502, body },
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { connectTimeoutMs: 2_000 });
    expect(ct.tools).toEqual({});
    const mine = ct.logs.filter((l) => l.startsWith(`${NS}: `));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.length).toBeLessThanOrEqual(600);
    expect(mine[0]).not.toContain('\n');
    expect(ct.logs.join('\n')).not.toMatch(/^runner: FORGED LINE/m);
  });

  it('skip lines JSON-escape the untrusted tool name', async () => {
    const s = await testServer([{ name: 'evil\nrunner: FORGED' }, { name: 'fine' }]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    expect(Object.keys(ct.tools)).toEqual([`mcp__${NS}__fine`]);
    for (const l of ct.logs) expect(l).not.toContain('\n');
    expect(ct.logs.join('\n')).toContain('"evil\\nrunner: FORGED"');
  });

  describe('session tool budget (maxTools)', () => {
    const three = (p: string): TestTool[] => [{ name: `${p}1` }, { name: `${p}2` }, { name: `${p}3` }];
    // The first-SORTED connector answers LAST, and is listed second in the
    // record: admission must follow sorted namespace order, not settle order
    // or insertion order.
    async function twoConnectors(maxTools: number) {
      const slow = await testServer(three('a'), { listDelayMs: 300 });
      const fast = await testServer(three('b'));
      return connect(
        {
          c0000000002: { url: fast.url, bundle: 'fast' },
          c0000000001: { url: slow.url, bundle: 'slow' },
        },
        { maxTools },
      );
    }

    it('drops a whole connector that would push the session over budget, in sorted-ns order', async () => {
      const ct = await twoConnectors(4);
      expect(Object.keys(ct.tools).sort()).toEqual([
        'mcp__c0000000001__a1', 'mcp__c0000000001__a2', 'mcp__c0000000001__a3',
      ]);
      expect(ct.loadedBundles).toEqual(new Set(['slow']));
      const budget = ct.logs.filter((l) => /tool budget/.test(l));
      expect(budget).toEqual([
        "c0000000002: not offered — its 3 tools would exceed this session's tool budget (4)",
      ]);
    });

    it('offers every connector when they fit', async () => {
      const ct = await twoConnectors(6);
      expect(Object.keys(ct.tools)).toHaveLength(6);
      expect(ct.loadedBundles).toEqual(new Set(['slow', 'fast']));
      expect(ct.logs.filter((l) => /tool budget/.test(l))).toEqual([]);
    });

    it('a budget of 0 offers no connector tools', async () => {
      const ct = await twoConnectors(0);
      expect(ct.tools).toEqual({});
      expect(ct.loadedBundles.size).toBe(0);
      expect(ct.logs.filter((l) => /tool budget/.test(l))).toHaveLength(2);
    });
  });

  it(`MAX_TOOLS_PER_SESSION is the strictest provider function limit (${MAX_TOOLS_PER_SESSION})`, () => {
    expect(MAX_TOOLS_PER_SESSION).toBe(128);
  });

  it('close() gives up after its bound and says so', async () => {
    const s = await testServer([{ name: 'ping' }]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    const hang = vi.spyOn(Client.prototype, 'close').mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const p = ct.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await p;
      expect(ct.logs).toContain('closing connector clients timed out after 5000ms');
    } finally {
      vi.useRealTimers();
      hang.mockRestore();
    }
  });

  it('no servers → no tools, no logs', async () => {
    const ct = await connect({});
    expect(ct.tools).toEqual({});
    expect(ct.logs).toEqual([]);
  });
});

describe('connectConnectorTools — server drops the MCP session (TASK-839)', () => {
  const echoTool: TestTool = {
    name: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    handler: (args) => ({ content: [{ type: 'text', text: String(args['text'] ?? '') }] }),
  };
  const inits = (s: { seenMethods: string[] }) => s.seenMethods.filter((m) => m === 'initialize').length;
  const calls = (s: { seenMethods: string[] }) => s.seenMethods.filter((m) => m === 'tools/call').length;

  /** Every Client this test connected — so a test can assert none was leaked. */
  function trackClients(): { connected: Client[]; closed: Set<Client> } {
    const connected: Client[] = [];
    const closed = new Set<Client>();
    const realConnect = Client.prototype.connect;
    const realClose = Client.prototype.close;
    const c = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client, ...a) {
      connected.push(this);
      return realConnect.apply(this, a);
    });
    const d = vi.spyOn(Client.prototype, 'close').mockImplementation(function (this: Client) {
      closed.add(this);
      return realClose.apply(this);
    });
    cleanups.push(async () => {
      c.mockRestore();
      d.mockRestore();
    });
    return { connected, closed };
  }

  it('re-initializes once and retries the call when the server has forgotten the session', async () => {
    const s = await testServer([echoTool], { sessionful: true });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'before' })).resolves.toBe('before');
    expect(inits(s)).toBe(1);

    await s.forgetSessions();
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'after' })).resolves.toBe('after');
    expect(inits(s)).toBe(2);
    expect(ct.logs.join('\n')).toMatch(new RegExp(`^${NS}: .*session.*reconnected`, 'm'));

    // The fresh session sticks: the next call needs no further initialize.
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'again' })).resolves.toBe('again');
    expect(inits(s)).toBe(2);
    // Policy saw ONE call per execute, never the internal retry.
    expect(ct.policy.preToolUse).toHaveBeenCalledTimes(3);
    expect(ct.policy.postToolUse).toHaveBeenLastCalledWith(`mcp.${NS}.echo`, 'call-1', { text: 'again' }, 'again', false);
  });

  it('a 404 without an MCP session (stateless server) is a plain failed call — no reconnect', async () => {
    const s = await testServer([echoTool], {
      methodError: { method: 'tools/call', status: 404, body: 'no such route' },
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'x' })).rejects.toThrow(/connector tool 'echo' failed/);
    expect(inits(s)).toBe(1);
    expect(calls(s)).toBe(1);
  });

  it('a non-404 failure on a sessionful server does not reconnect', async () => {
    let fail = false;
    const s = await testServer([echoTool], {
      sessionful: true,
      intercept: (m) => (fail && m === 'tools/call' ? { status: 500, body: 'boom' } : undefined),
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    fail = true;
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'x' })).rejects.toThrow(/connector tool 'echo' failed/);
    expect(inits(s)).toBe(1);
    expect(calls(s)).toBe(1);
  });

  it('retries only once: a retry that loses its session again is a failed, clipped call', async () => {
    const huge = 'Z'.repeat(50_000);
    const ref: { s?: Awaited<ReturnType<typeof testServer>> } = {};
    let forgetOnCall = false;
    const s = await testServer([echoTool], {
      sessionful: true,
      intercept: async (m) => {
        if (forgetOnCall && m === 'tools/call') {
          await ref.s!.forgetSessions();
          return { status: 404, body: huge };
        }
        return undefined;
      },
    });
    ref.s = s;
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    forgetOnCall = true;
    const err = await exec(ct, `mcp__${NS}__echo`, { text: 'x' }).then(
      () => { throw new Error('expected the call to fail'); },
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain(`connector tool 'echo' failed`);
    expect(err.message).toContain('[truncated]');
    expect(err.message.length).toBeLessThanOrEqual(MAX_ERROR_CHARS + 200);
    expect(inits(s)).toBe(2);
    expect(calls(s)).toBe(2);
    expect(ct.policy.preToolUse).toHaveBeenCalledTimes(1);
  });

  it('a reconnect that fails is a failed call; a later call reconnects and heals', async () => {
    let refuseInit = false;
    const s = await testServer([echoTool], {
      sessionful: true,
      intercept: (m) =>
        refuseInit && m === 'initialize' ? { status: 503, body: 'restarting\nrunner: FORGED' } : undefined,
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { connectTimeoutMs: 2_000 });
    await s.forgetSessions();
    refuseInit = true;
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'x' })).rejects.toThrow(/connector tool 'echo' failed/);
    expect(calls(s)).toBe(1);
    const mine = ct.logs.filter((l) => l.startsWith(`${NS}: `));
    expect(mine.some((l) => /could not reconnect/.test(l))).toBe(true);
    for (const l of ct.logs) expect(l).not.toContain('\n');

    refuseInit = false;
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'healed' })).resolves.toBe('healed');
  });

  it('concurrent calls that all lose the session share ONE reconnect', async () => {
    const s = await testServer([echoTool], { sessionful: true });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    await s.forgetSessions();
    const out = await Promise.all(['a', 'b', 'c'].map((t) => exec(ct, `mcp__${NS}__echo`, { text: t })));
    expect(out).toEqual(['a', 'b', 'c']);
    expect(inits(s)).toBe(2);
  });

  it('a call whose 404 lands AFTER another call already reconnected reuses that connection', async () => {
    const tracked = trackClients();
    let n = 0;
    let release: (() => void) | undefined;
    const s = await testServer([echoTool], {
      sessionful: true,
      intercept: async (m) => {
        // Hold the FIRST tools/call after the forget until the test releases it.
        if (m === 'tools/call' && ++n === 1) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return undefined;
      },
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    await s.forgetSessions();
    const late = exec(ct, `mcp__${NS}__echo`, { text: 'late' });
    await vi.waitFor(() => expect(release).toBeDefined());
    // A second call fails, reconnects and succeeds while the first is held.
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'early' })).resolves.toBe('early');
    expect(inits(s)).toBe(2);
    // The replaced boot client stays open while the held call still runs on it…
    expect(tracked.connected).toHaveLength(2);
    expect(tracked.closed.has(tracked.connected[0]!)).toBe(false);
    release!();
    await expect(late).resolves.toBe('late');
    expect(inits(s)).toBe(2);
    // …and is closed once that last call settles.
    await vi.waitFor(() => expect(tracked.closed.has(tracked.connected[0]!)).toBe(true));
    expect(tracked.closed.has(tracked.connected[1]!)).toBe(false);
  });

  it('close() also closes a replaced connection that still has a call running on it', async () => {
    const tracked = trackClients();
    let n = 0;
    let held = false;
    const s = await testServer([echoTool], {
      sessionful: true,
      intercept: async (m) => {
        if (m === 'tools/call' && ++n === 1) {
          held = true;
          await new Promise(() => {});
        }
        return undefined;
      },
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    await s.forgetSessions();
    const stuck = exec(ct, `mcp__${NS}__echo`, { text: 'stuck' });
    await vi.waitFor(() => expect(held).toBe(true));
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'ok' })).resolves.toBe('ok');
    expect(tracked.closed.has(tracked.connected[0]!)).toBe(false);
    await ct.close();
    await stuck.catch(() => {});
    expect(tracked.connected).toHaveLength(2);
    for (const c of tracked.connected) expect(tracked.closed.has(c)).toBe(true);
  });

  it('Stop during the reconnect aborts it promptly', async () => {
    let hangInit = false;
    const s = await testServer([echoTool], {
      sessionful: true,
      intercept: async (m) => {
        if (hangInit && m === 'initialize') await new Promise(() => {});
        return undefined;
      },
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { connectTimeoutMs: 30_000 });
    await s.forgetSessions();
    hangInit = true;
    const ac = new AbortController();
    const started = Date.now();
    const p = exec(ct, `mcp__${NS}__echo`, { text: 'x' }, ac.signal);
    await vi.waitFor(() => expect(inits(s)).toBe(2));
    const stop = new Error('user pressed Stop');
    ac.abort(stop);
    await expect(p).rejects.toBe(stop);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a reconnect is bounded by the connect timeout', async () => {
    let hangInit = false;
    const s = await testServer([echoTool], {
      sessionful: true,
      intercept: async (m) => {
        if (hangInit && m === 'initialize') await new Promise(() => {});
        return undefined;
      },
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { connectTimeoutMs: 300 });
    await s.forgetSessions();
    hangInit = true;
    const started = Date.now();
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'x' })).rejects.toThrow(/connector tool 'echo' failed/);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(inits(s)).toBe(2);
    expect(calls(s)).toBe(1);
  });

  it('every client ever connected is closed — the replaced one, and one whose reconnect finished after close()', async () => {
    const tracked = trackClients();
    let release: (() => void) | undefined;
    let holdInit = false;
    const s = await testServer([echoTool], {
      sessionful: true,
      intercept: async (m) => {
        if (holdInit && m === 'initialize') {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return undefined;
      },
    });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { connectTimeoutMs: 10_000 });

    // Round 1: an ordinary reconnect replaces the boot client, and closes it.
    await s.forgetSessions();
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'one' })).resolves.toBe('one');
    expect(tracked.connected).toHaveLength(2);
    await vi.waitFor(() => expect(tracked.closed.has(tracked.connected[0]!)).toBe(true));

    // Round 2: close() lands while a reconnect is still in flight.
    await s.forgetSessions();
    holdInit = true;
    const p = exec(ct, `mcp__${NS}__echo`, { text: 'two' });
    await vi.waitFor(() => expect(release).toBeDefined());
    await ct.close();
    release!();
    await p.catch(() => {});
    expect(tracked.connected).toHaveLength(3);
    await vi.waitFor(() => {
      for (const c of tracked.connected) expect(tracked.closed.has(c)).toBe(true);
    });
  });
});
