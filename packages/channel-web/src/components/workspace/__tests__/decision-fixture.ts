/**
 * ONE fixture, shared by every test that draws a decision.
 *
 * There are three renderers over one Decision row (the Today queue, the
 * in-thread card, and one day Slack). If each test file built its own fixture,
 * the renderers could drift apart and every test would still pass — each one
 * agreeing with the shape it invented. So the shape lives here, and
 * `decision-renderers.test.tsx` draws two components from this exact object and
 * compares what they say.
 *
 * It is the WIRE shape: no `call`, no `callFingerprint`, no `ownerUserId`. If a
 * test wants to prove the tool input never reaches a renderer, the honest way to
 * do that is that there is nowhere to put it.
 */
import type { Decision } from '@/lib/workspace-api';

export function decisionFixture(over: Partial<Decision> = {}): Decision {
  return {
    id: 'd-marcus',
    agentId: 'scheduler',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'unattended',
    status: 'pending',
    irreversible: false,
    freshness: {
      kind: 'slot-etag',
      value: 'etag-free',
      label: 'Thursday 9:30 still free for both of you',
    },
    summary: 'Move your 1:1 with Marcus to Thursday 9:30?',
    detail: 'It clashes with the board prep.',
    preview: null,
    primaryLabel: 'Move it',
    secondaryLabel: 'Pick another time',
    ghostLabel: 'Leave it',
    approvedText: 'Scheduler moved your 1:1 with Marcus to Thursday 9:30',
    dismissedText: 'You left the Marcus 1:1 where it was',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    resolvedAt: null,
    staleReason: null,
    pendingUntil: null,
    undoable: false,
    ...over,
  };
}

/** A row the server has just resolved and can still take back. */
export function resolvedFixture(
  status: Decision['status'],
  over: Partial<Decision> = {},
): Decision {
  return decisionFixture({
    status,
    resolvedAt: new Date().toISOString(),
    undoable: true,
    ...over,
  });
}
