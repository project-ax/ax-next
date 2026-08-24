/**
 * FireRowsTable — last N fires for a routine. No shadcn Table primitive
 * is installed; the credentials pattern uses a flex column of border-b
 * rows, and that's what we use here. Keeps the install footprint flat.
 *
 * Each row shows: timestamp · status chip · rendered prompt (mono,
 * truncated at 120 chars with show-more) · error (if any). No
 * conversation link in Phase D — routine-fired conversations are hidden
 * from the sidebar and per-fire transcripts aren't persisted, so a
 * click-through would land on an empty conversation. Deferred to a
 * follow-up.
 *
 * React key: `firedAt` plus the map index (TASK-312). It used to be the
 * store's `BIGSERIAL` row id, which is storage vocabulary and no longer
 * crosses the hook bus. `firedAt` alone is not enough — the list is already
 * scoped to one (agentId, path), postgres stores microseconds, and the wire
 * carries milliseconds, so two fires under a millisecond apart are
 * indistinguishable here. The index is the disambiguator; it's safe because
 * this list is a read-only, newest-first page that is replaced wholesale on
 * refetch, never reordered or spliced in place (`RoutinesList.loadFires`
 * assigns `{...m, [key]: rows}` — a whole new array, never a splice).
 * `FireRowsTable.test.tsx` pins it: both key failure modes (a stripped field,
 * a colliding timestamp) show up only as a React dev warning, never as a test
 * or tsc error.
 *
 * The one thing the index costs: after a "Fire now" refetch prepends a row,
 * every index shifts, so every row remounts and an expanded `PromptCell`
 * collapses. That is the whole blast radius — this subtree holds no other
 * local state — and it is why the storage id looked load-bearing when it
 * wasn't.
 */
import { useState } from 'react';
import type { Fire } from '../../lib/routines';
import { StatusChip } from './StatusChip';

function formatTimestamp(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  if (yesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

const TRUNCATE_AT = 120;

function PromptCell({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  if (prompt.length <= TRUNCATE_AT) {
    return <span className="font-mono text-[11.5px] text-foreground/85 break-all">{prompt}</span>;
  }
  return (
    <span className="font-mono text-[11.5px] text-foreground/85 break-all">
      {expanded ? prompt : `${prompt.slice(0, TRUNCATE_AT)}…`}{' '}
      <button
        type="button"
        className="inline text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? 'show less' : 'show more'}
      </button>
    </span>
  );
}

export function FireRowsTable({ fires }: { fires: Fire[] }) {
  return (
    <div className="flex flex-col border border-rule-soft rounded-md overflow-hidden">
      {fires.map((f, i) => (
        <div
          key={`${f.firedAt.toISOString()}#${i}`}
          className="px-3 py-2 border-b border-rule-soft last:border-b-0 flex flex-col gap-1"
        >
          <div className="flex items-center gap-3">
            <span className="text-[11.5px] text-muted-foreground tabular-nums w-[6.5rem] shrink-0">
              {formatTimestamp(f.firedAt)}
            </span>
            <StatusChip status={f.status} />
            <span className="text-[11px] text-muted-foreground font-mono uppercase tracking-[0.04em]">
              {f.triggerSource}
            </span>
          </div>
          {f.renderedPrompt !== null && (
            <PromptCell prompt={f.renderedPrompt} />
          )}
          {f.error !== null && (
            <span className="text-[11.5px] text-destructive break-words">{f.error}</span>
          )}
        </div>
      ))}
    </div>
  );
}
