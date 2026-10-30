/**
 * An in-memory stand-in for @ax/agents' identity hooks (TASK-989), for the
 * channel-web server tests.
 *
 * channel-web may not import @ax/agents (Invariant 2), so this mirrors the
 * real service's contract by hand — the parts a route can get wrong:
 *
 *   - `agents:identity:get { agentId }` answers the whole record
 *     `{ identity, soul, instructions, bootstrap, revision }`;
 *     `agents:identity:set { agentId, patch, expectedRevision }` answers
 *     `saved | unchanged | conflict` (each with the current record) or
 *     `refused { section, code, reason }`.
 *   - Both refuse (`invalid-payload`) an input whose `agentId` is not the
 *     calling ctx's, or that carries a key the hook does not take — so a route
 *     that hands the hook the wrong ctx or an extra field fails here the way
 *     it would in production.
 *   - Access is decided from `ctx.userId` (`forbidden` otherwise), like the
 *     real `checkAccess`. Default: everyone may.
 *   - A saved write trims trailing whitespace and bumps `revision` by one; an
 *     identical patch is `unchanged`; a stale `expectedRevision` is a
 *     `conflict` carrying the current record.
 *
 * Storage is keyed by agentId alone — one record per agent, shared by everyone
 * who may reach it — as the real table is.
 */
import { PluginError, type AgentContext, type HookBus } from '@ax/core';

export type FakeSection = 'identity' | 'soul' | 'instructions';
const SECTIONS: readonly FakeSection[] = ['identity', 'soul', 'instructions'];

export interface FakeIdentityRecord {
  identity: string;
  soul: string;
  instructions: string;
  bootstrap: 'none' | 'pending' | 'done';
  revision: number;
}

export interface FakeIdentityCall {
  hook: 'get' | 'set';
  /** The calling ctx — what the real service authorizes on. */
  ctxAgentId: string;
  ctxUserId: string;
  input: unknown;
}

export interface FakeRefusal {
  section: FakeSection;
  code: 'too-long' | 'content' | 'scan-unavailable';
  reason: string;
}

export interface IdentityStoreFake {
  readonly calls: FakeIdentityCall[];
  /** One agent's stored record (empty defaults when nothing was saved). */
  record(agentId: string): FakeIdentityRecord;
  /** Store a record directly, as if it had been saved earlier. */
  seed(agentId: string, record: Partial<FakeIdentityRecord>): void;
  /**
   * How many of the next sets lose a race: just before each one, a concurrent
   * writer — the agent rewriting its own soul — lands first, so that set's
   * `expectedRevision` is stale.
   */
  racingWrites: number;
  /** When set, every set answers this refusal and saves nothing. */
  refuse: FakeRefusal | undefined;
  /** When set, the hook throws it. */
  getThrows: Error | undefined;
  setThrows: Error | undefined;
}

const EMPTY: FakeIdentityRecord = {
  identity: '',
  soul: '',
  instructions: '',
  bootstrap: 'none',
  revision: 0,
};

export function registerIdentityStoreFake(
  bus: HookBus,
  plugin: string,
  opts: { mayAccess?: (agentId: string, userId: string) => boolean } = {},
): IdentityStoreFake {
  const records = new Map<string, FakeIdentityRecord>();
  const fake: IdentityStoreFake = {
    calls: [],
    record: (agentId) => ({ ...(records.get(agentId) ?? EMPTY) }),
    seed: (agentId, record) => {
      records.set(agentId, { ...EMPTY, ...records.get(agentId), ...record });
    },
    racingWrites: 0,
    refuse: undefined,
    getThrows: undefined,
    setThrows: undefined,
  };

  const invalid = (hookName: string, message: string): PluginError =>
    new PluginError({ code: 'invalid-payload', plugin, hookName, message });

  /** The real service's order: input shape → ctx match → access. */
  function authorize(
    ctx: AgentContext,
    input: unknown,
    hookName: string,
    keys: readonly string[],
  ): { agentId: string; fields: Record<string, unknown> } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw invalid(hookName, 'input must be an object');
    }
    const fields = input as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!keys.includes(key)) throw invalid(hookName, `unexpected field '${key}'`);
    }
    const agentId = fields.agentId;
    if (typeof agentId !== 'string' || agentId !== ctx.agentId) {
      throw invalid(hookName, 'agentId does not match the calling context');
    }
    if (opts.mayAccess !== undefined && !opts.mayAccess(agentId, ctx.userId)) {
      throw new PluginError({ code: 'forbidden', plugin, hookName, message: 'not accessible' });
    }
    return { agentId, fields };
  }

  bus.registerService<unknown, unknown>('agents:identity:get', plugin, async (ctx, input) => {
    fake.calls.push({ hook: 'get', ctxAgentId: ctx.agentId, ctxUserId: ctx.userId, input });
    if (fake.getThrows !== undefined) throw fake.getThrows;
    const { agentId } = authorize(ctx, input, 'agents:identity:get', ['agentId']);
    return fake.record(agentId);
  });

  bus.registerService<unknown, unknown>('agents:identity:set', plugin, async (ctx, input) => {
    fake.calls.push({ hook: 'set', ctxAgentId: ctx.agentId, ctxUserId: ctx.userId, input });
    if (fake.setThrows !== undefined) throw fake.setThrows;
    const hook = 'agents:identity:set';
    const { agentId, fields } = authorize(ctx, input, hook, ['agentId', 'patch', 'expectedRevision']);
    const patch = fields.patch;
    if (typeof patch !== 'object' || patch === null || Object.keys(patch).length === 0) {
      throw invalid(hook, 'patch must name at least one section');
    }
    const normalised: Partial<Record<FakeSection, string>> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!(SECTIONS as readonly string[]).includes(key) || typeof value !== 'string') {
        throw invalid(hook, `patch.${key} is not a section text`);
      }
      normalised[key as FakeSection] = value.trimEnd();
    }
    const expected = fields.expectedRevision;
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
      throw invalid(hook, 'expectedRevision must be a non-negative integer');
    }

    if (fake.refuse !== undefined) return { outcome: 'refused', ...fake.refuse };

    if (fake.racingWrites > 0) {
      fake.racingWrites -= 1;
      const before = fake.record(agentId);
      records.set(agentId, {
        ...before,
        soul: `agent edit ${before.revision + 1}`,
        revision: before.revision + 1,
      });
    }

    const current = fake.record(agentId);
    if (expected !== current.revision) return { outcome: 'conflict', record: current };
    if (SECTIONS.every((s) => normalised[s] === undefined || normalised[s] === current[s])) {
      return { outcome: 'unchanged', record: current };
    }
    const next: FakeIdentityRecord = { ...current, ...normalised, revision: current.revision + 1 };
    records.set(agentId, next);
    return { outcome: 'saved', record: { ...next } };
  });

  return fake;
}
