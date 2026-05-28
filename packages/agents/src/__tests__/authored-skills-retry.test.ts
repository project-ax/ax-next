import { describe, it, expect } from 'vitest';
import type { HookBus } from '@ax/core';
import { readAuthoredBundle } from '../authored-skills.js';

// BUG-W2 follow-up: readAuthoredBundle re-issues workspace:list a bounded number
// of times until the canonical SKILL.md path appears, to tolerate the
// host read-after-push race under concurrent installs (the file IS pushed, but
// a racing read's mirror view briefly lags). These tests drive a fake bus whose
// workspace:list "catches up" after K calls — the real concurrent git race
// can't be unit-reproduced, but the retry LOGIC (which is the fix) is exactly
// what we lock here. mock-list-then-hit is the transient-miss the live race
// produces.

const SKILL_MD = [
  '---',
  'name: foo',
  'description: a foo skill',
  'version: 1',
  '---',
  '',
  '# foo',
  'body',
].join('\n');

const SKILL_PATH = '.ax/skills/foo/SKILL.md';

/**
 * A minimal HookBus stub: workspace:list returns `[]` for the first
 * `missesBeforeHit` calls, then `[SKILL_PATH]`; workspace:read serves the
 * SKILL.md. `listCalls` counts how many times list was issued.
 */
function fakeBus(missesBeforeHit: number): { bus: HookBus; listCalls: () => number } {
  let calls = 0;
  const bus = {
    hasService: (name: string) =>
      name === 'workspace:list' || name === 'workspace:read',
    call: async (hook: string, _ctx: unknown, input: unknown) => {
      if (hook === 'workspace:list') {
        const hit = calls >= missesBeforeHit;
        calls++;
        return { paths: hit ? [SKILL_PATH] : [] };
      }
      if (hook === 'workspace:read') {
        const path = (input as { path: string }).path;
        if (path === SKILL_PATH) {
          return {
            found: true,
            bytes: new TextEncoder().encode(SKILL_MD),
            version: 'v1',
          };
        }
        return { found: false };
      }
      throw new Error(`unexpected hook ${hook}`);
    },
  } as unknown as HookBus;
  return { bus, listCalls: () => calls };
}

describe('readAuthoredBundle bounded read-retry', () => {
  it('finds the bundle on the first list when present (no wasted retries)', async () => {
    const { bus, listCalls } = fakeBus(0);
    const out = await readAuthoredBundle(bus, 'usr_1', 'agt_1', 'foo', {
      maxListAttempts: 5,
      listBackoffMs: 1,
    });
    expect(out?.id).toBe('foo');
    expect(out?.description).toBe('a foo skill');
    expect(listCalls()).toBe(1);
  });

  it('retries the list until the SKILL.md path appears (the race case)', async () => {
    // Two empty lists (the racing reads) then the file shows up.
    const { bus, listCalls } = fakeBus(2);
    const out = await readAuthoredBundle(bus, 'usr_1', 'agt_1', 'foo', {
      maxListAttempts: 5,
      listBackoffMs: 1,
    });
    expect(out?.id).toBe('foo');
    expect(listCalls()).toBe(3); // 2 misses + the hit
  });

  it('returns null after exhausting bounded attempts (genuinely not authored)', async () => {
    // Never appears — must stop after maxListAttempts, not loop forever.
    const { bus, listCalls } = fakeBus(Number.POSITIVE_INFINITY);
    const out = await readAuthoredBundle(bus, 'usr_1', 'agt_1', 'foo', {
      maxListAttempts: 3,
      listBackoffMs: 1,
    });
    expect(out).toBeNull();
    expect(listCalls()).toBe(3);
  });
});
