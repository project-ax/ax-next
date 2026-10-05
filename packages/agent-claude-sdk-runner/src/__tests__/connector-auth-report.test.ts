import { describe, it, expect } from 'vitest';
import { EventConnectorAuthFailureSchema } from '@ax/ipc-protocol';
import { createConnectorAuthReporter, type ConnectorAuthFailureReport } from '../connector-auth-report.js';

// TASK-842 — what the runner reports when a connector server refuses it.

const NS = 'c0123456789';
const NS2 = 'cabcdef0123';

function setup(send?: (r: ConnectorAuthFailureReport) => Promise<void>) {
  const sent: ConnectorAuthFailureReport[] = [];
  const logs: string[] = [];
  const reporter = createConnectorAuthReporter(
    send ??
      (async (r) => {
        sent.push(r);
      }),
    (line) => logs.push(line),
  );
  return { reporter, sent, logs };
}

describe('connector auth reporter', () => {
  it('reports connector servers the SDK started as needs-auth or failed, and nothing else', () => {
    const t = setup();
    t.reporter.onInit([
      { name: NS, status: 'failed' },
      { name: NS2, status: 'needs-auth' },
      { name: 'cfedcba9876', status: 'connected' },
      { name: 'cfedcba9877', status: 'pending' },
      // Ours, not connectors — never reported, whatever their status.
      { name: 'ax-host', status: 'failed' },
      { name: 'ax-sandbox', status: 'needs-auth' },
      { name: 'linear', status: 'failed' },
    ]);
    expect(t.sent).toEqual([
      {
        servers: [
          { toolNamespace: NS, status: 'failed' },
          { toolNamespace: NS2, status: 'needs-auth' },
        ],
      },
    ]);
    // What goes out is exactly what the host's wire schema accepts.
    expect(EventConnectorAuthFailureSchema.safeParse(t.sent[0]).success).toBe(true);
  });

  it('sends nothing for an all-healthy or malformed init, and reports a server once per process', () => {
    const t = setup();
    t.reporter.onInit([{ name: NS, status: 'connected' }]);
    t.reporter.onInit(undefined);
    t.reporter.onInit([null, 7, { name: 5, status: 'failed' }]);
    expect(t.sent).toEqual([]);
    t.reporter.onInit([{ name: NS, status: 'failed' }]);
    // A resumed query re-emits init: the same refusal is not sent twice.
    t.reporter.onInit([{ name: NS, status: 'failed' }]);
    expect(t.sent).toHaveLength(1);
  });

  it('a connector tool error mid-turn reports its server (once per turn); held calls and other tools do not', () => {
    const t = setup();
    t.reporter.onToolUse('u1', `mcp__${NS}__search_issues`);
    t.reporter.onToolUse('u2', `mcp__${NS}__create_issue`);
    t.reporter.onToolUse('u3', 'Bash');
    t.reporter.onToolUse('u4', 'mcp__ax-host__web_search');
    t.reporter.onToolUse('u5', `mcp__${NS2}__ping`);
    t.reporter.onToolResult('u3', true);
    t.reporter.onToolResult('u4', true);
    // A held call arrives with isError already false (main.ts excludes holds).
    t.reporter.onToolResult('u5', false);
    t.reporter.onToolResult('u1', true);
    t.reporter.onToolResult('u2', true);
    expect(t.sent).toEqual([{ servers: [{ toolNamespace: NS, status: 'tool-error' }] }]);

    t.reporter.endTurn();
    t.reporter.onToolUse('u6', `mcp__${NS}__search_issues`);
    t.reporter.onToolResult('u6', true);
    expect(t.sent).toHaveLength(2);
    expect(EventConnectorAuthFailureSchema.safeParse(t.sent[1]).success).toBe(true);
  });

  it('a successful connector tool result reports nothing', () => {
    const t = setup();
    t.reporter.onToolUse('u1', `mcp__${NS}__search_issues`);
    t.reporter.onToolResult('u1', false);
    t.reporter.onToolResult('unknown-id', true);
    expect(t.sent).toEqual([]);
  });

  it('a send that fails (or throws) is logged, never thrown into the turn', async () => {
    const rejecting = setup(async () => {
      throw new Error('host unreachable');
    });
    expect(() => rejecting.reporter.onInit([{ name: NS, status: 'failed' }])).not.toThrow();
    const throwing = setup(() => {
      throw new Error('sync boom');
    });
    expect(() => throwing.reporter.onInit([{ name: NS, status: 'failed' }])).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(rejecting.logs.join('\n')).toContain('host unreachable');
    expect(throwing.logs.join('\n')).toContain('sync boom');
  });
});
