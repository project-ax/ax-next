import { CONNECTORS_TAB_REASONS, ERROR_LABELS } from '@ax/core/turn-error-text';
import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';
import { cleanDetailLine } from '../format.js';
import { OUTSIDER_TURN_ERRORS, SLACK_TURN_ERRORS, turnFailureLine } from '../turn-error-line.js';
import type { TurnMode } from '../turn.js';

/** The agent's Connectors settings, as the turn builds it: host-built, never from outside. */
const LINK = 'https://ax.example/workspace/agents/agt_1/settings/connectors';
/** A dev service's diagnosis, as the host sends it in `detail` (format.test.ts). */
const DIAG = "Dev service 'kafka' couldn't write /var/lib/kafka (read-only filesystem) — add /var/lib/kafka to the service's writablePaths.";
/** A bare broadcast word as Slack could read it (copy.test.ts). */
const BROADCAST = /(?<![A-Za-z0-9])@(?:here|channel|everyone)(?![A-Za-z0-9])/i;

/** The reasons whose web sentence points at a web-app screen, and what Slack says for them instead. */
const OWN: Record<string, string> = {
  'agent-model-provider-unknown': COPY.turnErrorProvider,
  'connector-needs-reconnect': COPY.turnErrorReconnect(LINK),
  'connectors-need-reconnect': COPY.turnErrorReconnectMany(LINK),
};

describe('turnFailureLine: what a failed Slack turn says (TASK-1250)', () => {
  it('every reason in the shared table gets its sentence on a member’s turn, Slack’s own where the web’s points at a web app screen', () => {
    const reasons = Object.keys(ERROR_LABELS);
    expect(reasons.length).toBeGreaterThanOrEqual(18);
    for (const mode of ['dm', 'attended'] as const)
      for (const reason of reasons)
        expect(turnFailureLine({ reason }, mode, LINK), `${mode} ${reason}`).toBe(OWN[reason] ?? ERROR_LABELS[reason]);
  });

  it('Slack’s own wording and the outsider list name only reasons the table has', () => {
    for (const r of [...SLACK_TURN_ERRORS.keys(), ...OUTSIDER_TURN_ERRORS]) expect(Object.keys(ERROR_LABELS)).toContain(r);
    expect([...SLACK_TURN_ERRORS.keys()].sort()).toEqual(Object.keys(OWN).sort());
  });

  // Invariant 4: which reasons the Connectors tab fixes is the shared set's
  // to say, not a second list here, so the web's button and Slack's link
  // never disagree about a reason.
  it('links the Connectors settings for every reason in the shared Connectors-tab set, and for no other', () => {
    expect(CONNECTORS_TAB_REASONS.size).toBeGreaterThan(0);
    const link = `[Open Connectors](${LINK})`;
    for (const mode of ['dm', 'attended'] as const) {
      for (const reason of CONNECTORS_TAB_REASONS) expect(turnFailureLine({ reason }, mode, LINK), `${mode} ${reason}`).toContain(link);
      for (const reason of Object.keys(ERROR_LABELS).filter((r) => !CONNECTORS_TAB_REASONS.has(r)))
        expect(turnFailureLine({ reason }, mode, LINK), `${mode} ${reason}`).not.toContain(link);
    }
  });

  it.each([
    undefined,
    {},
    { reason: 'sandbox-terminated' },
    { reason: 'runner-error' },
    { reason: 'Error: mcpServers entry gmail has invalid transport' },
    { reason: 'toString' },
    { reason: '__proto__' },
    { reason: 'constructor' },
  ])('%j keeps the generic line, never the web’s default', (e) => expect(turnFailureLine(e, 'dm', LINK)).toBe(COPY.turnFailed));

  it('the detail goes under the sentence, cleaned, and under the generic line too', () => {
    expect(turnFailureLine({ reason: 'dev-service-failed', detail: DIAG }, 'dm', LINK)).toBe(
      `${ERROR_LABELS['dev-service-failed']}\n\n${cleanDetailLine(DIAG)}`,
    );
    expect(turnFailureLine({ reason: 'sandbox-terminated', detail: DIAG }, 'dm', LINK)).toBe(
      `${COPY.turnFailed}\n\n${cleanDetailLine(DIAG)}`,
    );
  });

  it('no detail, or one with nothing printable, says the sentence only', () => {
    for (const e of [{ reason: 'dev-service-failed' }, { reason: 'dev-service-failed', detail: ' \u200B ' }])
      expect(turnFailureLine(e, 'external', LINK)).toBe(ERROR_LABELS['dev-service-failed']);
  });

  it('an outsider hears a reason’s sentence only when it is true for them', () => {
    expect(OUTSIDER_TURN_ERRORS.size).toBe(7);
    for (const reason of OUTSIDER_TURN_ERRORS)
      expect(turnFailureLine({ reason }, 'external', LINK)).toBe(OWN[reason] ?? ERROR_LABELS[reason]);
    for (const reason of [
      'chat:start:usage-limit-daily',
      'chat:start:usage-limit-rate',
      'chat:start:usage-suspended',
      'chat:start:usage-check-unavailable',
      'connector-needs-reconnect',
      'connectors-need-reconnect',
    ]) {
      expect(turnFailureLine({ reason }, 'external', LINK), reason).toBe(COPY.turnFailed);
      expect(turnFailureLine({ reason }, 'dm', LINK), reason).not.toBe(COPY.turnFailed);
    }
  });

  // Fail closed, like turnContextFields and slackTurnNote: a mode this build
  // doesn't know is an outsider's, never "You've reached your daily usage limit".
  it.each(['DM', 'member', 'user', '', 'toString', undefined, null])(
    'a mode it does not know (%j) gets what an outsider gets',
    (mode) => {
      const unknown = mode as unknown as TurnMode;
      expect(turnFailureLine({ reason: 'chat:start:usage-limit-daily' }, unknown, LINK)).toBe(COPY.turnFailed);
      expect(turnFailureLine({ reason: 'connector-needs-reconnect' }, unknown, LINK)).toBe(COPY.turnFailed);
      expect(turnFailureLine({ reason: 'chat-run-timeout' }, unknown, LINK)).toBe(ERROR_LABELS['chat-run-timeout']);
    },
  );

  // The shared sentences are the web's, written for a page that shows them as
  // text. Said in a Slack Markdown reply, they hold to copy.test.ts's rules for
  // COPY's own lines: no ping, no product name, no link but Slack's own.
  it('pings nobody, names no product and links nowhere but the Connectors settings, whatever the reason or mode', () => {
    for (const mode of ['dm', 'attended', 'external'] as const) {
      for (const reason of [undefined, ...Object.keys(ERROR_LABELS)]) {
        const line = turnFailureLine(reason === undefined ? undefined : { reason }, mode, LINK);
        const label = `${mode} ${reason}`;
        expect(line.split(`[Open Connectors](${LINK})`).join(''), label).not.toMatch(/<|\]\(|https?:/);
        expect(line, label).not.toMatch(BROADCAST);
        expect(line, label).not.toMatch(/\bAX\b/);
      }
    }
  });
});
