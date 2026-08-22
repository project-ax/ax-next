/**
 * The freshness guard's two halves, in isolation.
 *
 * The wiring — hold captures, approve re-checks, a moved predicate re-opens the
 * row — is proved end to end in `decisions.canary.test.ts` against a real bus
 * and a real Postgres. What is proved HERE is the part that is easiest to get
 * subtly wrong and impossible to see from the outside: which failures fail open
 * and which fail closed, and what a producer is allowed to put in a durable row.
 */
import { createLogger, HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  auditFreshnessPairs,
  captureFreshness,
  checkFreshness,
  freshnessCaptureHook,
  freshnessCheckHook,
  UNREADABLE_SENTENCE,
  UNREADABLE_VALUE,
} from '../freshness.js';
import type { FreshnessPredicate } from '../types.js';

const TOOL = 'request_capability';
const CALL = { id: 'call-1', name: TOOL, input: { skillId: 'linear' } };

/** A context whose log lines are captured instead of printed. */
function ctxWithLog(): { ctx: AgentContext; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const ctx = makeAgentContext({
    sessionId: 's1',
    agentId: 'a1',
    userId: 'u1',
    logger: createLogger({
      reqId: 'r1',
      writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  });
  return { ctx, lines };
}

function messages(lines: Record<string, unknown>[]): string[] {
  return lines.map((l) => String(l.msg));
}

function busWith(
  hooks: Record<string, (ctx: AgentContext, input: unknown) => Promise<unknown>>,
): HookBus {
  const bus = new HookBus();
  for (const [name, handler] of Object.entries(hooks)) {
    bus.registerService(name, '@ax/decisions/test/producer', handler);
  }
  return bus;
}

const PREDICATE: FreshnessPredicate = {
  kind: 'catalog-skill',
  value: 'linear@abc123',
  label: 'the "linear" entry in the capability catalog',
};

describe('captureFreshness — fails OPEN', () => {
  it('produces no predicate for a tool with no producer', async () => {
    const { ctx, lines } = ctxWithLog();
    expect(await captureFreshness(new HookBus(), ctx, CALL)).toBeNull();
    // A tool with nothing to re-check is the DESIGNED case, not a gap. It must
    // not fill the log with a degradation line on every held call.
    expect(lines).toEqual([]);
  });

  it('produces no predicate when there is no bus at all', async () => {
    const { ctx } = ctxWithLog();
    expect(await captureFreshness(undefined, ctx, CALL)).toBeNull();
  });

  it('returns the producer predicate when the producer answers', async () => {
    const bus = busWith({
      [freshnessCaptureHook(TOOL)]: async () => ({ predicate: PREDICATE }),
    });
    const { ctx } = ctxWithLog();
    expect(await captureFreshness(bus, ctx, CALL)).toEqual(PREDICATE);
  });

  it('accepts a producer that has nothing to guard on THIS call', async () => {
    const bus = busWith({
      [freshnessCaptureHook(TOOL)]: async () => ({ predicate: null }),
    });
    const { ctx, lines } = ctxWithLog();
    expect(await captureFreshness(bus, ctx, CALL)).toBeNull();
    // An explicit `null` is an answer, not a failure.
    expect(messages(lines)).toEqual([]);
  });

  /**
   * THE ASYMMETRY. A capture that throws must NOT propagate: it runs inside the
   * `tool:pre-call` gate's fail-closed wrapper, so a throw would be caught
   * there and turned into a DENY — one broken producer taking the whole
   * approval surface down with it. The row is written unguarded instead, which
   * claims nothing, and the loss is logged loudly.
   */
  it('writes no predicate and logs loudly when the producer throws', async () => {
    const bus = busWith({
      [freshnessCaptureHook(TOOL)]: async () => {
        throw new Error('catalog is down');
      },
    });
    const { ctx, lines } = ctxWithLog();
    expect(await captureFreshness(bus, ctx, CALL)).toBeNull();
    expect(messages(lines)).toContain('decision_freshness_capture_failed');
    expect(lines[0]!.level).toBe('error');
  });

  it('drops a predicate whose kind is not a printable token, and says so', async () => {
    const bus = busWith({
      // `kind` is RENDERED — the machine builds its fallback staleReason by
      // de-hyphenating it — so a kind outside the grammar is refused rather
      // than stored and printed later.
      [freshnessCaptureHook(TOOL)]: async () => ({
        predicate: { kind: 'Not A Kind!', value: 'v', label: 'l' },
      }),
    });
    const { ctx, lines } = ctxWithLog();
    expect(await captureFreshness(bus, ctx, CALL)).toBeNull();
    expect(messages(lines)).toContain('decision_freshness_capture_unreadable');
  });

  it('drops a predicate with no value — half a predicate guards half a world', async () => {
    const bus = busWith({
      [freshnessCaptureHook(TOOL)]: async () => ({
        predicate: { kind: 'catalog-skill', value: '', label: 'l' },
      }),
    });
    const { ctx } = ctxWithLog();
    expect(await captureFreshness(bus, ctx, CALL)).toBeNull();
  });

  it('fences the label a human will read', async () => {
    const bus = busWith({
      [freshnessCaptureHook(TOOL)]: async () => ({
        predicate: {
          kind: 'catalog-skill',
          value: 'linear@abc',
          // A newline forges a second line in a log; U+202E reverses the visual
          // order of everything after it (Trojan Source); U+200B is invisible.
          label: 'the \u0000linear\u200B entry\nand\u202E a forged clause',
        },
      }),
    });
    const { ctx } = ctxWithLog();
    const p = await captureFreshness(bus, ctx, CALL);
    expect(p!.label).toBe('the linear entry and a forged clause');
    expect(p!.label).not.toMatch(/[\u0000\u200B\u202E\n]/);
  });

  it('clamps a runaway label by CODE POINTS, never splitting a surrogate pair', async () => {
    // Astral-plane characters are two UTF-16 units each. A `.slice()` cap would
    // cut one in half and emit a lone surrogate — ill-formed UTF-16 out of a
    // function whose whole job is "plain text".
    const bus = busWith({
      [freshnessCaptureHook(TOOL)]: async () => ({
        predicate: { kind: 'catalog-skill', value: 'v', label: '\u{1F600}'.repeat(400) },
      }),
    });
    const { ctx } = ctxWithLog();
    const p = await captureFreshness(bus, ctx, CALL);
    expect([...p!.label!].length).toBeLessThanOrEqual(120);
    expect(p!.label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('accepts a producer that supplies no label — the predicate still guards', async () => {
    const bus = busWith({
      [freshnessCaptureHook(TOOL)]: async () => ({
        predicate: { kind: 'catalog-skill', value: 'linear@abc', label: null },
      }),
    });
    const { ctx } = ctxWithLog();
    const p = await captureFreshness(bus, ctx, CALL);
    expect(p).toEqual({ kind: 'catalog-skill', value: 'linear@abc', label: null });
  });
});

describe('checkFreshness — fails CLOSED', () => {
  it('reports the current value when the producer answers', async () => {
    const bus = busWith({
      [freshnessCheckHook(TOOL)]: async () => ({ value: 'linear@abc123' }),
    });
    const { ctx } = ctxWithLog();
    expect(await checkFreshness(bus, ctx, TOOL, PREDICATE)).toEqual({
      value: 'linear@abc123',
    });
  });

  it('carries the producer sentence through, fenced', async () => {
    const bus = busWith({
      [freshnessCheckHook(TOOL)]: async () => ({
        value: 'linear@def456',
        changed: 'The "linear" capability\u202E changed.',
      }),
    });
    const { ctx } = ctxWithLog();
    const out = await checkFreshness(bus, ctx, TOOL, PREDICATE);
    expect(out.value).toBe('linear@def456');
    expect(out.changed).toBe('The "linear" capability changed.');
  });

  /**
   * An unreadable world is a CHANGED world. Every one of these has to come back
   * as something the captured value cannot match, or the guard silently
   * approves a world nobody looked at.
   */
  it('treats a producer that throws as changed', async () => {
    const bus = busWith({
      [freshnessCheckHook(TOOL)]: async () => {
        throw new PluginError({ code: 'not-found', plugin: 'p', message: 'gone' });
      },
    });
    const { ctx, lines } = ctxWithLog();
    const out = await checkFreshness(bus, ctx, TOOL, PREDICATE);
    expect(out.value).toBe(UNREADABLE_VALUE);
    expect(out.value).not.toBe(PREDICATE.value);
    expect(out.changed).toBe(UNREADABLE_SENTENCE);
    expect(messages(lines)).toContain('decision_freshness_check_failed');
  });

  it('treats a missing check hook as changed', async () => {
    const { ctx, lines } = ctxWithLog();
    const out = await checkFreshness(new HookBus(), ctx, TOOL, PREDICATE);
    expect(out.value).toBe(UNREADABLE_VALUE);
    expect(messages(lines)).toContain('decision_freshness_check_missing');
  });

  it('treats an unreadable answer as changed', async () => {
    const bus = busWith({
      [freshnessCheckHook(TOOL)]: async () => ({ value: 42 }),
    });
    const { ctx, lines } = ctxWithLog();
    const out = await checkFreshness(bus, ctx, TOOL, PREDICATE);
    expect(out.value).toBe(UNREADABLE_VALUE);
    expect(messages(lines)).toContain('decision_freshness_check_unreadable');
  });

  /**
   * The sentinel is a value like any other, and that is the point: a second
   * approval with the check STILL broken observes the same token, matches, and
   * proceeds. The human was told once. Bouncing forever is the alternative the
   * acceptance criteria rule out by name.
   */
  it('is stable across repeats, so a re-captured unreadable world stops bouncing', async () => {
    const { ctx } = ctxWithLog();
    const first = await checkFreshness(new HookBus(), ctx, TOOL, PREDICATE);
    const recaptured: FreshnessPredicate = { ...PREDICATE, value: first.value, label: null };
    const second = await checkFreshness(new HookBus(), ctx, TOOL, recaptured);
    expect(second.value).toBe(recaptured.value);
  });
});

describe('auditFreshnessPairs', () => {
  it('says nothing about a properly paired producer', async () => {
    const bus = busWith({
      [freshnessCaptureHook(TOOL)]: async () => ({ predicate: null }),
      [freshnessCheckHook(TOOL)]: async () => ({ value: 'v' }),
    });
    const { ctx, lines } = ctxWithLog();
    expect(auditFreshnessPairs(bus, ctx)).toEqual([]);
    expect(lines).toEqual([]);
  });

  /**
   * The failure the boundary review named: a `check` with no `capture` never
   * guards anything and never says so. Nothing writes the predicate it exists
   * to re-read, so every decision for that tool is silently unguarded while the
   * surface looks completely fine.
   */
  it('logs — and never throws — for a check hook with no matching capture', async () => {
    const bus = busWith({
      [freshnessCheckHook('orphan_tool')]: async () => ({ value: 'v' }),
    });
    const { ctx, lines } = ctxWithLog();
    expect(auditFreshnessPairs(bus, ctx)).toEqual([freshnessCheckHook('orphan_tool')]);
    expect(messages(lines)).toContain('decision_freshness_check_without_capture');
    expect(lines[0]!.level).toBe('error');
  });

  it('logs the reverse too — a capture nothing can ever re-read', async () => {
    const bus = busWith({
      [freshnessCaptureHook('orphan_tool')]: async () => ({ predicate: null }),
    });
    const { ctx, lines } = ctxWithLog();
    expect(auditFreshnessPairs(bus, ctx)).toEqual([freshnessCaptureHook('orphan_tool')]);
    expect(messages(lines)).toContain('decision_freshness_capture_without_check');
  });

  it('keeps each gap to one log line however often it is audited', async () => {
    const bus = busWith({
      [freshnessCheckHook('orphan_tool')]: async () => ({ value: 'v' }),
    });
    const { ctx, lines } = ctxWithLog();
    const seen = new Set<string>();
    auditFreshnessPairs(bus, ctx, seen);
    auditFreshnessPairs(bus, ctx, seen);
    expect(messages(lines)).toEqual(['decision_freshness_check_without_capture']);
  });

  it('ignores every other service on the bus', async () => {
    const bus = busWith({
      'tool:execute:request_capability': async () => ({ ok: true }),
      'tool-policy:evaluate': async () => ({ verdict: 'allow' }),
    });
    const { ctx } = ctxWithLog();
    expect(auditFreshnessPairs(bus, ctx)).toEqual([]);
  });
});
