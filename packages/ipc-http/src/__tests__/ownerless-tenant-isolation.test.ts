import * as http from 'node:http';
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
import { createHttpListener, type HttpListener } from '../listener.js';

// ---------------------------------------------------------------------------
// TASK-411 — two owner-less sessions must not share a workspace tree.
//
// THE BUG. When `session:resolve-token` resolved a session with no owner
// (canary / `ax serve` / pre-9.5), this listener stamped the CONSTANT
// `'ipc-http'` into `ctx.agentId` and `ctx.userId`. Every agent-partitioned
// store in the deployment keys on the agent id — @ax/workspace-git-core and
// @ax/workspace-git-server both derive their repo from
// `sha256(JSON.stringify([agentId]))`, and both memory-index backends carry
// the same derivation — so ONE literal meant ONE partition, shared by every
// owner-less session in the deployment, across every user.
//
// It is the same cross-tenant pooling #583 closed for an ABSENT agent scope,
// reached through a different door: a value that LOOKS like an id. Any guard
// phrased "is there an agent id?" answers yes, which is exactly why it
// survived #583.
//
// WHAT THIS FILE PINS, AND IN WHICH DIRECTION. Two things, deliberately:
//
//   1. NO POOLING — two owner-less sessions land in different partitions, so
//      one cannot read the other's bytes. This holds in every store that keys
//      on the agent id, including stores that have never heard of
//      `isOwnerlessId`, because the substituted id is now per-session.
//   2. FAIL CLOSED — the substituted id is MARKED owner-less, so a store that
//      requires a real owner refuses outright instead of serving a private
//      bucket. We assert the marking here (the listener is what stamps it);
//      the refusal itself is asserted where it lives, in
//      `@ax/workspace-git-core`'s `__tests__/tenant-isolation.test.ts`.
//
//   An EMPTY workspace is the correct answer for an owner-less session. It
//   gets nothing. Another session's file is never the correct answer.
//
// ANTI-VACUITY. A backend that answered "not found" to everybody, or one that
// partitioned per SESSION rather than per AGENT, would each pass half of this
// file and be broken. The three cases labelled `ANTI-VACUITY` below pass both
// before and after the fix, on purpose: they are the assertions that keep the
// cross-tenant ones honest. Every OTHER case in this file fails against
// unfixed code. (Same discipline as #583's `tenant-isolation.test.ts`.)
//
// THE STUB BACKEND models a partitioned store the cheapest honest way: a Map
// keyed by `ctx.agentId`. That is what `sha256(JSON.stringify([agentId]))`
// buys, minus the hashing — two callers share a tree iff they present the
// same agent id. We deliberately do NOT re-implement the hash here; a fourth
// copy of that derivation would be a lockstep liability, and hashing distinct
// inputs to distinct buckets is not the property under test.
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

interface Fixture {
  listener: HttpListener;
  /** agentId -> path -> contents. The modelled per-agent partition. */
  trees: Map<string, Map<string, string>>;
  /** Every `ctx.agentId` a workspace:read has been served under, in order. */
  seenAgentIds: string[];
  /** The `ctx.agentId` the listener stamped for a given sessionId. */
  agentIdFor: Map<string, string>;
  createSession: (opts: {
    sessionId: string;
    owner?: { userId: string; agentId: string };
  }) => Promise<string>;
  close: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const harness = await createTestHarness({
    plugins: [createSessionInmemoryPlugin()],
  });
  const trees = new Map<string, Map<string, string>>();
  const seenAgentIds: string[] = [];
  const agentIdFor = new Map<string, string>();

  harness.bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    'stub-partitioned-workspace',
    async (ctx, input) => {
      seenAgentIds.push(ctx.agentId);
      agentIdFor.set(ctx.sessionId, ctx.agentId);
      const contents = trees.get(ctx.agentId)?.get(input.path);
      if (contents === undefined) return { found: false };
      return { found: true, bytes: Buffer.from(contents, 'utf8') };
    },
  );

  const listener = await createHttpListener({
    host: '127.0.0.1',
    port: 0,
    bus: harness.bus,
  });

  return {
    listener,
    trees,
    seenAgentIds,
    agentIdFor,
    createSession: async ({ sessionId, owner }) => {
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
      return token;
    },
    close: async () => {
      await listener.close();
      await harness.close({ onError: () => {} });
    },
  };
}

interface Response {
  status: number;
  body: string;
}

function postJson(
  port: number,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
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
  fx: Fixture,
  token: string,
): Promise<{ found: boolean; text?: string }> {
  const res = await postJson(fx.listener.port, '/workspace.read', token, {
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

/** Put `contents` into whatever partition the given session was served under. */
function seedPartitionOf(fx: Fixture, sessionId: string, contents: string): void {
  const agentId = fx.agentIdFor.get(sessionId);
  expect(agentId, `no workspace:read recorded for ${sessionId}`).toBeDefined();
  const tree = fx.trees.get(agentId as string) ?? new Map<string, string>();
  tree.set(SECRET_PATH, contents);
  fx.trees.set(agentId as string, tree);
}

describe('@ax/ipc-http: owner-less sessions do not share a workspace tree', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    await fx?.close();
    fx = null;
  });

  it('two owner-less sessions are served under DIFFERENT agent ids', async () => {
    fx = await makeFixture();
    const t1 = await fx.createSession({ sessionId: 's-ownerless-1' });
    const t2 = await fx.createSession({ sessionId: 's-ownerless-2' });

    await readWorkspace(fx, t1);
    await readWorkspace(fx, t2);

    const a1 = fx.agentIdFor.get('s-ownerless-1');
    const a2 = fx.agentIdFor.get('s-ownerless-2');
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    // The bug, stated as an assertion: these were BOTH the literal 'ipc-http'.
    expect(a1).not.toBe(a2);
  });

  it("an owner-less session cannot read another owner-less session's file", async () => {
    fx = await makeFixture();
    const tA = await fx.createSession({ sessionId: 's-tenant-a' });
    const tB = await fx.createSession({ sessionId: 's-tenant-b' });

    // Session A reads once so we learn which partition it was given, then we
    // put A's file there — i.e. A wrote a file into its own workspace.
    expect((await readWorkspace(fx, tA)).found).toBe(false);
    seedPartitionOf(fx, 's-tenant-a', 'tenant A private data');

    // A can read its own file back.
    expect(await readWorkspace(fx, tA)).toEqual({
      found: true,
      text: 'tenant A private data',
    });

    // B must not. Before the fix, B presented the same 'ipc-http' id and got
    // A's bytes — a live cross-tenant read.
    expect(await readWorkspace(fx, tB)).toEqual({ found: false });
  });

  it('stamps an OWNER-LESS-marked id, not a transport-named constant', async () => {
    fx = await makeFixture();
    const token = await fx.createSession({ sessionId: 's-marked' });
    await readWorkspace(fx, token);

    const agentId = fx.agentIdFor.get('s-marked') as string;
    // FAIL-CLOSED direction: the id is recognisable as owner-less, so a store
    // that needs a real owner (both workspace backends) refuses rather than
    // minting a private bucket. Without the marking, the only property we
    // would have is "not pooled", which is weaker.
    expect(isOwnerlessId(agentId)).toBe(true);
    // Neither transport's old literal survives — asserting BOTH here is the
    // point: the historic guards named 'ipc-server' and silently ignored
    // 'ipc-http', which is this bug in miniature.
    expect(agentId).not.toBe('ipc-http');
    expect(agentId).not.toBe('ipc-server');
  });

  it('ANTI-VACUITY: an OWNED session still reads its own agent file', async () => {
    fx = await makeFixture();
    const token = await fx.createSession({
      sessionId: 's-owned',
      owner: { userId: 'usr_1', agentId: 'agt_real_a' },
    });
    fx.trees.set('agt_real_a', new Map([[SECRET_PATH, 'agent A file']]));

    expect(await readWorkspace(fx, token)).toEqual({
      found: true,
      text: 'agent A file',
    });
    expect(fx.agentIdFor.get('s-owned')).toBe('agt_real_a');
  });

  it('ANTI-VACUITY: two sessions of the SAME agent share one tree', async () => {
    fx = await makeFixture();
    const t1 = await fx.createSession({
      sessionId: 's-same-agent-1',
      owner: { userId: 'usr_1', agentId: 'agt_real_a' },
    });
    // A DIFFERENT user reaching the same agent — team agents share files, and
    // the partition is agentId alone (TASK-257). Over-partitioning per session
    // or per user would break that and still pass the cross-tenant cases.
    const t2 = await fx.createSession({
      sessionId: 's-same-agent-2',
      owner: { userId: 'usr_2', agentId: 'agt_real_a' },
    });
    fx.trees.set('agt_real_a', new Map([[SECRET_PATH, 'shared agent file']]));

    expect(await readWorkspace(fx, t1)).toEqual({
      found: true,
      text: 'shared agent file',
    });
    expect(await readWorkspace(fx, t2)).toEqual({
      found: true,
      text: 'shared agent file',
    });
  });

  it('ANTI-VACUITY: a DIFFERENT owned agent still gets nothing', async () => {
    fx = await makeFixture();
    const other = await fx.createSession({
      sessionId: 's-owned-b',
      owner: { userId: 'usr_2', agentId: 'agt_real_b' },
    });
    fx.trees.set('agt_real_a', new Map([[SECRET_PATH, 'agent A file']]));

    expect(await readWorkspace(fx, other)).toEqual({ found: false });
  });

  it('refuses skill.propose on an owner-less session (the ipc-http half of the asymmetry)', async () => {
    fx = await makeFixture();
    const token = await fx.createSession({ sessionId: 's-propose' });

    // @ax/ipc-core's skill.propose guard used to test the literal
    // 'ipc-server', which THIS transport never stamps — so an owner-less
    // session over TCP (the k8s transport, i.e. the one serving production)
    // sailed past it and reached `skills:propose` with a placeholder owner.
    // No `skills:propose` service is registered on this bus, so reaching the
    // bus at all is itself observable: it would be a 500, never this 400.
    const res = await postJson(fx.listener.port, '/skill.propose', token, {
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
    const token = await fx.createSession({
      sessionId: 's-propose-owned',
      owner: { userId: 'usr_1', agentId: 'agt_real_a' },
    });

    const res = await postJson(fx.listener.port, '/skill.propose', token, {
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
    // It fails for a DIFFERENT reason (no skills:propose service on this bus),
    // which is what proves the gate above is about the scope and not about
    // every skill.propose being rejected.
    expect(res.status).not.toBe(400);
    expect(res.body).not.toContain('not bound to a user+agent');
  });
});
