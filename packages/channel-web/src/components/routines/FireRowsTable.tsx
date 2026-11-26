/**
 * FireRowsTable — last N fires for a routine, as a compact `List` (the list
 * owns the dividers).
 *
 * Each row shows: timestamp · status chip · rendered prompt (mono,
 * truncated at 120 chars with show-more) · warning (if the run went without a
 * connector; muted, NOT an error) · error (if any). No
 * conversation link in Phase D — routine-fired conversations are hidden
 * from the sidebar and per-fire transcripts aren't persisted, so a
 * click-through would land on an empty conversation. Deferred to a
 * follow-up.
 *
 * React key: `firedAt` plus the map index (TASK-312). It used to be the
 * store's `BIGSERIAL` row id, which is storage vocabulary and no longer
 * crosses the hook bus. `firedAt` alone is not enough — the list is already
 * scoped to one (agentId, routineId), the wire
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
import { List, ListRow, Notice, Stack, StatusBadge, Timestamp, type StatusTone } from '@project-ax/ui';
import type { Fire, FireStatus } from '../../lib/routines';
import { RunWarning } from './RunWarning';

/** One run's status, as that run's fire row recorded it. A silenced run reads as intentional, not broken. */
const FIRE_TONE: Record<FireStatus, StatusTone> = { ok: 'success', silenced: 'neutral', error: 'danger' };

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
    <List label="Recent runs" density="compact">
      {fires.map((f, i) => {
        const hasDetail = f.renderedPrompt !== null || f.warning !== null || f.error !== null;
        return (
          <ListRow
            key={`${f.firedAt}#${i}`}
            title={`Run by ${f.triggerSource}`}
            meta={<>
              <StatusBadge tone={FIRE_TONE[f.status]} dot>{f.status}</StatusBadge>
              {' '}<Timestamp value={f.firedAt} />
            </>}
            {...(hasDetail ? { below: (
              <Stack gap="xs">
                {f.renderedPrompt !== null && <PromptCell prompt={f.renderedPrompt} />}
                {f.warning !== null && <RunWarning text={f.warning} />}
                {/* The whole message, wrapping: the run's status badge above is the short form. announce off, so a
                    page of old failures doesn't read itself out when the list opens. */}
                {f.error !== null && <Notice tone="danger" announce={false}>{f.error}</Notice>}
              </Stack>
            ) } : {})}
          />
        );
      })}
    </List>
  );
}
