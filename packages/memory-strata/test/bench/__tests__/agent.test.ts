import { describe, it, expect, vi } from 'vitest';
import { runAgent, truncateBody, MAX_INJECTED_BODY_CHARS, type AgentClient } from '../agent.js';
import type { MarkdownDoc } from '../types.js';

function makeDoc(overrides: Partial<MarkdownDoc> = {}): MarkdownDoc {
  return {
    path: overrides.path ?? 'episodes/sample',
    category: 'episodes',
    slug: 'sample',
    summary: 'curated one-line summary',
    factType: 'episode',
    headers: '',
    body: 'full doc body',
    ...overrides,
  };
}

describe('truncateBody', () => {
  it('returns short bodies unchanged', () => {
    expect(truncateBody('short')).toBe('short');
  });

  it('truncates oversized bodies with a marker', () => {
    // Pins an EXPLICIT cap rather than inheriting the default. This test used a
    // 3000-char body against an implicit 2000 and broke when the default rose
    // to 20000 — a test that silently encodes a tuning constant fails for a
    // reason that has nothing to do with what it is checking.
    const big = 'x'.repeat(3000);
    const out = truncateBody(big, 2000);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('…[truncated]');
    expect(out.slice(0, 2000)).toBe('x'.repeat(2000));
  });

  it('leaves a body under the cap alone', () => {
    const small = 'y'.repeat(100);
    expect(truncateBody(small, 2000)).toBe(small);
  });

  it('defaults to MAX_INJECTED_BODY_CHARS', () => {
    // The default is deliberately large enough that the median LongMemEval-S
    // gold doc (14,424 chars) survives intact; see the constant's docs.
    expect(truncateBody('z'.repeat(MAX_INJECTED_BODY_CHARS + 10))).toContain('…[truncated]');
    expect(truncateBody('z'.repeat(MAX_INJECTED_BODY_CHARS - 10))).not.toContain('…[truncated]');
  });

  it('respects a custom max', () => {
    expect(truncateBody('1234567890', 4)).toBe('1234' + '\n…[truncated]');
  });
});

describe('runAgent', () => {
  it('injects body content from the memoryTree when available', async () => {
    const stub: AgentClient = {
      complete: vi.fn().mockResolvedValue({ text: 'OK', usage: { in: 100, out: 5 } }),
    };
    const memoryTree = new Map<string, MarkdownDoc>([
      ['episodes/sample', makeDoc({ body: 'BODY content with the answer 42 inside.' })],
    ]);
    await runAgent(
      stub,
      { id: 'q1', text: 'What is the answer?', goldAnswer: '42' },
      [{ path: 'episodes/sample', score: 1, summary: 'curated' }],
      memoryTree,
    );
    const [args] = vi.mocked(stub.complete).mock.calls[0]!;
    expect(args.system).toContain('BODY content with the answer 42');
    expect(args.system).toContain('episodes/sample');
    expect(args.user).toContain('What is the answer?');
  });

  it('falls back to summary when memoryTree is omitted', async () => {
    const stub: AgentClient = {
      complete: vi.fn().mockResolvedValue({ text: 'OK', usage: { in: 100, out: 5 } }),
    };
    await runAgent(
      stub,
      { id: 'q1', text: 'q?', goldAnswer: 'y' },
      [{ path: 'k/a', score: 1, summary: 'The number 42 is special.' }],
    );
    const [args] = vi.mocked(stub.complete).mock.calls[0]!;
    expect(args.system).toContain('The number 42 is special');
  });

  it('truncates large retrieved-doc bodies in the injected snippets', async () => {
    const stub: AgentClient = {
      complete: vi.fn().mockResolvedValue({ text: 'OK', usage: { in: 100, out: 5 } }),
    };
    const big = 'A'.repeat(MAX_INJECTED_BODY_CHARS + 5000);
    const memoryTree = new Map<string, MarkdownDoc>([
      ['episodes/big', makeDoc({ body: big })],
    ]);
    await runAgent(
      stub,
      { id: 'q1', text: 'q?', goldAnswer: 'y' },
      [{ path: 'episodes/big', score: 1, summary: 's' }],
      memoryTree,
    );
    const [args] = vi.mocked(stub.complete).mock.calls[0]!;
    expect(args.system).toContain('…[truncated]');
    expect(args.system.length).toBeLessThan(big.length + 1000);
  });
});
