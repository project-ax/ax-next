import { describe, it, expect, vi } from 'vitest';
import { makeAgentContext } from '@ax/core';
import { backfillIdentityFile } from '@ax/agent-identity-templates';
import {
  runIdentityBackfill,
  type BackfillAgent,
  type BackfillStore,
} from '../backfill-identity.js';

function fakeStore(agents: BackfillAgent[]): BackfillStore {
  return { listAll: async () => agents };
}

const initCtx = makeAgentContext({ sessionId: 'init', agentId: '@ax/agents', userId: 'system' });
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

interface Apply {
  agentId: string;
  userId: string;
  changes: Array<{ path: string; kind: string; content?: Uint8Array }>;
  parent: unknown;
}

/** A bus stub that registers workspace:read + workspace:apply. `existing` is the
 * set of agentIds that already have `.ax/IDENTITY.md` (→ read returns found). */
function fakeBus(opts: { existing?: Set<string>; applyThrowsFor?: Set<string> } = {}) {
  const existing = opts.existing ?? new Set<string>();
  const applyThrowsFor = opts.applyThrowsFor ?? new Set<string>();
  const applies: Apply[] = [];
  const bus = {
    hasService: (h: string) => h === 'workspace:apply' || h === 'workspace:read',
    call: vi.fn(async (hook: string, ctx: { agentId: string; userId: string }, input: unknown) => {
      if (hook === 'workspace:read') {
        return existing.has(ctx.agentId) ? { found: true } : { found: false };
      }
      if (hook === 'workspace:apply') {
        if (applyThrowsFor.has(ctx.agentId)) throw new Error('apply boom');
        const i = input as { changes: Apply['changes']; parent: unknown };
        applies.push({ agentId: ctx.agentId, userId: ctx.userId, changes: i.changes, parent: i.parent });
        return { version: 'v1', delta: { before: null, after: 'v1', changes: [] } };
      }
      throw new Error(`unexpected hook ${hook}`);
    }),
  };
  return { bus: bus as unknown as Parameters<typeof runIdentityBackfill>[0]['bus'], applies, raw: bus };
}

describe('runIdentityBackfill', () => {
  it('writes IDENTITY.md + SOUL.md for a personal agent with no .ax files', async () => {
    const store = fakeStore([
      { id: 'a1', ownerId: 'u1', ownerType: 'user', displayName: 'Ada', systemPrompt: 'You are warm.' },
    ]);
    const { bus, applies } = fakeBus();
    await runIdentityBackfill({ bus, store, initCtx });

    expect(applies).toHaveLength(1);
    expect(applies[0]!.agentId).toBe('a1');
    expect(applies[0]!.userId).toBe('u1'); // real owner, not 'system'
    expect(applies[0]!.parent).toBeNull();
    const byPath = new Map(applies[0]!.changes.map((c) => [c.path, c.content ? dec(c.content) : undefined]));
    expect(byPath.get('.ax/IDENTITY.md')).toBe(backfillIdentityFile('Ada'));
    expect(byPath.get('.ax/SOUL.md')).toBe('You are warm.');
    // No AGENTS.md.
    expect([...byPath.keys()]).not.toContain('.ax/AGENTS.md');
  });

  it('preserves the legacy system_prompt VERBATIM in SOUL.md (multi-line)', async () => {
    const blob = 'You are X.\n\nAlways be terse.\n- bullet';
    const store = fakeStore([
      { id: 'a1', ownerId: 'u1', ownerType: 'user', displayName: 'X', systemPrompt: blob },
    ]);
    const { bus, applies } = fakeBus();
    await runIdentityBackfill({ bus, store, initCtx });
    const byPath = new Map(applies[0]!.changes.map((c) => [c.path, c.content ? dec(c.content) : undefined]));
    expect(byPath.get('.ax/SOUL.md')).toBe(blob);
  });

  it('skips an agent that already has .ax/IDENTITY.md (idempotent re-run)', async () => {
    const store = fakeStore([
      { id: 'a1', ownerId: 'u1', ownerType: 'user', displayName: 'Ada', systemPrompt: 'x' },
    ]);
    const { bus, applies } = fakeBus({ existing: new Set(['a1']) });
    await runIdentityBackfill({ bus, store, initCtx });
    expect(applies).toHaveLength(0);
  });

  it('skips team agents (no personal-owner ctx)', async () => {
    const store = fakeStore([
      { id: 't1', ownerId: 'team-x', ownerType: 'team', displayName: 'Team Bot', systemPrompt: 'x' },
    ]);
    const { bus, applies, raw } = fakeBus();
    await runIdentityBackfill({ bus, store, initCtx });
    expect(applies).toHaveLength(0);
    // Never even probed the workspace for a team agent.
    expect(raw.call).not.toHaveBeenCalled();
  });

  it('is a no-op when no workspace backend is registered', async () => {
    const store = fakeStore([
      { id: 'a1', ownerId: 'u1', ownerType: 'user', displayName: 'Ada', systemPrompt: 'x' },
    ]);
    const call = vi.fn();
    const bus = { hasService: () => false, call } as unknown as Parameters<typeof runIdentityBackfill>[0]['bus'];
    await runIdentityBackfill({ bus, store, initCtx });
    expect(call).not.toHaveBeenCalled();
  });

  it('continues past one agent whose apply throws', async () => {
    const store = fakeStore([
      { id: 'bad', ownerId: 'u1', ownerType: 'user', displayName: 'Bad', systemPrompt: 'x' },
      { id: 'good', ownerId: 'u2', ownerType: 'user', displayName: 'Good', systemPrompt: 'y' },
    ]);
    const { bus, applies } = fakeBus({ applyThrowsFor: new Set(['bad']) });
    await runIdentityBackfill({ bus, store, initCtx });
    expect(applies.map((a) => a.agentId)).toEqual(['good']);
  });

  it('routes EACH agent under its OWN owner (distinct ctxs)', async () => {
    const store = fakeStore([
      { id: 'a1', ownerId: 'u1', ownerType: 'user', displayName: 'One', systemPrompt: 'a' },
      { id: 'a2', ownerId: 'u2', ownerType: 'user', displayName: 'Two', systemPrompt: 'b' },
    ]);
    const { bus, applies } = fakeBus();
    await runIdentityBackfill({ bus, store, initCtx });
    expect(applies).toEqual([
      expect.objectContaining({ agentId: 'a1', userId: 'u1' }),
      expect.objectContaining({ agentId: 'a2', userId: 'u2' }),
    ]);
  });
});
