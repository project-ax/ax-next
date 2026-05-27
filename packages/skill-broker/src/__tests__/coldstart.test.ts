import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import {
  deriveColdStartSlug,
  clampNeed,
  fireColdStartSubmit,
  CAPABILITY_NEED_MAX,
} from '../tools/coldstart.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'user-7' });

describe('deriveColdStartSlug', () => {
  it('lowercases + dasherizes plain intent', () => {
    expect(deriveColdStartSlug('Read my Linear issues')).toBe('read-my-linear-issues');
  });

  it('collapses repeated separators and trims edge dashes', () => {
    expect(deriveColdStartSlug('  --GitHub___PRs!!  ')).toBe('github-prs');
  });

  it('falls back to "capability" for an all-punctuation / empty intent', () => {
    expect(deriveColdStartSlug('   !!!  ')).toBe('capability');
    expect(deriveColdStartSlug('')).toBe('capability');
  });

  it('caps the slug at 64 chars and the result still matches the id grammar', () => {
    const long = 'connect to '.repeat(40); // ~440 chars
    const slug = deriveColdStartSlug(long);
    expect(slug.length).toBeLessThanOrEqual(64);
    // Must be a valid catalog skill-id slug (dedup key the store keys on).
    expect(/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)).toBe(true);
  });

  it('never emits a trailing dash after the length cap', () => {
    // A cap that lands on a separator must not leave a dangling dash.
    const slug = deriveColdStartSlug('a'.repeat(63) + ' bbbb');
    expect(slug.endsWith('-')).toBe(false);
    expect(/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)).toBe(true);
  });
});

describe('clampNeed', () => {
  it('trims surrounding whitespace', () => {
    expect(clampNeed('  hello  ')).toBe('hello');
  });

  it('caps at CAPABILITY_NEED_MAX chars', () => {
    const out = clampNeed('x'.repeat(CAPABILITY_NEED_MAX + 200));
    expect(out.length).toBe(CAPABILITY_NEED_MAX);
  });
});

describe('fireColdStartSubmit', () => {
  function busWithSubmit() {
    const bus = new HookBus();
    const calls: unknown[] = [];
    bus.registerService('catalog:submit', 'skills', async (_c, input: unknown) => {
      calls.push(input);
      return { requestId: 'req_1', created: true, status: 'pending' };
    });
    return { bus, calls };
  }

  it('calls catalog:submit with a cold-start payload + ctx userId', async () => {
    const { bus, calls } = busWithSubmit();
    await fireColdStartSubmit(bus, ctx, { skillId: 'jira', description: 'I need Jira' });
    expect(calls).toEqual([
      {
        kind: 'cold-start',
        skillId: 'jira',
        requestedByUserId: 'user-7',
        description: 'I need Jira',
      },
    ]);
  });

  it('is a no-op when catalog:submit is not registered (no throw)', async () => {
    const bus = new HookBus();
    await expect(
      fireColdStartSubmit(bus, ctx, { skillId: 'jira', description: 'need' }),
    ).resolves.toBeUndefined();
  });

  it('swallows a catalog:submit failure (never bubbles out of the host tool)', async () => {
    const bus = new HookBus();
    bus.registerService('catalog:submit', 'skills', async () => {
      throw new Error('queue down');
    });
    await expect(
      fireColdStartSubmit(bus, ctx, { skillId: 'jira', description: 'need' }),
    ).resolves.toBeUndefined();
  });
});
