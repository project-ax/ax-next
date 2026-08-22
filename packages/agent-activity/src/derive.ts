import type { ActivityCounter, AgentActivity, DeriveInput, DeriveToolInput } from './types.js';

/**
 * How long the stream of steps may go quiet before the phrase stops being a
 * claim about the present.
 */
export const STALE_AFTER_MS = 90_000;

/** The floor. A user-initiated turn with no routine behind it still says something. */
export const DEFAULT_PHRASE = 'Working on your request';

/**
 * Hard ceiling on anything that reaches the line.
 *
 * `activityPhrase` is already capped at 40 by all three descriptor schemas, but
 * the T0 trigger label is not: a routine's `name` comes from a file in the
 * agent's own workspace, which means it is bounded by nobody and — since an
 * agent can author a routine — is not reliably a human's words either. A status
 * line is one line, so anything landing on it is fenced the same way: single
 * line, plain text, bounded. Truncation is marked, because a sentence that got
 * cut and does not say so is a sentence that means something else.
 */
export const MAX_PHRASE_CHARS = 60;

/**
 * Three tiers, descending precedence, and every tier below the top is always
 * available — so there is never an empty state and never a stale one.
 *
 *   T2 declared — PARKED. Not implemented. It is the only place model prose
 *                 would touch this surface, and it carries a real token cost
 *                 and a real fencing burden. T1 is the tier that ships, and
 *                 the surface has to be good at T1 or it is not good.
 *   T1 tool     — the tool manifest's `activityPhrase`. Authored in-repo,
 *                 reviewed in the same diff as the tool. Deterministic, free.
 *   T0 trigger  — the human-authored label for what started the work (a
 *                 routine's own name), else "Working on your request".
 *                 ALWAYS resolves.
 *
 * Staleness REPLACES the phrase, it does not decorate it. A hung agent that
 * keeps saying "Reading email" for forty minutes is worse than one that says
 * nothing — and the counter goes with it, because a counter frozen at 29 of 41
 * is a claim about the present that stopped being true.
 *
 * Pure, with time injected. No `Date.now()` lives in here: the same input
 * always produces the same output, which is the only reason a status line is
 * testable at all.
 */
export function deriveActivity(input: DeriveInput): AgentActivity {
  const toolPhrase = fencePhrase(input.tool?.phrase);
  const triggerPhrase = fencePhrase(input.trigger);

  const tier: { phrase: string; source: AgentActivity['source'] } =
    toolPhrase !== null
      ? { phrase: toolPhrase, source: 'tool' }
      : { phrase: triggerPhrase ?? DEFAULT_PHRASE, source: 'trigger' };

  const startedAt = new Date(input.startedAt).toISOString();
  const silentFor = input.now - input.lastStepAt;

  if (silentFor >= STALE_AFTER_MS) {
    // The elapsed gap, rounded DOWN so we never overstate the silence, and
    // never below one minute (the threshold is 90s, so "1 minute" is the
    // shortest honest thing this branch can say).
    const minutes = Math.max(1, Math.floor(silentFor / 60_000));
    return {
      phrase: `No activity for ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`,
      counter: null,
      startedAt,
      // The tier the line HAD resolved to, kept for debugging. `stale` is the
      // discriminator; nothing should read `source` as the author of `phrase`
      // while `stale` is true.
      source: tier.source,
      stale: true,
    };
  }

  return {
    phrase: tier.phrase,
    counter: toolPhrase !== null ? counterFrom(input.tool) : null,
    startedAt,
    source: tier.source,
    stale: false,
  };
}

/**
 * A counter needs both halves and neither is ours to invent: the tool must
 * have REPORTED the progress, and it must have named the unit in its own
 * manifest. Missing either — or a report that does not describe a real
 * position in a real set — renders nothing at all rather than an estimate.
 */
function counterFrom(tool: DeriveToolInput | null | undefined): ActivityCounter | null {
  if (tool === null || tool === undefined) return null;
  const unit = fencePhrase(tool.countable);
  const reported = tool.reported;
  if (unit === null || reported === undefined) return null;
  const { done, total } = reported;
  if (!Number.isInteger(done) || !Number.isInteger(total)) return null;
  if (total <= 0 || done < 0 || done > total) return null;
  return { done, total, unit };
}

/**
 * One line, plain text, bounded — or nothing at all.
 *
 * Control characters and line breaks are collapsed rather than rejected: a
 * routine named over two lines is a formatting accident, not an attack, and
 * dropping the label over it would cost a user their own words. What must not
 * survive is anything that lets a string reshape the surface it lands on.
 */
function fencePhrase(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  // Control characters (C0 and C1) become spaces, then every run of
  // whitespace collapses to one.
  const flattened = value.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flattened.length === 0) return null;
  if (flattened.length <= MAX_PHRASE_CHARS) return flattened;
  return `${flattened.slice(0, MAX_PHRASE_CHARS - 1).trimEnd()}\u2026`;
}
