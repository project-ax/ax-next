// @vitest-environment node
/**
 * Unit tests for the durable "Not now" marker (TASK-444).
 *
 * Two things are under test and they pull in opposite directions:
 *
 *  - the KEY has to be unambiguous. `agentId`, `kind` and `subjectId` all come
 *    from a manifest an agent authored, and `userId` decides whose namespace we
 *    are in — so an id carrying a `:` must not be able to spell itself into a
 *    different segment (invariant 5, untrusted at every hop).
 *  - the VALUE has to be read defensively. It is bytes out of a store that
 *    other code, other versions and a corrupted row can all reach; a value we
 *    cannot parse means "we don't know", which is NOT "declined" and is
 *    certainly not a crash that takes the grants list down with it.
 */
import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';
import {
  grantDeclineKey,
  grantDeclineUserPrefix,
  parseGrantDeclineKey,
  readGrantDeclines,
  recordGrantDecline,
} from '../../server/grant-declines.js';

function makeCtx(warn: (event: string, fields?: unknown) => void): AgentContext {
  const ctx = makeAgentContext({
    sessionId: 'init',
    agentId: '@ax/channel-web',
    userId: 'system',
  });
  return {
    ...ctx,
    logger: { ...ctx.logger, warn: warn as AgentContext['logger']['warn'] },
  } as AgentContext;
}

/** A bus with a KV store backed by `store`. */
function busWith(store: Map<string, Uint8Array>): HookBus {
  const bus = new HookBus();
  bus.registerService<{ key: string; value: Uint8Array }, void>(
    'storage:set',
    'storage',
    async (_ctx, { key, value }) => {
      store.set(key, value);
    },
  );
  bus.registerService<
    { prefix: string },
    { entries: Array<{ key: string; value: Uint8Array }> }
  >('storage:list-prefix', 'storage', async (_ctx, { prefix }) => ({
    entries: [...store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
  }));
  return bus;
}

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

describe('grant-decline keys', () => {
  it('round-trips every segment back out, verbatim', () => {
    const key = grantDeclineKey('u-ann', 'a-quill', 'skill', 'linear');
    expect(parseGrantDeclineKey(key)).toEqual({
      userId: 'u-ann',
      agentId: 'a-quill',
      kind: 'skill',
      subjectId: 'linear',
    });
  });

  it('a subjectId full of separators survives the round-trip', () => {
    const subjectId = 'evil:skill:/../s';
    const key = grantDeclineKey('u-ann', 'a-quill', 'skill', subjectId);
    // The raw separators are gone from the key itself...
    expect(key).not.toContain('evil:skill');
    // ...and the id comes back whole.
    expect(parseGrantDeclineKey(key)?.subjectId).toBe(subjectId);
  });

  it('two different grants can never build the same key', () => {
    /*
      The collision an unencoded key would have, and the reason encoding is
      load-bearing rather than cosmetic. Unencoded, both of these spell
      `grant-decline:u-ann:a:skill:evil:skill:s` — so declining the first
      would silently suppress the second, on a different agent, forever.
      Both ids come from an agent-authored manifest.
    */
    const a = grantDeclineKey('u-ann', 'a:skill:evil', 'skill', 's');
    const b = grantDeclineKey('u-ann', 'a', 'skill', 'evil:skill:s');
    expect(a).not.toBe(b);
    expect(parseGrantDeclineKey(a)?.agentId).toBe('a:skill:evil');
    expect(parseGrantDeclineKey(b)?.subjectId).toBe('evil:skill:s');
  });

  it('a userId cannot spell its way into somebody else’s prefix', () => {
    // `grant-decline:u-mallory:…` must not be reachable by a user whose id
    // merely CONTAINS that text plus a colon.
    const forged = grantDeclineUserPrefix('u-mallory:a:skill');
    expect(forged.startsWith(grantDeclineUserPrefix('u-mallory'))).toBe(false);
  });

  it('the user prefix is a prefix of that user’s keys and of nobody else’s', () => {
    const key = grantDeclineKey('u-ann', 'a-quill', 'connector', 'github');
    expect(key.startsWith(grantDeclineUserPrefix('u-ann'))).toBe(true);
    expect(key.startsWith(grantDeclineUserPrefix('u-annette'))).toBe(false);
  });

  it('rejects a key that is not four segments, or not ours at all', () => {
    expect(parseGrantDeclineKey('grant-decline:u-ann:a-quill:skill')).toBeNull();
    expect(
      parseGrantDeclineKey('grant-decline:u-ann:a-quill:skill:linear:extra'),
    ).toBeNull();
    expect(parseGrantDeclineKey('settings:branding')).toBeNull();
    // A segment that is not decodable is a malformed row, not a crash.
    expect(parseGrantDeclineKey('grant-decline:u-ann:a-quill:skill:%E0%A4%A')).toBeNull();
  });
});

describe('recordGrantDecline / readGrantDeclines', () => {
  it('a recorded decline reads back at the instant it was written', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = busWith(store);
    const ctx = makeCtx(() => {});

    await recordGrantDecline(bus, ctx, {
      userId: 'u-ann',
      agentId: 'a-quill',
      kind: 'skill',
      subjectId: 'linear',
      declinedAt: 1234,
    });

    const declines = await readGrantDeclines(bus, ctx, 'u-ann');
    expect(declines.get(grantDeclineKey('u-ann', 'a-quill', 'skill', 'linear'))).toBe(
      1234,
    );
  });

  it('reads only the caller’s own rows', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = busWith(store);
    const ctx = makeCtx(() => {});
    await recordGrantDecline(bus, ctx, {
      userId: 'u-ann',
      agentId: 'a-quill',
      kind: 'skill',
      subjectId: 'linear',
      declinedAt: 1,
    });
    await recordGrantDecline(bus, ctx, {
      userId: 'u-bob',
      agentId: 'a-scout',
      kind: 'skill',
      subjectId: 'github',
      declinedAt: 2,
    });

    const declines = await readGrantDeclines(bus, ctx, 'u-ann');
    expect([...declines.values()]).toEqual([1]);
  });

  it('skips a value that does not decode to {declinedAt: number}, and says so', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = busWith(store);
    const warn = vi.fn();
    const ctx = makeCtx(warn);

    const good = grantDeclineKey('u-ann', 'a-quill', 'skill', 'good');
    store.set(good, enc({ declinedAt: 99 }));
    store.set(
      grantDeclineKey('u-ann', 'a-quill', 'skill', 'not-json'),
      new TextEncoder().encode('}{'),
    );
    store.set(
      grantDeclineKey('u-ann', 'a-quill', 'skill', 'wrong-shape'),
      enc({ declinedAt: 'yesterday' }),
    );
    store.set(grantDeclineKey('u-ann', 'a-quill', 'skill', 'nan'), enc({ declinedAt: NaN }));

    const declines = await readGrantDeclines(bus, ctx, 'u-ann');

    // The unreadable rows are absent — NOT present with some default, because
    // a row we cannot read must never read as "the person said no".
    expect([...declines.keys()]).toEqual([good]);
    expect(warn).toHaveBeenCalled();
  });

  it('ignores a row under our prefix whose key is not one of ours', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = busWith(store);
    const ctx = makeCtx(() => {});
    store.set(`${grantDeclineUserPrefix('u-ann')}only-two:segments`, enc({ declinedAt: 5 }));

    expect((await readGrantDeclines(bus, ctx, 'u-ann')).size).toBe(0);
  });
});
