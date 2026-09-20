// @vitest-environment node
/**
 * Tier-A direct-handler tests for GET /api/workspace/grants (TASK-373).
 *
 * The route is thin on purpose — authenticate, read the caller's own rows off
 * the pending-card buffer, put them on the wire — so these tests are mostly
 * the "did we leak anybody?" checks the route exists to pass: a cross-tenant
 * read is an empty list and never a 403-vs-404 oracle, an unowned card is
 * never enumerable, and an answered grant stops being offered.
 *
 * The buffer is the REAL `createChunkBuffer()`, not a stub: the scoping
 * contract under test (owner recorded at append, filter in the accessor) is
 * the buffer's, and a stub would agree with whatever the route assumes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeWorkspaceHandlers } from '../../server/routes-workspace.js';
import { createChunkBuffer, type ChunkBuffer } from '../../server/chunk-buffer.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function mkReq(params: Record<string, string> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(_s: string) {
      /* unused */
    },
    end() {
      /* unused */
    },
  };
  return { res, captured };
}

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

const skill = (skillId: string) => ({
  kind: 'skill' as const,
  skillId,
  description: '',
  hosts: [],
  slots: [],
});

const connector = (connectorId: string) => ({
  kind: 'connector' as const,
  connectorId,
  name: connectorId,
  hosts: [],
  slots: [],
});

describe('GET /api/workspace/grants', () => {
  let bus: HookBus;
  let buffer: ChunkBuffer;
  /** The caller `auth:require-user` answers with. `null` = unauthenticated. */
  let caller: { id: string } | null;
  /**
   * One clock for the buffer's `raisedAt` and the decline route's
   * `declinedAt`. They are compared against each other, so a test that let
   * them drift would be testing two different worlds (TASK-444).
   */
  let clock: number;

  beforeEach(() => {
    bus = new HookBus();
    clock = 1_000_000;
    buffer = createChunkBuffer({ now: () => clock });
    caller = null;
    bus.registerService('auth:require-user', 'auth', async () => {
      if (caller === null) {
        throw new PluginError({
          code: 'unauthenticated',
          plugin: 'auth',
          message: 'no session',
        });
      }
      return { user: { id: caller.id, isAdmin: false } };
    });
  });

  afterEach(() => {
    buffer.dispose();
  });

  function handlers() {
    return makeWorkspaceHandlers({
      bus,
      initCtx,
      buffer,
      now: () => new Date(clock),
    });
  }

  async function read(user: { id: string } | null): Promise<CapturedRes> {
    caller = user;
    const { res, captured } = mkRes();
    await handlers().grants(mkReq(), res);
    return captured;
  }

  /** POST /api/workspace/grants/decline with a raw body. */
  async function decline(
    user: { id: string } | null,
    body: unknown,
  ): Promise<CapturedRes> {
    caller = user;
    const { res, captured } = mkRes();
    const req: RouteRequest = {
      ...mkReq(),
      body: Buffer.from(
        typeof body === 'string' ? body : JSON.stringify(body),
        'utf-8',
      ),
    };
    await handlers().declineGrant(req, res);
    return captured;
  }

  /** A KV store on the bus, the same shape @ax/storage-sqlite registers. */
  function registerStorage(
    opts: { listThrows?: boolean; noSet?: boolean } = {},
  ): Map<string, Uint8Array> {
    const store = new Map<string, Uint8Array>();
    if (opts.noSet !== true) {
      bus.registerService<{ key: string; value: Uint8Array }, void>(
        'storage:set',
        'storage',
        async (_ctx, { key, value }) => {
          store.set(key, value);
        },
      );
    }
    bus.registerService<
      { prefix: string },
      { entries: Array<{ key: string; value: Uint8Array }> }
    >('storage:list-prefix', 'storage', async (_ctx, { prefix }) => {
      if (opts.listThrows === true) throw new Error('kv is having a day');
      return {
        entries: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      };
    });
    return store;
  }

  it('returns only the caller’s own pending grants, with the conversation and agent', async () => {
    buffer.appendPermissionCard('cnv-ann', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });
    buffer.appendPermissionCard('cnv-ann', connector('github'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });

    const captured = await read({ id: 'u-ann' });
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      grants: [
        { conversationId: 'cnv-ann', agentId: 'a-quill', request: skill('linear') },
        {
          conversationId: 'cnv-ann',
          agentId: 'a-quill',
          request: connector('github'),
        },
      ],
    });
  });

  it('a second user reading the same deployment gets their own and never the first’s', async () => {
    // The leak this route exists to not have: a card's skill id, connector
    // name and hostnames all belong to somebody. Scoping ran at APPEND time
    // against the producer's identity, so there is no parameter a caller
    // could have supplied to widen this read even if the route wanted one.
    buffer.appendPermissionCard('cnv-ann', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });
    buffer.appendPermissionCard('cnv-bob', skill('github'), {
      userId: 'u-bob',
      agentId: 'a-scout',
    });

    const captured = await read({ id: 'u-bob' });
    expect(captured.statusCode).toBe(200);
    // u-bob's OWN row comes back; u-ann's does not. And "not yours" was never
    // a 403 or a 404 — it is the same 200 shape, so a caller cannot probe the
    // deployment into mapping which users hold which pending grants.
    expect(captured.body).toEqual({
      grants: [
        { conversationId: 'cnv-bob', agentId: 'a-scout', request: skill('github') },
      ],
    });

    // A second card of u-bob's lands beside it, still without u-ann's.
    buffer.appendPermissionCard('cnv-bob', skill('npm-scan'), {
      userId: 'u-bob',
      agentId: 'a-scout',
    });
    const again = await read({ id: 'u-bob' });
    expect(again.body).toEqual({
      grants: [
        { conversationId: 'cnv-bob', agentId: 'a-scout', request: skill('github') },
        {
          conversationId: 'cnv-bob',
          agentId: 'a-scout',
          request: skill('npm-scan'),
        },
      ],
    });
  });

  it('never enumerates an unowned card, and never enumerates a host card', async () => {
    // Unowned: buffered with no identity (a canary probe, an ephemeral admin
    // path) — replayable on its own stream, but attributing it to whoever
    // asked is the failure mode this route must not have.
    buffer.appendPermissionCard('cnv-x', skill('linear'));
    // Host: turn-scoped (the wall widens the LIVE session's allowlist), so a
    // stale one would offer a control that cannot do what it says — TASK-375,
    // deliberately out of here.
    buffer.appendPermissionCard('req-1', {
      kind: 'host',
      host: 'example.org',
      sessionId: 's-1',
    });

    const captured = await read({ id: 'u-ann' });
    expect(captured.body).toEqual({ grants: [] });
  });

  it('unauthenticated is 401', async () => {
    buffer.appendPermissionCard('cnv-ann', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });

    const captured = await read(null);
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({ error: 'unauthenticated' });
  });

  it('an answered grant is gone', async () => {
    buffer.appendPermissionCard('cnv-ann', skill('linear'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });
    buffer.appendPermissionCard('cnv-ann', skill('github'), {
      userId: 'u-ann',
      agentId: 'a-quill',
    });

    // The grant route (permission-decision) evicts through the same callback
    // plugin.ts wires to onCardResolved — the answer, not this route, ends a
    // grant's life.
    buffer.evictPermissionCard('cnv-ann', 'linear');

    const captured = await read({ id: 'u-ann' });
    expect(captured.body).toEqual({
      grants: [
        { conversationId: 'cnv-ann', agentId: 'a-quill', request: skill('github') },
      ],
    });
  });

  it('answers an empty list when no buffer is wired at all', async () => {
    // plugin.ts always passes one; this documents the handler-test posture.
    // A process with no pending-card store has no cards to offer, so `[]` is
    // the true answer rather than a failed read.
    const h = makeWorkspaceHandlers({ bus, initCtx });
    const { res, captured } = mkRes();
    caller = { id: 'u-ann' };
    await h.grants(mkReq(), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ grants: [] });
  });

  describe('POST /api/workspace/grants/decline (TASK-444)', () => {
    it('a declined grant is not handed back on the next workspace mount', async () => {
      /*
        THE ACCEPTANCE TEST. Before this card, "Not now" dropped the row in the
        browser and told nobody: the card was still in the buffer, so the very
        next mount read handed the same question back and the person had no way
        to tell except by reloading. Decline, then re-read the source of truth.
      */
      registerStorage();
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      const before = await read({ id: 'u-ann' });
      expect(before.body).toEqual({
        grants: [
          { conversationId: 'cnv-ann', agentId: 'a-quill', request: skill('linear') },
        ],
      });

      const posted = await decline(
        { id: 'u-ann' },
        { agentId: 'a-quill', kind: 'skill', subjectId: 'linear' },
      );
      expect(posted.statusCode).toBe(200);
      expect(posted.body).toEqual({ declined: true });

      const after = await read({ id: 'u-ann' });
      expect(after.statusCode).toBe(200);
      expect(after.body).toEqual({ grants: [] });
    });

    it('a connector grant declines the same way', async () => {
      registerStorage();
      buffer.appendPermissionCard('cnv-ann', connector('github'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      const posted = await decline(
        { id: 'u-ann' },
        { agentId: 'a-quill', kind: 'connector', subjectId: 'github' },
      );
      expect(posted.statusCode).toBe(200);
      expect((await read({ id: 'u-ann' })).body).toEqual({ grants: [] });
    });

    it('the deferral is need-triggered, not time-triggered: only a fresh ask brings it back', async () => {
      registerStorage();
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });
      await decline(
        { id: 'u-ann' },
        { agentId: 'a-quill', kind: 'skill', subjectId: 'linear' },
      );
      expect((await read({ id: 'u-ann' })).body).toEqual({ grants: [] });

      // A week of wall-clock goes by with nothing asking for the skill. The
      // grant MUST stay down — this is the assertion that there is no timer
      // and no `deferred_until` hiding anywhere in the path.
      clock += 7 * 24 * 60 * 60 * 1000;
      expect((await read({ id: 'u-ann' })).body).toEqual({ grants: [] });

      // Now the agent genuinely needs it again and re-proposes. The card is
      // re-stamped, its `raisedAt` outranks the older decline, and the
      // question comes back — no write, no expiry, no second decision.
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });
      expect((await read({ id: 'u-ann' })).body).toEqual({
        grants: [
          { conversationId: 'cnv-ann', agentId: 'a-quill', request: skill('linear') },
        ],
      });
    });

    it('declining leaves the person’s OTHER pending grants alone', async () => {
      registerStorage();
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });
      buffer.appendPermissionCard('cnv-ann', skill('github'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      await decline(
        { id: 'u-ann' },
        { agentId: 'a-quill', kind: 'skill', subjectId: 'linear' },
      );

      expect((await read({ id: 'u-ann' })).body).toEqual({
        grants: [
          { conversationId: 'cnv-ann', agentId: 'a-quill', request: skill('github') },
        ],
      });
    });

    it('a subjectId full of separators cannot suppress a different grant', async () => {
      /*
        Both of these spell the SAME storage key if the segments are pasted in
        raw — `…:u-ann:a:skill:evil:skill:s`. Declining one would then silently
        answer the other, on a different agent, and nothing on screen would say
        so. Every id here came out of an agent-authored manifest.
      */
      registerStorage();
      buffer.appendPermissionCard('cnv-1', skill('s'), {
        userId: 'u-ann',
        agentId: 'a:skill:evil',
      });
      buffer.appendPermissionCard('cnv-2', skill('evil:skill:s'), {
        userId: 'u-ann',
        agentId: 'a',
      });

      await decline(
        { id: 'u-ann' },
        { agentId: 'a:skill:evil', kind: 'skill', subjectId: 's' },
      );

      expect((await read({ id: 'u-ann' })).body).toEqual({
        grants: [
          {
            conversationId: 'cnv-2',
            agentId: 'a',
            request: skill('evil:skill:s'),
          },
        ],
      });
    });

    it('declining a grant that is not pending is 404', async () => {
      registerStorage();
      const captured = await decline(
        { id: 'u-ann' },
        { agentId: 'a-quill', kind: 'skill', subjectId: 'linear' },
      );
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'grant-not-pending' });
    });

    it('declining somebody else’s pending grant is the same 404, never a 403', async () => {
      /*
        A 403 would confirm the grant exists and belongs to someone. The probe
        and the genuine miss have to be one answer — the same posture the GET
        takes with its empty list.
      */
      const store = registerStorage();
      buffer.appendPermissionCard('cnv-bob', skill('linear'), {
        userId: 'u-bob',
        agentId: 'a-scout',
      });

      const captured = await decline(
        { id: 'u-ann' },
        { agentId: 'a-scout', kind: 'skill', subjectId: 'linear' },
      );
      expect(captured.statusCode).toBe(404);
      expect(captured.body).toEqual({ error: 'grant-not-pending' });
      // And nothing was written — a failed probe must not leave a marker that
      // would later suppress the real owner's grant.
      expect(store.size).toBe(0);
      expect((await read({ id: 'u-bob' })).body).toEqual({
        grants: [
          { conversationId: 'cnv-bob', agentId: 'a-scout', request: skill('linear') },
        ],
      });
    });

    it('the agentId on the wire is checked against the pending card, not trusted', async () => {
      registerStorage();
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      const captured = await decline(
        { id: 'u-ann' },
        { agentId: 'a-someone-else', kind: 'skill', subjectId: 'linear' },
      );
      expect(captured.statusCode).toBe(404);
    });

    it('without a KV store the decline is 503 and the grant comes back', async () => {
      // Never a silent success: a refusal we failed to record is a refusal
      // that will be asked again, and the person is told so now rather than
      // discovering it on the next mount.
      registerStorage({ noSet: true });
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      const captured = await decline(
        { id: 'u-ann' },
        { agentId: 'a-quill', kind: 'skill', subjectId: 'linear' },
      );
      expect(captured.statusCode).toBe(503);
      expect(captured.body).toEqual({ error: 'declines-unavailable' });
      expect((await read({ id: 'u-ann' })).body).toEqual({
        grants: [
          { conversationId: 'cnv-ann', agentId: 'a-quill', request: skill('linear') },
        ],
      });
    });

    it('with no KV store at all the grants read behaves exactly as it did before', async () => {
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });
      expect((await read({ id: 'u-ann' })).body).toEqual({
        grants: [
          { conversationId: 'cnv-ann', agentId: 'a-quill', request: skill('linear') },
        ],
      });
    });

    it('a KV read that throws leaves the list unfiltered rather than empty', async () => {
      // Losing the grants list entirely is worse than re-asking one question:
      // the person cannot answer what they cannot see.
      registerStorage({ listThrows: true });
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      const captured = await read({ id: 'u-ann' });
      expect(captured.statusCode).toBe(200);
      expect(captured.body).toEqual({
        grants: [
          { conversationId: 'cnv-ann', agentId: 'a-quill', request: skill('linear') },
        ],
      });
    });

    it('a malformed body is 400, and a kind we do not know is 400', async () => {
      registerStorage();
      expect((await decline({ id: 'u-ann' }, 'not json at all')).statusCode).toBe(400);
      expect((await decline({ id: 'u-ann' }, { agentId: 'a-quill' })).statusCode).toBe(
        400,
      );
      const badKind = await decline(
        { id: 'u-ann' },
        { agentId: 'a-quill', kind: 'host', subjectId: 'example.org' },
      );
      expect(badKind.statusCode).toBe(400);
      expect(badKind.body).toEqual({ error: 'invalid-grant' });
    });

    it('unauthenticated is 401 before anything is read or written', async () => {
      const store = registerStorage();
      buffer.appendPermissionCard('cnv-ann', skill('linear'), {
        userId: 'u-ann',
        agentId: 'a-quill',
      });

      const captured = await decline(null, {
        agentId: 'a-quill',
        kind: 'skill',
        subjectId: 'linear',
      });
      expect(captured.statusCode).toBe(401);
      expect(store.size).toBe(0);
    });
  });
});
