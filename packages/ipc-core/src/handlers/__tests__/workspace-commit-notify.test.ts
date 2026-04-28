import { describe, it, expect } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  reject,
  type AgentContext,
  type Plugin,
  type WorkspaceDelta,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { createMockWorkspacePlugin } from '@ax/test-harness';
import { workspaceCommitNotifyHandler } from '../workspace-commit-notify.js';

// ---------------------------------------------------------------------------
// workspace.commit-notify handler — direct unit tests
//
// These bypass the listener/dispatcher (no socket, no auth) and call the
// handler with a real HookBus + the MockWorkspace plugin registered for
// `workspace:apply` / `workspace:read`. That gives us a real round-trip
// through the bus exactly like the dispatcher would, without the framing
// noise — so failures point at handler logic, not transport.
//
// The dispatcher tests in `__tests__/dispatcher.test.ts` cover the
// auth/framing path and the previous stub shape; this file owns the
// real-impl semantics.
// ---------------------------------------------------------------------------

interface Env {
  bus: HookBus;
  ctx: AgentContext;
}

async function makeEnv(extraPlugins: Plugin[] = []): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createMockWorkspacePlugin(), ...extraPlugins],
    config: {},
  });
  const ctx = makeAgentContext({
    sessionId: 'wcn-test',
    agentId: 'wcn-agent',
    userId: 'wcn-user',
  });
  return { bus, ctx };
}

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('workspace.commit-notify handler', () => {
  it('happy path: applies changes, returns version, snapshot is queryable via workspace:read', async () => {
    const { bus, ctx } = await makeEnv();
    const helloBytes = enc.encode('hello world');

    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        commitRef: 'irrelevant-runner-token',
        message: 'turn 1',
        changes: [{ path: 'a.txt', kind: 'put', content: b64(helloBytes) }],
      },
      ctx,
      bus,
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      accepted: true;
      version: string;
      delta: null;
    };
    expect(body.accepted).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    // Wire NEVER carries the delta payload — see I5.
    expect(body.delta).toBeNull();

    // Confirm the snapshot landed by reading via the bus.
    const read = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      { path: 'a.txt' },
    );
    expect(read.found).toBe(true);
    if (read.found) {
      expect(Buffer.from(read.bytes).toString('utf8')).toBe('hello world');
    }
  });

  it('workspace:pre-apply rejection surfaces as 200 {accepted:false, reason}', async () => {
    const { bus, ctx } = await makeEnv();
    bus.subscribe('workspace:pre-apply', 'mock-policy', async () =>
      reject({ reason: 'secret detected' }),
    );

    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        commitRef: 'r',
        message: 'turn',
        changes: [{ path: 'a', kind: 'put', content: b64(enc.encode('1')) }],
      },
      ctx,
      bus,
    );

    expect(result.status).toBe(200);
    const body = result.body as { accepted: false; reason: string };
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe('secret detected');
  });

  it('parent mismatch: stale parentVersion → 200 {accepted:false, reason: "parent-mismatch: ..."}', async () => {
    const { bus, ctx } = await makeEnv();
    // First commit succeeds against parent: null.
    const first = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        commitRef: 'r1',
        message: 'first',
        changes: [{ path: 'a', kind: 'put', content: b64(enc.encode('1')) }],
      },
      ctx,
      bus,
    );
    expect(first.status).toBe(200);
    expect((first.body as { accepted: boolean }).accepted).toBe(true);

    // Second commit reuses parent: null — stale, MockWorkspace throws
    // PluginError({code: 'parent-mismatch'}); handler surfaces as accepted:false.
    const second = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        commitRef: 'r2',
        message: 'stale',
        changes: [{ path: 'b', kind: 'put', content: b64(enc.encode('2')) }],
      },
      ctx,
      bus,
    );

    expect(second.status).toBe(200);
    const body = second.body as { accepted: false; reason: string };
    expect(body.accepted).toBe(false);
    expect(body.reason).toMatch(/^parent-mismatch:/);
  });

  it('workspace:applied subscriber receives the delta', async () => {
    const { bus, ctx } = await makeEnv();
    let observed: WorkspaceDelta | null = null;
    bus.subscribe<WorkspaceDelta>('workspace:applied', 'observer', async (_c, payload) => {
      observed = payload;
      return undefined;
    });

    const helloBytes = enc.encode('hello');
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        commitRef: 'r',
        message: 'turn 1',
        changes: [{ path: 'greeting.txt', kind: 'put', content: b64(helloBytes) }],
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);

    expect(observed).not.toBeNull();
    const delta = observed as unknown as WorkspaceDelta;
    expect(delta.before).toBeNull();
    // The delta's `after` matches the wire `version`.
    expect(delta.after).toBe((result.body as { version: string }).version);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ path: 'greeting.txt', kind: 'added' });
  });

  it('schema validation: malformed changes (missing path) → 400 VALIDATION', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        commitRef: 'r',
        message: 'turn',
        // Missing `path` on the put — Zod should reject.
        changes: [{ kind: 'put', content: b64(enc.encode('x')) }],
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
    const errBody = result.body as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe('VALIDATION');
    expect(errBody.error.message).toContain('workspace.commit-notify');
  });
});
