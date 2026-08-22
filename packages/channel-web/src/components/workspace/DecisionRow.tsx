/**
 * One decision in the Today queue.
 *
 * Collapsed it is a scannable line. Expanded it shows the paragraph, the actual
 * artifact (the email body, the invite), what the agent promises not to do
 * until told, and the three ways out.
 *
 * PRESENTATIONAL. It renders the row it is handed and calls back; it does not
 * know what approving will do, and it must not guess — `useDecisionQueue` posts
 * and swaps in whatever the server says, and `decision-copy.ts` turns a status
 * into words. This component's whole job is layout and which control to offer.
 *
 * The states worth studying are the ones a happy-path mockup never shows:
 *
 *   - `stale` — approving re-checked the world and found it had moved, so
 *     nothing was executed and the row re-opens saying what changed. The
 *     primary button changes its wording, because approving now means
 *     something different than it did a second ago.
 *   - `approved-pending-agent` — a real yes for an action that HAS NOT
 *     HAPPENED. It reads "it will do this the next time it runs", never "Sent".
 *   - approved-but-deferred — an irreversible action, authorised, still inside
 *     its grace period. Nothing has gone out; Undo genuinely stops it.
 *   - resolved-with-undo — for ten seconds after an action, taking it back is
 *     one click. The button appears ONLY while the server says the row can
 *     still be taken back; a dead Undo on something already sent would promise
 *     a person something we cannot do.
 */
import { ArrowRight, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';
import { StateDot } from './bits';
import {
  DECISION_NOTHING_YET,
  DECISION_STALE_ADVICE,
  DECISION_STALE_LEAD,
  DECISION_STALE_SUMMARY,
  decisionOutcome,
  expiresSoonNote,
  undoSecondsLeft,
  type DecisionOutcome,
} from './decision-copy';
import { useDecisionClock } from './use-decision-clock';

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return `${h}h ago`;
}

/**
 * Where this decision came from, in the user's terms. Worth surfacing: it is
 * the difference between "your agent paused mid-conversation" and "something
 * ran at 3am and stopped to ask", and it explains why one continues in place
 * and the other lands in a queue.
 */
function provenance(d: Decision, agentName: string): string {
  return d.attendance === 'attended'
    ? `Held in your conversation with ${agentName} — it is still waiting there`
    : `Held during an unattended run · ${agentName} ended its turn rather than wait`;
}

/** The dot's colour follows the outcome's tone, so the list scans at a glance. */
const TONE_DOT: Record<DecisionOutcome['tone'], 'working' | 'resting' | 'stopped'> = {
  done: 'working',
  quiet: 'resting',
  bad: 'stopped',
};

interface Props {
  decision: Decision;
  agent: WorkspaceAgent;
  expanded: boolean;
  onToggle: () => void;
  onOpenAgent: () => void;
  onApprove: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  /** A POST is in flight for this row: the controls go quiet, never absent. */
  busy?: boolean;
  /** What the last action came back with, when it was not what was asked for. */
  notice?: string | null;
}

export function DecisionRow({
  decision: d,
  agent,
  expanded,
  onToggle,
  onOpenAgent,
  onApprove,
  onDismiss,
  onUndo,
  busy = false,
  notice = null,
}: Props) {
  // One clock for the whole row, so the countdown, the undo button and the
  // outcome sentence can never disagree about what time it is.
  const now = useDecisionClock(d);
  const outcome = decisionOutcome(d, now);
  const undoLeft = undoSecondsLeft(d, now);
  const expiry = expiresSoonNote(d, now);

  if (outcome !== null) {
    return (
      <div
        className="flex flex-col gap-1 border-b border-rule-soft px-5 py-3.5 last:border-b-0"
        data-testid={`decision-${d.id}`}
        data-status={d.status}
      >
        <div className="flex items-center gap-3">
          <StateDot state={TONE_DOT[outcome.tone]} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
            {outcome.line}
          </span>
          {undoLeft > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onUndo}
              disabled={busy}
              className="h-7 gap-1.5 text-[12px] text-primary"
            >
              <RotateCcw size={11} />
              Undo · {undoLeft}s
            </Button>
          )}
        </div>
        {outcome.note !== null && (
          <p className="pl-[22px] text-[12px] leading-relaxed text-muted-foreground">
            {outcome.note}
          </p>
        )}
        {notice !== null && (
          <p className="pl-[22px] text-[12px] leading-relaxed text-destructive">
            {notice}
          </p>
        )}
      </div>
    );
  }

  const stale = d.status === 'stale';

  return (
    <div
      className={cnRow(stale)}
      data-testid={`decision-${d.id}`}
      data-status={d.status}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left"
      >
        <StateDot state={stale ? 'stopped' : 'held'} />
        <span className="shrink-0 text-[13px] font-medium">{agent.name}</span>
        <span
          className={
            stale
              ? 'min-w-0 flex-1 truncate text-[13.5px] text-destructive'
              : 'min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground'
          }
        >
          {stale ? DECISION_STALE_SUMMARY : d.summary}
        </span>
        <span className="shrink-0 text-[12.5px] text-muted-foreground">
          {ago(d.createdAt)}
        </span>
        {expanded ? (
          <ChevronUp size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="px-5 pb-5 pl-[46px]">
          {stale && d.staleReason && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription className="text-[13px] leading-relaxed">
                <strong className="font-medium">{DECISION_STALE_LEAD}</strong>{' '}
                {d.staleReason} {DECISION_STALE_ADVICE}
              </AlertDescription>
            </Alert>
          )}

          <p className="max-w-[660px] text-[13.5px] leading-relaxed text-muted-foreground">
            {d.detail}
          </p>

          {d.preview && (
            <div className="mt-3 max-w-[660px] rounded-md bg-muted px-4 py-3.5">
              <div className="mb-1.5 text-[11.5px] text-muted-foreground">
                {d.preview.meta}
              </div>
              <div className="text-[13px] leading-relaxed">{d.preview.body}</div>
            </div>
          )}

          {/*
            The freshness label describes what was true at hold-time. Once the
            guard has tripped that sentence is false, and repeating it under an
            alert that says the opposite is worse than saying nothing — so the
            clause is dropped on a stale row rather than shown stale.
          */}
          <p className="mt-3 text-[11.5px] text-muted-foreground">
            {provenance(d, agent.name)}
            {!stale && d.freshness && ` · checked against: ${d.freshness.label}`}
          </p>

          {/*
            Doing nothing is a choice, and it is the only one on this row whose
            consequence is invisible. Shown only when the deadline is actually
            near — see `expiresSoonNote`.
          */}
          {expiry !== null && (
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">{expiry}</p>
          )}

          {notice !== null && (
            <Alert variant="destructive" className="mt-3 max-w-[660px]">
              <AlertDescription className="text-[13px] leading-relaxed">
                {notice}
              </AlertDescription>
            </Alert>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onApprove} disabled={busy}>
              {stale ? `${d.primaryLabel} anyway` : d.primaryLabel}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onOpenAgent}
              disabled={busy}
            >
              {d.secondaryLabel}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy}>
              {d.ghostLabel}
            </Button>
            <span className="ml-1 text-[11.5px] text-muted-foreground">
              {/*
                While a click is in flight we say what we are doing instead of
                repeating a promise that is no longer the current state. The
                buttons are DISABLED, not removed — a control that vanishes
                under the cursor reads as a crash.
              */}
              {busy ? 'Working on it…' : DECISION_NOTHING_YET}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={onOpenAgent}
              className="ml-auto gap-1.5 text-primary"
            >
              Open {agent.name}
              <ArrowRight size={11} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function cnRow(stale: boolean): string {
  return stale
    ? 'border-b border-rule-soft bg-destructive-soft/50 last:border-b-0'
    : 'border-b border-rule-soft last:border-b-0';
}
