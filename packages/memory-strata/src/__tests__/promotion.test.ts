// Promotion gate tests (Phase 2A, I11).
//
// I11: defense-in-depth — Phase 1's sensitive-gate runs at write-time;
// Phase 2A's gate runs at promotion-time. A regression in Phase 1's gate
// must NOT let credentials reach `docs/`, where they'd be cached and
// re-loaded into the agent's context next turn.
//
// These tests cover: confidence gating (below threshold, at threshold,
// above threshold) and the I11 sensitive re-run fixture.

import { describe, expect, it } from 'vitest';
import { decidePromotion, CONFIDENCE_THRESHOLD } from '../promotion.js';
import type { InboxFile } from '../inbox-store.js';

/** Build a minimal InboxFile for testing — no filesystem needed. */
function makeInboxFile(overrides: {
  confidence: number;
  body?: string;
  summary?: string;
}): InboxFile {
  return {
    path: 'permanent/memory/inbox/2026-05-10T00:00:00.000Z.md',
    frontmatter: {
      id: 'test-id',
      type: 'inbox/observation',
      created: '2026-05-10T00:00:00.000Z',
      confidence: overrides.confidence,
      pinned: false,
      summary: overrides.summary ?? '',
    },
    body: overrides.body ?? '',
  };
}

describe('CONFIDENCE_THRESHOLD', () => {
  it('is 0.7', () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.7);
  });
});

describe('decidePromotion', () => {
  // Fixture A — high confidence, benign body
  it('promotes when confidence is 0.85 and body is benign', () => {
    const file = makeInboxFile({ confidence: 0.85, body: 'User prefers React' });
    const result = decidePromotion(file);
    expect(result).toEqual({ promote: true });
  });

  // Fixture B — low confidence
  it('rejects with low-confidence when confidence is 0.5', () => {
    const file = makeInboxFile({ confidence: 0.5, body: 'User prefers React' });
    const result = decidePromotion(file);
    expect(result).toEqual({ promote: false, reason: 'low-confidence' });
  });

  // Fixture C — I11 regression fixture: high confidence but contains a fake API key
  it('rejects with sensitive when confidence is 0.85 but body contains a fake Anthropic API key (I11)', () => {
    // 21 X's after "sk-ant-" — matches /sk-ant-[A-Za-z0-9_-]{20,}/g
    const file = makeInboxFile({
      confidence: 0.85,
      body: 'My key is sk-ant-XXXXXXXXXXXXXXXXXXXXX and it works',
    });
    const result = decidePromotion(file);
    expect(result).toMatchObject({
      promote: false,
      reason: 'sensitive',
    });
    if (!result.promote && result.reason === 'sensitive') {
      expect(result.kinds).toContain('anthropic-api-key');
    }
  });

  // Threshold edge: exactly 0.7 should promote (>= threshold)
  it('promotes when confidence is exactly 0.7 (at threshold)', () => {
    const file = makeInboxFile({ confidence: 0.7, body: 'User prefers Vue' });
    const result = decidePromotion(file);
    expect(result).toEqual({ promote: true });
  });

  // Threshold edge: 0.69 should NOT promote (below threshold)
  it('rejects when confidence is 0.69 (just below threshold)', () => {
    const file = makeInboxFile({ confidence: 0.69, body: 'User prefers Vue' });
    const result = decidePromotion(file);
    expect(result).toEqual({ promote: false, reason: 'low-confidence' });
  });

  // Confidence check runs BEFORE sensitive gate (short-circuit)
  it('rejects low-confidence even when body is also sensitive', () => {
    const file = makeInboxFile({
      confidence: 0.4,
      body: 'key is sk-ant-XXXXXXXXXXXXXXXXXXXXX',
    });
    const result = decidePromotion(file);
    // Low confidence is caught first — the sensitive gate needn't run
    expect(result).toEqual({ promote: false, reason: 'low-confidence' });
  });

  // Sensitive gate checks summary field as well as body
  it('rejects when summary contains a credential even if body is clean', () => {
    const file = makeInboxFile({
      confidence: 0.85,
      summary: 'key sk-ant-XXXXXXXXXXXXXXXXXXXXX was rotated',
      body: 'No credential here',
    });
    const result = decidePromotion(file);
    expect(result).toMatchObject({
      promote: false,
      reason: 'sensitive',
    });
    if (!result.promote && result.reason === 'sensitive') {
      expect(result.kinds).toContain('anthropic-api-key');
    }
  });

  // Multiple sensitive kinds should all be surfaced
  it('reports multiple sensitive kinds when both body and summary have issues', () => {
    const file = makeInboxFile({
      confidence: 0.9,
      summary: 'AKIAIOSFODNN7EXAMPLE was used',
      body: 'sk-ant-XXXXXXXXXXXXXXXXXXXXX is the backup key',
    });
    const result = decidePromotion(file);
    expect(result).toMatchObject({ promote: false, reason: 'sensitive' });
    if (!result.promote && result.reason === 'sensitive') {
      expect(result.kinds).toContain('aws-access-key');
      expect(result.kinds).toContain('anthropic-api-key');
    }
  });

  // Regression: same pattern fires on BOTH summary AND body — kinds must be deduplicated
  it('deduplicates kinds when the same pattern fires on summary AND body', () => {
    const file = makeInboxFile({
      confidence: 0.85,
      summary: 'Token: sk-ant-XXXXXXXXXXXXXXXXXXXXX',
      body: 'Same token again: sk-ant-XXXXXXXXXXXXXXXXXXXXX',
    });
    const decision = decidePromotion(file);
    if (decision.promote === false && decision.reason === 'sensitive') {
      expect(decision.kinds).toEqual(['anthropic-api-key']);
    } else {
      throw new Error(`expected sensitive rejection, got ${JSON.stringify(decision)}`);
    }
  });
});
