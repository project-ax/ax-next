import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { isOwnerlessId, type ToolDescriptor } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  AgentConfig,
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createListener, type Listener } from '../listener.js';

// ---------------------------------------------------------------------------
// TASK-411 — two owner-less sessions must not share an agent partition.
//
// The unix-socket half of the same bug @ax/ipc-http's
// `ownerless-tenant-isolation.test.ts` pins for TCP. When
// `session:resolve-token` resolved a session with no owner (canary /
// `ax serve` / pre-9.5), this listener stamped the CONSTANT `'ipc-server'`
// into `ctx.agentId` / `ctx.userId`. Agent-partitioned stores key on the agent
// id (`sha256(JSON.stringify([agentId]))` in both memory-index backends, as in
// the git workspace backends until TASK-995 removed them; the tool catalog
// filters per agent), so one literal meant ONE partition shared by every
// owner-less session in the deployment.
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
// sibling. Short version — an owner-less session gets an EMPTY partition, not
// another session's; the cases labelled ANTI-VACUITY pass before AND after the
// fix on purpose, because a store that answered "nothing" to everybody, or one
// that partitioned per session rather than per agent, would each pass half of
// this file and be broken. THE PROBE is `/tool.list` with a stub `tool:list`
// that records the `ctx.agentId` it was served under (TASK-995 retired the
// `/workspace.read` probe with the git workspace tier).
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

const PRIVATE_TOOL = 'tenant_private_tool';

interface SessionHandle {
  sessionId: string;
  socketPath: string;
  token: string;
}

interface Fixture {
  /** agentId -> the tool names in that agent's catalog. The modelled per-agent partition. */
  catalogs: Map<string, string[]>;
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
  const catalogs = new Map<string, string[]>();
  const agentIdFor = new Map<string, string>();
  const listeners: Listener[] = [];
  const tempDirs: string[] = [];

  harness.bus.registerService<Record<string, never>, { tools: ToolDescriptor[] }>(
    'tool:list',
    'stub-partitioned-catalog',
    async (ctx) => {
      agentIdFor.set(ctx.sessionId, ctx.agentId);
      const names = catalogs.get(ctx.agentId) ?? [];
      return {
        tools: names.map((name) => ({
          name,
          inputSchema: { type: 'object' },
          executesIn: 'host' as const,
        })),
      };
    },
  );

  return {
    catalogs,
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

/** The tool names the session's partition holds, as `/tool.list` reports them. */
async function listTools(s: SessionHandle): Promise<string[]> {
  const res = await postJson(s.socketPath, '/tool.list', s.token, {});
  expect(res.status).toBe(200);
  const body = JSON.parse(res.body) as { tools: Array<{ name: string }> };
  return body.tools.map((t) => t.name);
}

function seedPartitionOf(fx: Fixture, sessionId: string, toolName: string): void {
  const agentId = fx.agentIdFor.get(sessionId);
  expect(agentId, `no tool:list recorded for ${sessionId}`).toBeDefined();
  const catalog = fx.catalogs.get(agentId as string) ?? [];
  catalog.push(toolName);
  fx.catalogs.set(agentId as string, catalog);
}

describe('@ax/ipc-server: owner-less sessions do not share an agent partition', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    await fx?.close();
    fx = null;
  });

  it('two owner-less sessions are served under DIFFERENT agent ids', async () => {
    fx = await makeFixture();
    const s1 = await fx.openSession({ sessionId: 's-ownerless-1' });
    const s2 = await fx.openSession({ sessionId: 's-ownerless-2' });

    await listTools(s1);
    await listTools(s2);

    const a1 = fx.agentIdFor.get('s-ownerless-1');
    const a2 = fx.agentIdFor.get('s-ownerless-2');
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    // The bug, stated as an assertion: these were BOTH the literal
    // 'ipc-server'.
    expect(a1).not.toBe(a2);
  });

  it("an owner-less session cannot see another owner-less session's partition", async () => {
    fx = await makeFixture();
    const a = await fx.openSession({ sessionId: 's-tenant-a' });
    const b = await fx.openSession({ sessionId: 's-tenant-b' });

    expect(await listTools(a)).toEqual([]);
    seedPartitionOf(fx, 's-tenant-a', PRIVATE_TOOL);

    expect(await listTools(a)).toEqual([PRIVATE_TOOL]);
    expect(await listTools(b)).toEqual([]);
  });

  it('stamps an OWNER-LESS-marked id, not a transport-named constant', async () => {
    fx = await makeFixture();
    const s = await fx.openSession({ sessionId: 's-marked' });
    await listTools(s);

    const agentId = fx.agentIdFor.get('s-marked') as string;
    expect(isOwnerlessId(agentId)).toBe(true);
    // Both literals, on both transports. The historic guards named one and
    // not the other; asserting both here is what makes the asymmetry gone
    // rather than relocated.
    expect(agentId).not.toBe('ipc-server');
    expect(agentId).not.toBe('ipc-http');
  });

  it("ANTI-VACUITY: an OWNED session still sees its own agent's partition", async () => {
    fx = await makeFixture();
    const s = await fx.openSession({
      sessionId: 's-owned',
      owner: { userId: 'usr_1', agentId: 'agt_real_a' },
    });
    fx.catalogs.set('agt_real_a', [PRIVATE_TOOL]);

    expect(await listTools(s)).toEqual([PRIVATE_TOOL]);
    expect(fx.agentIdFor.get('s-owned')).toBe('agt_real_a');
  });

  it('ANTI-VACUITY: two sessions of the SAME agent share one partition', async () => {
    fx = await makeFixture();
    const s1 = await fx.openSession({
      sessionId: 's-same-agent-1',
      owner: { userId: 'usr_1', agentId: 'agt_real_a' },
    });
    // A different USER reaching the same agent: the partition is agentId
    // alone (TASK-257), so a team agent's data stays shared.
    const s2 = await fx.openSession({
      sessionId: 's-same-agent-2',
      owner: { userId: 'usr_2', agentId: 'agt_real_a' },
    });
    fx.catalogs.set('agt_real_a', [PRIVATE_TOOL]);

    expect(await listTools(s1)).toEqual([PRIVATE_TOOL]);
    expect(await listTools(s2)).toEqual([PRIVATE_TOOL]);
  });

  it('ANTI-VACUITY: a DIFFERENT owned agent still gets nothing', async () => {
    fx = await makeFixture();
    const other = await fx.openSession({
      sessionId: 's-owned-b',
      owner: { userId: 'usr_2', agentId: 'agt_real_b' },
    });
    fx.catalogs.set('agt_real_a', [PRIVATE_TOOL]);

    expect(await listTools(other)).toEqual([]);
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
