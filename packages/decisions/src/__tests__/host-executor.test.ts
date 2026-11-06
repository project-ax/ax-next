/**
 * `host-executor.ts` — the one answer to "can the host make this call?".
 *
 * Every site that asks it (the approve route, the replay itself, the delivery
 * fallback) goes through `hostExecutorFor`, so a drift between them cannot
 * happen one call site at a time (TASK-1046). A connector toolKey reaches the
 * host only through `@ax/mcp-client`'s `connectors:call-tool`, never through a
 * `tool:execute:<key>`: every `tool:execute:*` is reachable from the sandbox
 * via `tool.execute-host`, and a credentialed host path to a third-party server
 * is exactly what the sandbox must not get.
 */
import { describe, expect, it } from 'vitest';
import { HookBus } from '@ax/core';
import {
  CONNECTOR_CALL_TOOL_HOOK,
  CONNECTOR_CALL_TOOL_KEY_RE,
  hostExecutorFor,
  hostExecutorForApproval,
} from '../host-executor.js';
import type { Attendance } from '../types.js';

/** `c5e0235982f` is the namespace literal @ax/connectors' tests pin. */
const CONNECTOR_KEY = 'mcp.c5e0235982f.save_comment';
const PLAIN = 'request_capability';

function busWith(...hooks: string[]): HookBus {
  const bus = new HookBus();
  for (const hook of hooks) {
    bus.registerService(hook, '@ax/decisions/test/producer', async () => ({}));
  }
  return bus;
}

/** The two fields of a decision row the helper reads. Held from a task run unless told otherwise. */
function held(name: string, attendance: Attendance = 'unattended') {
  return { call: { id: 'call-1', name, input: {} }, attendance };
}

describe('hostExecutorFor', () => {
  it('names the hook @ax/mcp-client registers', () => {
    // Re-declared here, never imported (invariant 2). The k8s preset test pins
    // the producer's side of the same literal.
    expect(CONNECTOR_CALL_TOOL_HOOK).toBe('connectors:call-tool');
  });

  it.each([
    ['a connector key, connector hook present', CONNECTOR_KEY, ['connectors:call-tool'], { kind: 'connector' }],
    ['a connector key, connector hook absent', CONNECTOR_KEY, [], null],
    [
      'a plain name, its tool:execute hook present',
      PLAIN,
      ['tool:execute:request_capability'],
      { kind: 'tool', hook: 'tool:execute:request_capability' },
    ],
    ['a plain name, its tool:execute hook absent', PLAIN, [], null],
  ] as const)('%s', (_label, name, hooks, expected) => {
    expect(hostExecutorFor(busWith(...hooks), held(name))).toEqual(expected);
  });

  it('a connector key never routes to tool:execute:<key>', () => {
    const bus = busWith('tool:execute:mcp.c5e0235982f.x');
    expect(hostExecutorFor(bus, held('mcp.c5e0235982f.x'))).toBeNull();
  });

  it('a connector key goes to the connector hook even when a tool:execute:<key> exists', () => {
    const bus = busWith('tool:execute:mcp.c5e0235982f.x', 'connectors:call-tool');
    expect(hostExecutorFor(bus, held('mcp.c5e0235982f.x'))).toEqual({ kind: 'connector' });
  });

  it('the connector hook makes no other tool host-executable', () => {
    expect(hostExecutorFor(busWith('connectors:call-tool'), held(PLAIN))).toBeNull();
    expect(hostExecutorFor(busWith('connectors:call-tool'), held('skill_propose'))).toBeNull();
  });
});

/**
 * Review F1. Host replay is for connector calls held during a TASK RUN. A call
 * held in a chat is `attended`: the person's conversation is where the agent
 * makes it. If the host made it after that session ended, the agent would
 * never learn: its next turn in the same thread re-issues the call, meets the
 * gate with the yes already spent, and the person gets a second card for a
 * call that already went out. So an attended connector call parks for the
 * agent (`approved-pending-agent`), exactly as it did before TASK-1046, and the
 * agent's own re-issued call cashes the yes once.
 */
describe('hostExecutorFor — an attended connector call stays the agent’s (review F1)', () => {
  it('an attended connector decision has no host executor, even with connectors:call-tool present', () => {
    const bus = busWith('connectors:call-tool');
    expect(hostExecutorFor(bus, held(CONNECTOR_KEY, 'attended'))).toBeNull();
    // The same key held from a task run is the host's to make.
    expect(hostExecutorFor(bus, held(CONNECTOR_KEY, 'unattended'))).toEqual({ kind: 'connector' });
  });

  it('an attended connector decision never falls through to a tool:execute:<key> either', () => {
    const bus = busWith('connectors:call-tool', `tool:execute:${CONNECTOR_KEY}`);
    expect(hostExecutorFor(bus, held(CONNECTOR_KEY, 'attended'))).toBeNull();
  });

  it('tool:execute:* is unchanged: an attended plain tool keeps its host executor', () => {
    // The TASK-277 fallback (session gone, the host makes the call) still
    // holds for a host tool. Only connector calls changed.
    const bus = busWith('tool:execute:request_capability', 'connectors:call-tool');
    expect(hostExecutorFor(bus, held(PLAIN, 'attended'))).toEqual({
      kind: 'tool',
      hook: 'tool:execute:request_capability',
    });
  });
});

/**
 * Review F2. The host sends a connector call's recorded input verbatim, so it
 * does so only on an approval whose surface showed the person the WHOLE
 * request. The card cuts a long one short ("This is only the beginning…"); a
 * yes to a beginning is not a yes to the rest. Only an explicit `true` lets the
 * host make it: absent, false or anything else parks, so a stale client or
 * another caller cannot trigger a host write.
 */
describe('hostExecutorForApproval — only a request shown whole reaches the host (review F2)', () => {
  const bus = busWith('connectors:call-tool', 'tool:execute:request_capability');

  it('a connector call the person saw in full goes to the host', () => {
    expect(hostExecutorForApproval(bus, held(CONNECTOR_KEY), { requestShownInFull: true })).toEqual({
      kind: 'connector',
    });
  });

  it.each([
    ['absent', {}],
    ['false', { requestShownInFull: false }],
    ['a truthy string', { requestShownInFull: 'true' }],
    ['one', { requestShownInFull: 1 }],
  ])('a connector call parks when the flag is %s', (_label, approval) => {
    expect(hostExecutorForApproval(bus, held(CONNECTOR_KEY), approval)).toBeNull();
  });

  it('tool:execute:* is unaffected: a host tool runs whatever the flag says', () => {
    for (const approval of [{}, { requestShownInFull: false }, { requestShownInFull: true }]) {
      expect(hostExecutorForApproval(bus, held(PLAIN), approval)).toEqual({
        kind: 'tool',
        hook: 'tool:execute:request_capability',
      });
    }
  });

  it('the flag never makes a call host-executable that was not', () => {
    // An attended connector call (review F1) and a call with no executor stay null.
    expect(hostExecutorForApproval(bus, held(CONNECTOR_KEY, 'attended'), { requestShownInFull: true })).toBeNull();
    expect(hostExecutorForApproval(busWith(), held(CONNECTOR_KEY), { requestShownInFull: true })).toBeNull();
    expect(hostExecutorForApproval(bus, held('skill_propose'), { requestShownInFull: true })).toBeNull();
  });
});

/**
 * Review F5. `connectors:call-tool` accepts only the STRICT key shape, a tool
 * name of 1-128 printable ASCII characters, and answers `invalid-call` for
 * anything else. A key only the label parser accepts (`.+`: spaces, non-ASCII,
 * any length) would be routed to the host just to spend the person's yes on
 * that refusal. So such a key has no host executor: it parks for the agent.
 */
describe('hostExecutorFor — only the producer’s strict key shape reaches the host (review F5)', () => {
  it('is @ax/mcp-client’s own CONNECTOR_TOOL_KEY_RE, literal for literal', () => {
    // Re-declared, never imported (invariant 2). mcp-client's
    // connector-call-tool.test.ts pins its regex to this same literal.
    expect(CONNECTOR_CALL_TOOL_KEY_RE.source).toBe('^mcp\\.(c[0-9a-f]{10})\\.([\\x21-\\x7e]{1,128})$');
    expect(CONNECTOR_CALL_TOOL_KEY_RE.flags).toBe('');
  });

  const NS = 'mcp.c5e0235982f.';
  it.each([
    ['a non-ASCII tool name', `${NS}créer_problème`],
    ['a spaced tool name', `${NS}save comment`],
    ['a 129-character tool name', `${NS}${'a'.repeat(129)}`],
    ['a tool name with a newline', `${NS}save\ncomment`],
  ])('%s parks rather than replaying', (_label, name) => {
    const bus = busWith('connectors:call-tool', `tool:execute:${name}`);
    // It is still a connector key to the label parser…
    expect(hostExecutorFor(bus, held(name))).toBeNull();
    // …and never falls through to a `tool:execute:<key>` either.
    expect(hostExecutorForApproval(bus, held(name), { requestShownInFull: true })).toBeNull();
  });

  it('a 128-character printable tool name, the longest the producer takes, still goes to the host', () => {
    const bus = busWith('connectors:call-tool');
    expect(hostExecutorFor(bus, held(`${NS}${'a'.repeat(128)}`))).toEqual({ kind: 'connector' });
    expect(hostExecutorFor(bus, held(`${NS}linear.save_comment-v2`))).toEqual({ kind: 'connector' });
  });
});
