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
import { CONNECTOR_CALL_TOOL_HOOK, hostExecutorFor } from '../host-executor.js';

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
    expect(hostExecutorFor(busWith(...hooks), name)).toEqual(expected);
  });

  it('a connector key never routes to tool:execute:<key>', () => {
    const bus = busWith('tool:execute:mcp.c5e0235982f.x');
    expect(hostExecutorFor(bus, 'mcp.c5e0235982f.x')).toBeNull();
  });

  it('a connector key goes to the connector hook even when a tool:execute:<key> exists', () => {
    const bus = busWith('tool:execute:mcp.c5e0235982f.x', 'connectors:call-tool');
    expect(hostExecutorFor(bus, 'mcp.c5e0235982f.x')).toEqual({ kind: 'connector' });
  });

  it('the connector hook makes no other tool host-executable', () => {
    expect(hostExecutorFor(busWith('connectors:call-tool'), PLAIN)).toBeNull();
    expect(hostExecutorFor(busWith('connectors:call-tool'), 'skill_propose')).toBeNull();
  });
});
