import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  isOwnerlessId,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  AgentConfig,
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createListener, type Listener } from '../listener.js';

// ---------------------------------------------------------------------------
// TASK-411 — two owner-less sessions must not share a workspace tree.
//
// The unix-socket half of the same bug @ax/ipc-http's
// `ownerless-tenant-isolation.test.ts` pins for TCP. When
// `session:resolve-token` resolved a session with no owner (canary /
// `ax serve` / pre-9.5), this listener stamped the CONSTANT `'ipc-server'`
// into `ctx.agentId` / `ctx.userId`. Every agent-partitioned store keys on
// the agent id (`sha256(JSON.stringify([agentId]))` in both workspace
// backends and both memory-index backends), so one literal meant ONE
// partition shared by every owner-less session in the deployment.
//
// THE ASYMMETRY IS THE POINT OF HAVING BOTH FILES. The guards that DID check
// for an unbound owner — `skill.propose` and `connector_propose` — spelled out
// `'ipc-server'` and never `'ipc-http'`, so whatever protection they gave was
// half-missing on the transport that serves production (k8s runs over TCP).
// Two literals meant two chances to get the set wrong; a guard naming one and
// not the other is the pooling bug in miniature. Both files now assert the
// same properties, and neither transport's old literal survives.
//
// DIRECTION PINNED, and ANTI-VACUITY: see the header of the @ax/ipc-http
// sibling. Short version — an owner-less session gets an EMPTY workspace, not
// another session's; the cases labelled ANTI-VACUITY pass before AND after the
// fix on purpose, because a backend that answered "not found" to everybody, or
// one that partitioned per session rather than per agent, would each pass half
// of this file and be broken.
//
// One structural difference from the TCP sibling: this listener binds ONE unix
// socket per session and enforces a cross-session gate, so each session needs
// its own listener. They share a bus, which is what a single host process
// looks like — and is what made the pooling reachable in the first place.
// ---------------------------------------------------------------------------

const AGENT_CONFIG: AgentConfig = {
  displayName: 'Test Agent',
  systemPromptAugment: '',
  allowedTools: [],
  mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk',
};

const SECRET_PATH = 'notes/secret.txt';

interface SessionHandle {
  sessionId: string;
  socketPath: string;
  token: string;
}

interface Fixture {
  /** agentId -> path -> contents. The modelled per-agent partition. */
  trees: Map<string, Map<string, string>>;
  /** The `ctx.agentId` the listener stamped for a given sessionId. */
  agentIdFor: Map<string, string>;
  openSession: (opts: {
    sessionId: string;
    owner?: { userId: string; agentId: string };
  }) => Promise<SessionHandle>;
  close: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const harness = await createTestHarness({
    plugins: [createSessionInmemoryPlugin()],
  });
  const trees = new Map<string, Map<string, string>>();
  const agentIdFor = new Map<string, string>();
  const listeners: Listener[] = [];
  const tempDirs: string[] = [];

  harness.bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    'stub-partitioned-workspace',
    async (ctx, input) => {
      agentIdFor.set(ctx.sessionId, ctx.agentId);
      const contents = trees.get(ctx.agentId)?.get(input.path);
      if (contents === undefined) return { found: false };
      return { found: true, bytes: Buffer.from(contents, 'utf8') };
    },
  );

  return {
    trees,
    agentIdFor,
    openSession: async ({ sessionId, owner }) => {
      const { token } = await harness.bus.call<
        SessionCreateInput,
        SessionCreateOutput
      >('session:create', harness.ctx(), {
        sessionId,
        workspaceRoot: '/tmp/ws',
        ...(owner !== undefined
          ? { owner: { ...owner, agentConfig: AGENT_CONFIG } }
          : {}),
      });
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ownerless-'));
      tempDirs.push(dir);
      const socketPath = path.join(dir, 'ipc.sock');
      listeners.push(
        await createListener({ socketPath, sessionId, bus: harness.bus }),
      );
      return { sessionId, socketPath, token };
    },
    close: async () => {
      for (const l of listeners) await l.close();
      for (const d of tempDirs) {
        await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
      }
      await harness.close({ onError: () => {} });
    },
  };
}

interface Response {
  status: number;
  body: string;
}

function postJson(
  socketPath: string,
  reqPath: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        socketPath,
        path: reqPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(buf.length),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function readWorkspace(
  s: SessionHandle,
): Promise<{ found: boolean; text?: string }> {
  const res = await postJson(s.socketPath, '/workspace.read', s.token, {
    path: SECRET_PATH,
  });
  expect(res.status).toBe(200);
  const body = JSON.parse(res.body) as
    | { found: true; bytesBase64: string }
    | { found: false };
  if (!body.found) return { found: false };
  return {
    found: true,
    text: Buffer.from(body.bytesBase64, 'base64').toString('utf8'),
  };
}

function seedPartitionOf(fx: Fixture, sessionId: string, contents: string): void {
  const agentId = fx.agentIdFor.get(sessionId);
  expect(agentId, `no workspace:read recorded for ${sessionId}`).toBeDefined();
  const tree = fx.trees.get(agentId as string) ?? new Map<string, string>();
  tree.set(SECRET_PATH, contents);
  fx.trees.set(agentId as string, tree);
}

describe('@ax/ipc-server: owner-less sessions do not share a workspace tree', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    await fx?.close();
    fx = null;
  });

  it('two owner-less sessions are served under DIFFERENT agent ids', async () => {
    fx = await makeFixture();
    const s1 = await fx.openSession({ sessionId: 's-ownerless-1' });
    const s2 = await fx.openSession({ sessionId: 's-ownerless-2' });

    await readWorkspace(s1);
    await readWorkspace(s2);

    const a1 = fx.agentIdFor.get('s-ownerless-1');
    const a2 = fx.agentIdFor.get('s-ownerless-2');
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    // The bug, stated as an assertion: these were BOTH the literal
    // 'ipc-server'.
    expect(a1).not.toBe(a2);
  });

  it("an owner-less session cannot read another owner-less session's file", async () => {
    fx = await makeFixture();
    const a = await fx.openSession({ sessionId: 's-tenant-a' });
    const b = await fx.openSession({ sessionId: 's-tenant-b' });

    expect((await readWorkspace(a)).found).toBe(false);
    seedPartitionOf(fx, 's-tenant-a', 'tenant A private data');

    expect(await readWorkspace(a)).toEqual({
      found: true,
      text: 'tenant A private data',
    });
    expect(await readWorkspace(b)).toEqual({ found: false });
  });

  it('stamps an OWNER-LESS-marked id, not a transport-named constant', async () => {
    fx = await makeFixture();
    const s = await fx.openSession({ sessionId: 's-marked' });
    await readWorkspace(s);

    const agentId = fx.agentIdFor.get('s-marked') as string;
    expect(isOwnerlessId(agentId)).toBe(true);
    // Both literals, on both transports. The historic guards named one and
    // not the other; asserting both here is what makes the asymmetry gone
    // rather than relocated.
    expect(agentId).not.toBe('ipc-server');
    expect(agentId).not.toBe('ipc-http');
  });

  it('ANTI-VACUITY: an OWNED session still reads its own agent file', async () => {
    fx = await makeFixture();
    const s = await fx.openSession({
      sessionId: 's-owned',
      owner: { userId: 'usr_1', agentId: 'agt_real_a' },
    });
    fx.trees.set('agt_real_a', new Map([[SECRET_PATH, 'agent A file']]));

    expect(await readWorkspace(s)).toEqual({
      found: true,
      text: 'agent A file',
    });
    expect(fx.agentIdFor.get('s-owned')).toBe('agt_real_a');
  });

  it('ANTI-VACUITY: two sessions of the SAME agent share one tree', async () => {
    fx = await makeFixture();
    const s1 = await fx.openSession({
      sessionId: 's-same-agent-1',
      owner: { userId: 'usr_1', agentId: 'agt_real_a' },
    });
    // A different USER reaching the same agent: the partition is agentId
    // alone (TASK-257), so a team agent's files stay shared.
    const s2 = await fx.openSession({
      sessionId: 's-same-agent-2',
      owner: { userId: 'usr_2', agentId: 'agt_real_a' },
    });
    fx.trees.set('agt_real_a', new Map([[SECRET_PATH, 'shared agent file']]));

    expect(await readWorkspace(s1)).toEqual({
      found: true,
      text: 'shared agent file',
    });
    expect(await readWorkspace(s2)).toEqual({
      found: true,
      text: 'shared agent file',
    });
  });

  it('ANTI-VACUITY: a DIFFERENT owned agent still gets nothing', async () => {
    fx = await makeFixture();
    const other = await fx.openSession({
      sessionId: 's-owned-b',
      owner: { userId: 'usr_2', agentId: 'agt_real_b' },
    });
    fx.trees.set('agt_real_a', new Map([[SECRET_PATH, 'agent A file']]));

    expect(await readWorkspace(other)).toEqual({ found: false });
  });

  it('refuses skill.propose on an owner-less session (the ipc-server half of the asymmetry)', async () => {
    fx = await makeFixture();
    const s = await fx.openSession({ sessionId: 's-propose' });

    const res = await postJson(s.socketPath, '/skill.propose', s.token, {
      manifestYaml: 'name: demo\ndescription: demo skill\n',
      bodyMd: '# demo',
      files: [],
      capabilityProposal: {
        allowedHosts: [],
        credentials: [],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      origin: 'authored',
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('not bound to a user+agent');
  });

  it('ANTI-VACUITY: skill.propose on an OWNED session is not blocked by the scope gate', async () => {
    fx = await makeFixture();
    const s = await fx.openSession({
      sessionId: 's-propose-owned',
      owner: { userId: 'usr_1', agentId: 'agt_real_a' },
    });

    const res = await postJson(s.socketPath, '/skill.propose', s.token, {
      manifestYaml: 'name: demo\ndescription: demo skill\n',
      bodyMd: '# demo',
      files: [],
      capabilityProposal: {
        allowedHosts: [],
        credentials: [],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      },
      origin: 'authored',
    });
    // Fails for a DIFFERENT reason (no skills:propose service on this bus) —
    // which is what proves the gate above is about the scope and not about
    // every skill.propose being rejected.
    expect(res.status).not.toBe(400);
    expect(res.body).not.toContain('not bound to a user+agent');
  });
});
