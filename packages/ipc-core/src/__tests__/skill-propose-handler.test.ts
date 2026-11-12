import { describe, it, expect } from 'vitest';
import {
  createLogger,
  HookBus,
  makeAgentContext,
  ownerlessIdFor,
  PluginError,
  type AgentContext,
  type AgentContextSource,
} from '@ax/core';
import { SKILL_PROPOSE_REASON_MAX, SkillProposeResponseSchema } from '@ax/ipc-protocol';
import { MANIFEST_CODES } from '@ax/skills-parser';
import { hookRejected } from '../errors.js';
import { skillProposeHandler } from '../handlers/skill-propose.js';

const emptyCaps = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

const validPayload = {
  manifestYaml: 'name: commit-style\ndescription: how we write commits\nversion: 1',
  bodyMd: '# body',
  files: [],
  capabilityProposal: emptyCaps,
  origin: 'authored' as const,
};

function boundCtx(): AgentContext {
  return makeAgentContext({ sessionId: 's1', agentId: 'a1', userId: 'u1' });
}

// A bound ctx whose logger records every structured entry, so a test can
// assert what the host actually logged (and that the reqId rode along).
function loggedCtx(): { ctx: AgentContext; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const reqId = 'req-skillpropose';
  const logger = createLogger({
    reqId,
    writer: (line) => entries.push(JSON.parse(line) as Record<string, unknown>),
  });
  return {
    ctx: makeAgentContext({ reqId, sessionId: 's1', agentId: 'a1', userId: 'u1', logger }),
    entries,
  };
}

function busWithPropose(
  impl: (ctx: AgentContext, input: unknown) => Promise<unknown>,
): HookBus {
  const bus = new HookBus();
  bus.registerService('skills:propose', '@test/skills', impl as never);
  return bus;
}

describe('skill.propose handler (TASK-74)', () => {
  it('forwards a valid proposal to skills:propose with ctx-derived scope, returns the verdict', async () => {
    let seen: { ownerUserId: string; agentId: string; origin: string } | undefined;
    const bus = busWithPropose(async (_ctx, input) => {
      seen = input as never;
      return { skillId: 'commit-style', status: 'active' };
    });
    const r = await skillProposeHandler(validPayload, boundCtx(), bus);
    expect(r.status).toBe(200);
    expect((r as { body: unknown }).body).toEqual({ skillId: 'commit-style', status: 'active' });
    // Scope comes from ctx (the session), not the wire body.
    expect(seen).toMatchObject({ ownerUserId: 'u1', agentId: 'a1', origin: 'authored' });
  });

  it('passes a quarantine reason through', async () => {
    const bus = busWithPropose(async () => ({
      skillId: 'evil',
      status: 'quarantined',
      reason: 'flagged',
    }));
    const r = await skillProposeHandler(validPayload, boundCtx(), bus);
    expect((r as { body: unknown }).body).toEqual({
      skillId: 'evil',
      status: 'quarantined',
      reason: 'flagged',
    });
  });

  it('TASK-781: clamps an over-long scan reason to the wire ceiling instead of 500ing', async () => {
    // The reason is skill-safety-scan text (plugin code), so its length is not
    // ours to promise. Put an astral character straddling the cut: a plain
    // slice would leave a lone high surrogate.
    const long = 'x'.repeat(SKILL_PROPOSE_REASON_MAX - 1) + '\u{1F6AB}' + 'tail';
    const bus = busWithPropose(async () => ({
      skillId: 'evil',
      status: 'quarantined',
      reason: long,
    }));
    const r = await skillProposeHandler(validPayload, boundCtx(), bus);
    expect(r.status).toBe(200);
    const body = (r as { body: { reason: string } }).body;
    expect(body.reason).toBe('x'.repeat(SKILL_PROPOSE_REASON_MAX - 1));
    expect(SkillProposeResponseSchema.safeParse(body).success).toBe(true);
  });

  it('400s a malformed payload (no skills:propose call)', async () => {
    let called = false;
    const bus = busWithPropose(async () => {
      called = true;
      return { skillId: 'x', status: 'active' };
    });
    const r = await skillProposeHandler({ origin: 'authored' }, boundCtx(), bus);
    expect(r.status).toBe(400);
    expect(called).toBe(false);
  });

  it("rejects a runner-supplied origin other than 'authored' at the wire", async () => {
    const bus = busWithPropose(async () => ({ skillId: 'x', status: 'active' }));
    const r = await skillProposeHandler(
      { ...validPayload, origin: 'attached' },
      boundCtx(),
      bus,
    );
    expect(r.status).toBe(400);
  });

  it('rejects an unbound (owner-less) session — cannot author into a foreign scope', async () => {
    const bus = busWithPropose(async () => ({ skillId: 'x', status: 'active' }));
    const unbound = makeAgentContext({
      sessionId: 's',
      agentId: ownerlessIdFor('s'),
      userId: ownerlessIdFor('s'),
    });
    const r = await skillProposeHandler(validPayload, unbound, bus);
    expect(r.status).toBe(400);
  });

  it('rejects an owner-less session whatever transport minted it (TASK-411)', async () => {
    // This guard used to read `ctx.userId === 'ipc-server' || ctx.agentId ===
    // 'ipc-server'` — ONE transport's literal. @ax/ipc-http stamped
    // 'ipc-http' and walked straight through, on the transport that serves
    // production. The ids below stand for two different owner-less sessions;
    // neither is a literal the guard could be enumerating.
    const bus = busWithPropose(async () => ({ skillId: 'x', status: 'active' }));
    for (const sessionId of ['sess-unix-1', 'sess-tcp-1']) {
      const ctx = makeAgentContext({
        sessionId,
        agentId: ownerlessIdFor(sessionId),
        userId: ownerlessIdFor(sessionId),
      });
      const r = await skillProposeHandler(validPayload, ctx, bus);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toContain('not bound to a user+agent');
    }
  });

  it('ANTI-VACUITY: a half-owner-less ctx is still refused, a fully owned one is not', async () => {
    const bus = busWithPropose(async () => ({ skillId: 'x', status: 'active' }));
    // Only the user is owner-less (the agent looks real) — still refused.
    const halfUser = makeAgentContext({
      sessionId: 's',
      agentId: 'agt_real',
      userId: ownerlessIdFor('s'),
    });
    expect((await skillProposeHandler(validPayload, halfUser, bus)).status).toBe(400);
    // Only the agent is owner-less — still refused.
    const halfAgent = makeAgentContext({
      sessionId: 's',
      agentId: ownerlessIdFor('s'),
      userId: 'usr_real',
    });
    expect((await skillProposeHandler(validPayload, halfAgent, bus)).status).toBe(400);
    // A fully owned session reaches the hook — proving the guard is about the
    // scope and not about rejecting every proposal.
    expect((await skillProposeHandler(validPayload, boundCtx(), bus)).status).toBe(200);
  });

  it('TASK-690: a bundle write refused by the storage limit is a model-actionable 409, not an opaque 500', async () => {
    // skills:propose writes the bundle through blob:put, which throws code
    // 'rejected' when a blob:pre-put subscriber refuses. The message is
    // plugin-supplied (forgeable, I9), so the wire carries a FIXED sentence.
    const bus = busWithPropose(async () => {
      throw new PluginError({
        code: 'rejected',
        plugin: '@ax/blob-store-fs',
        hookName: 'blob:put',
        message: 'secret-internal-detail',
      });
    });
    const { ctx, entries } = loggedCtx();
    const r = await skillProposeHandler(validPayload, ctx, bus);
    expect(r.status).toBe(409);
    const text = JSON.stringify((r as { body: unknown }).body);
    expect(text).toContain('storage is full');
    expect(text).not.toContain('secret-internal-detail');
    // A policy refusal is an answer, not a host fault (TASK-1015).
    expect(entries.filter((e) => e.level === 'error')).toHaveLength(0);
  });

  // TASK-1015: the real HookBus wraps every plain throw from a service impl
  // (a store or DB outage) into PluginError{code:'unknown'}. That shape fell
  // through to mapPluginError → 500 without ever being logged, so the host
  // had no record of the failure. The first row reaches the handler through
  // the real bus's own wrapping; the rest are thrown pre-wrapped. A fake bus
  // that rethrows a raw Error would hide the bug, because the raw-Error branch
  // was already logged. `invalid-return` is the bus's code for a service answer
  // that fails its `returns` schema: a host fault, so it must not be read as
  // an author error just because it starts with `invalid-`.
  const wrapped = (code: string) => async (): Promise<never> => {
    throw new PluginError({
      code,
      plugin: '@ax/skills',
      hookName: 'skills:propose',
      message: 'connection refused',
    });
  };
  it.each([
    [
      'a plain throw the real bus wraps',
      'unknown',
      async (): Promise<never> => {
        throw new Error('connection refused');
      },
    ],
    ['a pre-wrapped PluginError{code:unknown}', 'unknown', wrapped('unknown')],
    ['a bus timeout', 'timeout', wrapped('timeout')],
    ['a bus invalid-return (service answer failed its schema)', 'invalid-return', wrapped('invalid-return')],
  ])('TASK-1015: logs %s once, then returns a sanitized 500', async (_label, code, impl) => {
    const { ctx, entries } = loggedCtx();
    const r = await skillProposeHandler(validPayload, ctx, busWithPropose(impl));
    expect(r.status).toBe(500);
    expect(JSON.stringify((r as { body: unknown }).body)).not.toContain('connection refused');
    const errors = entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: 'ipc_dispatch_internal_error',
      reqId: 'req-skillpropose',
      action: 'skill.propose',
      pluginErrorCode: code,
    });
  });

  it('TASK-1015: an unregistered skills:propose (optional hook) is a logged 500', async () => {
    const { ctx, entries } = loggedCtx();
    const r = await skillProposeHandler(validPayload, ctx, new HookBus());
    expect(r.status).toBe(500);
    const errors = entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ action: 'skill.propose', pluginErrorCode: 'no-service' });
  });

  // TASK-1015 review: every skills-parser ManifestCode plus the bundle-file
  // validator's code is a RECOVERABLE author error. Two of them do not start
  // with `invalid-` (`capability-block-forbidden`, `inline-secret-forbidden`),
  // and an honest model reaches both by writing a `capabilities:` block or a
  // `token:` key. They must come back as a model-actionable 400, never a
  // retried 500 logged as a host fault. The message is not echoed (I9).
  it.each([
    'invalid-yaml',
    'invalid-manifest',
    'inline-secret-forbidden',
    'invalid-name',
    'invalid-description',
    'invalid-version',
    'capability-block-forbidden',
    'invalid-connector',
    'invalid-bundle-file',
  ])('TASK-1015: author error %s is a 400 re-draft with no log', async (code) => {
    const { ctx, entries } = loggedCtx();
    const bus = busWithPropose(async () => {
      throw new PluginError({ code, plugin: '@ax/skills', message: 'echo-me-not' });
    });
    const r = await skillProposeHandler(validPayload, ctx, bus);
    expect(r.status).toBe(400);
    const text = JSON.stringify((r as { body: unknown }).body);
    expect(text).toContain('re-draft');
    expect(text).not.toContain('echo-me-not');
    expect(entries).toHaveLength(0);
  });

  // TASK-1018 drift guard, runtime half: driven off the PARSER's own list, not
  // a copy, so a code the parser adds fails here even before anyone runs tsc
  // (the compile-time half is the table's `satisfies Record<ManifestCode,
  // true>` in skill-propose.ts). A new code must be classified, not left to
  // fall through to a logged 500.
  it.each([...MANIFEST_CODES])(
    "TASK-1018: parser code %s (from the parser's own list) is a 400 re-draft",
    async (code) => {
      const { ctx, entries } = loggedCtx();
      const bus = busWithPropose(async () => {
        throw new PluginError({ code, plugin: '@ax/skills', message: 'echo-me-not' });
      });
      const r = await skillProposeHandler(validPayload, ctx, bus);
      expect(r.status).toBe(400);
      expect(entries).toHaveLength(0);
    },
  );

  // Anti-vacuity for the 500 rows: the error log is gated on the mapped 500,
  // not on "any PluginError". These codes all reach mapPluginError and map to
  // a 4xx: an expected answer, so a `warn` carrying the code only (no plugin
  // message), never an `error`.
  it.each(['forbidden', 'not-found', 'unknown-session', 'conflict'])(
    'TASK-1015: fall-through %s is a 4xx with a code-only warn, not an error log',
    async (code) => {
      const { ctx, entries } = loggedCtx();
      const bus = busWithPropose(async () => {
        throw new PluginError({ code, plugin: '@ax/skills', message: 'echo-me-not' });
      });
      const r = await skillProposeHandler(validPayload, ctx, bus);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(entries.filter((e) => e.level === 'error')).toHaveLength(0);
      const warns = entries.filter((e) => e.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({
        msg: 'skill_propose_hook_refused',
        action: 'skill.propose',
        pluginErrorCode: code,
      });
      expect(JSON.stringify(warns[0])).not.toContain('echo-me-not');
    },
  );

  // The author-error list is explicit, not a prefix rule: a code that merely
  // LOOKS like an author error (a parser code added later, say) falls through
  // to a logged 500 rather than a silent "re-draft". That is the safe
  // direction, and this row pins it.
  it('TASK-1015: an unlisted invalid-* code is a logged 500, not a re-draft', async () => {
    const { ctx, entries } = loggedCtx();
    const bus = busWithPropose(async () => {
      throw new PluginError({ code: 'invalid-new-parser-code', plugin: '@ax/skills', message: 'x' });
    });
    const r = await skillProposeHandler(validPayload, ctx, bus);
    expect(r.status).toBe(500);
    const errors = entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ pluginErrorCode: 'invalid-new-parser-code' });
  });

  // TASK-1091: an external turn (a person with no access to this agent is
  // present) can't author a skill. A clean authored skill goes active with no
  // human, a lasting change to the agent like an identity edit. `source` is
  // stamped by the IPC listener from the session record, never read off this
  // payload. A routine keeps proposing: the skill-reflection routine depends
  // on it.
  describe('TASK-1091: external turns', () => {
    const EXTERNAL_REFUSAL =
      "skill.propose: skills can't be saved from a conversation with people who don't have access to this agent. Nothing was saved.";

    function sourcedCtx(source: AgentContextSource): AgentContext {
      return makeAgentContext({ sessionId: 's1', agentId: 'a1', userId: 'u1', source });
    }

    function countingBus(): { bus: HookBus; calls: () => number } {
      let n = 0;
      const bus = busWithPropose(async () => {
        n += 1;
        return { skillId: 'commit-style', status: 'active' };
      });
      return { bus, calls: () => n };
    }

    it("refuses an external session's proposal without calling skills:propose", async () => {
      const { bus, calls } = countingBus();
      const r = await skillProposeHandler(validPayload, sourcedCtx('external'), bus);
      expect(calls()).toBe(0);
      expect(r).toEqual(hookRejected(EXTERNAL_REFUSAL));
      // A fixed sentence the runner relays to the model, so pin the wire too.
      expect(r).toEqual({
        status: 409,
        body: { error: { code: 'HOOK_REJECTED', message: EXTERNAL_REFUSAL } },
      });
    });

    it.each(['routine', 'user'] as const)("still forwards a %s session's proposal", async (source) => {
      const { bus, calls } = countingBus();
      const r = await skillProposeHandler(validPayload, sourcedCtx(source), bus);
      expect(calls()).toBe(1);
      expect(r).toEqual({ status: 200, body: { skillId: 'commit-style', status: 'active' } });
    });
  });
});
