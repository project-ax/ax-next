/**
 * ONE RULE for how a failed read is DRAWN — the register, not the words.
 *
 * `lib/http.ts` decided what a failed request SAYS. This decides what it LOOKS
 * LIKE. They are deliberately two files: the sentence has to differ per surface
 * (a whole-queue outage and a single thread's outage are not the same claim —
 * `DECISION_THREAD_READ_FAILED` in `decision-copy.ts` argues at length against
 * sharing strings between surfaces that know different things), while the
 * register has to be the SAME everywhere or a reader learns that red means
 * nothing.
 *
 * WHY THIS FILE EXISTS. Three surfaces drew the same two facts in two different
 * registers: `TodayView` and `AgentConversation` painted a failed read
 * `destructive`, `InThreadApprovals` painted it `default`. Each had a
 * defensible local reading and neither was written down, so the next surface
 * needing an error state had a coin to flip. This is the coin, called.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE
 *
 *   `destructive` when nothing further will happen unless the reader acts.
 *   `default` when something is still coming, or when the reader's action is to
 *   sign in rather than to repair.
 *
 * That is the whole thing, and every state falls out of it:
 *
 *   - `expired` → `default`, ALWAYS, no exception. A session that ran out is
 *     not a malfunction. Nothing went wrong, nobody needs to file anything, and
 *     the one move available — sign in again — is not repair. Three surfaces
 *     and two long-standing comments already agree, and `TodayView.test.tsx`
 *     pins it from both sides.
 *
 *   - `failed` with a retry genuinely armed → `default`. Something IS still
 *     coming; the state resolves itself. Only `useConversationDecisions` has
 *     this (`READ_RETRY_DELAYS_MS`, TASK-274 / PR #456), so only it may claim
 *     it. (TASK-274 is the retry. The earlier TASK-276 is a different event —
 *     it split `DecisionReadError` into `expired` vs `failed` in the first
 *     place, which is what gave the retry something to key on.)
 *
 *   - `failed` with no retry, or a retry budget spent → `destructive`. The read
 *     is terminal until the reader clicks. That is `TodayView` and
 *     `AgentConversation` on their FIRST failure — `useDecisionQueue` has no
 *     automatic retry at all, and TASK-274 deliberately did not give it one.
 *
 *   - `gone` → `destructive`, and NO retry affordance. A 404: deleted, or never
 *     yours. Nothing further happens and no action repairs it, so it fails the
 *     `default` test on both clauses. The precedent is already in the tree —
 *     `AgentView` draws an unopenable past conversation exactly this way, red
 *     with no button — and a "Try again" here would be a control that cannot
 *     work, which is the offer TASK-276 spent a whole card removing. No
 *     decisions surface produces this kind today. It is here because
 *     `AgentView` needs it next, and a kind invented at the call site is how a
 *     seventh register becomes an eighth.
 *
 * THE HONEST COUNTERARGUMENT, recorded because it nearly won. Painting the
 * in-thread card red turns its heading — 'Your assistant is waiting on you' —
 * red too, because `ui/alert.tsx` recolours the whole body. A hold existing is
 * normal, not a fault, and red arguably misattributes to it. It loses on this:
 * once the retry budget is spent, that reader is in precisely the state a
 * `TodayView` reader is in on their first failure — a hold exists, we cannot
 * read it, and nothing more happens until they click. Same state, same
 * register. The red is not about the title; it is about the unreadable queue
 * underneath it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND THE TITLE RULE, which is NOT derivable from the above and so is written
 * here rather than left to be re-derived wrongly:
 *
 *   An error alert gets an `AlertTitle` only when the surface holds POSITIVE
 *   EVIDENCE for the claim that title makes.
 *
 * `DECISION_READ_FAILED_TITLE` asserts that a hold exists. `InThreadApprovals`
 * may say it because it gates on a live `decisionRaised` frame seen this
 * page-load; `TodayView` has no such gate, so it has no title. That asymmetry
 * is the rule working, not drift, and it is NOT something to harmonize. Adding
 * a title to a surface that cannot back it is the exact defect this epic keeps
 * closing. The naive tidy-up is to give every alert a heading. Do not.
 *
 * Corollary for a surface drawing an error OVER live content it can still see:
 * it holds no evidence about the content it failed to load, so it gets no
 * title.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DOES NOT DO: choose words. Two surfaces reporting one event
 * still say it differently on purpose, and sharing the register is what buys
 * them that freedom.
 */

/**
 * Why a read did not produce what the surface asked for.
 *
 * Three kinds, because three different people have to do three different
 * things: `expired` is the reader's to sign back into, `failed` is ours to
 * retry, and `gone` is nobody's — the thing is not there.
 *
 * THE TARGET MAPPING onto `HttpError.status` from `lib/http.ts` (which
 * `WorkspaceApiError` extends) is: 401 → `expired`, 403 and 404 → `gone`,
 * everything else → `failed`. 403 joins `gone` because the consequence is
 * identical from where the reader sits — there is nothing here for you and no
 * retry changes that — even though `http.ts` keeps a separate SENTENCE for it.
 * Register and copy split here on purpose.
 *
 * TARGET, NOT PRESENT TENSE — and the gap is known debt, not a claim.
 * `gone` HAS NO PRODUCER YET. The only status-to-kind classifier that exists,
 * `toDecisionReadError` in `workspace-decisions.ts`, does `401 → expired` and
 * `everything else → failed`, so today a 403 and a 404 both arrive as `failed`
 * and get drawn red WITH a "Try again" — a control that cannot work, which is
 * exactly what the `gone` arm below exists to stop. Nothing is broken by that
 * (no decisions route answers 404 for a queue read), but do not read the
 * paragraph above as describing wiring that is already there. Wiring it is
 * TASK-296's, alongside the surfaces that need the kind.
 */
export type ReadOutcome = 'expired' | 'gone' | 'failed';

/** The two variants `ui/alert.tsx` offers. There is no warning tier. */
export type AlertRegister = 'default' | 'destructive';

/**
 * The register for a failed read. See the rule at the top of this file.
 *
 * `retrying` is a claim about the CODE, and may only be passed by a caller
 * whose code is actually doing it — the same discipline
 * `DECISION_READ_RETRYING` follows. Callers with no retry mechanism omit it,
 * which is why the quiet default is `false`: a forgotten argument softens
 * nothing, it just reports the failure as terminal, which it then is.
 */
export function readAlertVariant(
  kind: ReadOutcome,
  opts?: { retrying?: boolean },
): AlertRegister {
  if (kind === 'expired') return 'default';
  if (kind === 'gone') return 'destructive';
  return opts?.retrying === true ? 'default' : 'destructive';
}
