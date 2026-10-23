import { describe, expect, it } from 'vitest';
import type { Decision } from '@/lib/workspace-api';
import { decisionProvenance } from '../decision-copy';
import { decisionFixture } from './decision-fixture';

const CHECK_IN = { routineId: 't1', taskName: 'Zero open support tickets' };
const CHECKED = ' · checked against: Thursday 9:30 still free for both of you';

describe('decisionProvenance (TASK-932)', () => {
  it('names the task a check-in raised it in', () => {
    expect(decisionProvenance(decisionFixture({ checkIn: CHECK_IN }), 'Caveman')).toBe(
      `Held during a check-in on “Zero open support tickets”${CHECKED}`,
    );
  });

  it('drops "checked against" on a stale check-in row', () => {
    expect(decisionProvenance(decisionFixture({ checkIn: CHECK_IN, status: 'stale' }), 'Caveman')).toBe(
      'Held during a check-in on “Zero open support tickets”',
    );
  });

  it('an attended row stays in its conversation', () => {
    expect(
      decisionProvenance(decisionFixture({ attendance: 'attended', checkIn: CHECK_IN }), 'Caveman'),
    ).toBe(`Held in your conversation with Caveman — it is still waiting there${CHECKED}`);
  });

  it("a repeat routine's or a webhook's run keeps the unattended-run words", () => {
    expect(decisionProvenance(decisionFixture({ checkIn: null }), 'Caveman')).toBe(
      `Held during an unattended run · Caveman ended its turn rather than wait${CHECKED}`,
    );
  });

  it('a row without checkIn, from an older server, reads as no task', () => {
    const { checkIn: _gone, ...older } = decisionFixture();
    expect(decisionProvenance(older as Decision, 'Caveman')).toBe(
      `Held during an unattended run · Caveman ended its turn rather than wait${CHECKED}`,
    );
  });
});
