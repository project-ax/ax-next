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
      {fires.map((f) => (
        <div
          key={f.id}
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
