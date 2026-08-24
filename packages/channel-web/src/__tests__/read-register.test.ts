/**
 * `readAlertVariant` — the one rule for how a failed read is drawn.
 *
 * These are not "does the switch switch" tests. Each one pins a sentence of the
 * rule in `lib/read-register.ts`, and each of those sentences was argued over
 * because three surfaces had already answered the same question three ways
 * (TASK-290). The mapping is the artefact `AgentView` imports next; if a future
 * card wants to move one of these, the argument to beat is in that file's
 * header, not here.
 */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../lib/http';
import {
  readAlertVariant,
  toReadOutcome,
  type ReadOutcome,
} from '../lib/read-register';
import { WorkspaceApiError, WorkspaceShapeError } from '../lib/workspace-api';

describe('readAlertVariant', () => {
  /*
    A session that ran out is not a malfunction. Nothing broke, nobody files
    anything, and the only move available — sign in again — is not repair. Red
    would contradict the sentence sitting in it: `ui/alert.tsx` recolours the
    whole body, so `destructive` would render "Nothing has been decided without
    you" in the colour of something having gone wrong.
  */
  it('never reddens an expired session, whatever else is true', () => {
    expect(readAlertVariant('expired')).toBe('default');
    expect(readAlertVariant('expired', { retrying: true })).toBe('default');
    expect(readAlertVariant('expired', { retrying: false })).toBe('default');
  });

  /*
    The clause that settled the one genuine disagreement. `TodayView` and
    `AgentConversation` read through `useDecisionQueue`, which has no automatic
    retry — #456 gave one to `useConversationDecisions` only — so their first
    failure is already terminal and already red. The in-thread card is neutral
    for the few seconds an attempt is genuinely coming, and joins them after.
  */
  it('separates a failure something is still chasing from one nothing is', () => {
    expect(readAlertVariant('failed', { retrying: true })).toBe('default');
    expect(readAlertVariant('failed', { retrying: false })).toBe('destructive');
  });

  /*
    `retrying` is a claim about the CODE — the same discipline
    `DECISION_READ_RETRYING` follows. A caller with no retry mechanism omits the
    argument, and omitting it must not quietly buy the softer register: a
    surface that promises another attempt it is not making is the defect this
    epic keeps closing.
  */
  it('treats an unstated retry as no retry, not as a maybe', () => {
    expect(readAlertVariant('failed')).toBe('destructive');
    expect(readAlertVariant('failed', {})).toBe('destructive');
  });

  /*
    `gone` fails the `default` test on both clauses at once: nothing further is
    coming, and no action the reader can take repairs it. It is the kind no
    decisions surface produces today — it exists for `AgentView` (TASK-296),
    and it exists HERE so that surface does not invent an eighth register at its
    own call site. The retry flag is not an escape hatch for it: a "Try again"
    against a 404 is a control that cannot work.
  */
  it('gives a thing that is not there the terminal register, retry or not', () => {
    expect(readAlertVariant('gone')).toBe('destructive');
    expect(readAlertVariant('gone', { retrying: true })).toBe('destructive');
  });

  /*
    `ui/alert.tsx` offers exactly two variants and there is no warning tier, so
    every kind has to land on one of them. This is what stops a fourth kind
    being added with no register and defaulting to whatever `<Alert>` does.
  */
  it('answers for every kind it admits', () => {
    const kinds: ReadOutcome[] = ['expired', 'gone', 'failed'];
    for (const kind of kinds) {
      expect(['default', 'destructive']).toContain(readAlertVariant(kind));
    }
  });
});

/*
  `toReadOutcome` is the half TASK-290 could not ship. Its own doc described
  403/404 → `gone` in the present tense while no code anywhere produced that
  kind, so the register rule above was ruling on a state that could not occur.
  These tests exist to keep that from being true again: the mapping is now
  executable, and a change to it fails here rather than in a reviewer's memory.
*/
describe('toReadOutcome', () => {
  /*
    The whole reason `gone` was added. Before this function, a 404 arrived as
    `failed`, was drawn `destructive` — correct — and handed the reader a "Try
    again" for a conversation that is never coming back. TASK-276 spent a card
    removing that offer from the decisions surfaces; this stops `AgentView`
    re-introducing it.
  */
  it('calls a 404 gone, so nothing offers to retry it', () => {
    expect(toReadOutcome(new WorkspaceApiError('/agents/ag_x', 404))).toBe('gone');
    expect(readAlertVariant(toReadOutcome(new HttpError('/x', 404)))).toBe(
      'destructive',
    );
  });

  /*
    403 joins 404 even though `http.ts` keeps a DIFFERENT SENTENCE for it
    (`HTTP_NO_ACCESS` vs `HTTP_NOT_FOUND`). The split is deliberate: what the
    reader is TOLD differs, what the reader can DO does not. Collapsing them
    here and not there is the design, not an oversight.
  */
  it('treats no-access the same as not-there, because the reader can do the same about both', () => {
    expect(toReadOutcome(new HttpError('/x', 403))).toBe('gone');
    expect(toReadOutcome(new HttpError('/x', 404))).toBe('gone');
  });

  /* A 401 is evidence about the SESSION — `auth:require-user` and nothing else. */
  it('calls a 401 expired', () => {
    expect(toReadOutcome(new WorkspaceApiError('/agents/ag_x', 401))).toBe(
      'expired',
    );
  });

  /*
    Everything with a status we have no special reading of is a blip. 503 is
    included on purpose: `workspace-files.ts` gives it a sentence of its own
    ("no workspace backend in this deployment"), but that is a COPY decision on
    one surface, and a surface without that reading should still offer a retry
    rather than invent a fourth kind here.
  */
  it('leaves every other status a retryable blip', () => {
    expect(toReadOutcome(new HttpError('/x', 500))).toBe('failed');
    expect(toReadOutcome(new HttpError('/x', 503))).toBe('failed');
    expect(toReadOutcome(new HttpError('/x', 429))).toBe('failed');
  });

  /*
    Nothing without a status can be anything but `failed`, and the two cases
    that matter are both real. `WorkspaceShapeError` is a 200 whose body we
    could not read — the server IS there, so `gone` would be a lie — and a bare
    `Error` is `Failed to fetch` or a bug in our own code. A `catch` that saw a
    browser string and reported `gone` would tell someone their conversation had
    been deleted because their wifi dropped.
  */
  it('will not upgrade a statusless failure into a verdict about the thing', () => {
    expect(toReadOutcome(new WorkspaceShapeError('/agents/ag_x'))).toBe('failed');
    expect(toReadOutcome(new Error('Failed to fetch'))).toBe('failed');
    expect(toReadOutcome('not an error at all')).toBe('failed');
    expect(toReadOutcome(undefined)).toBe('failed');
  });
});
