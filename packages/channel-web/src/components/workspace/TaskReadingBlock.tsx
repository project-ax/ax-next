/**
 * The agent's reading on a task's own page (TASK-952): the latest number the
 * agent reported, with its label, then a small line of the earlier readings
 * under that label, with the same values in words for screen readers. Since
 * the minimal redesign (2026-10-29) it is one row under the latest update:
 * the number, its label, muted, and the line at the end.
 *
 * ALWAYS THE AGENT'S. The (hidden) heading says "{agent}’s reading": a number the agent
 * reported at a check-in, never one ax measured or checked. Design §3 allows
 * counting, not progress bars or time estimates, so there is no fill, axis,
 * target line, percentage or forecast. The label is agent-written: the server
 * fenced it to one line of at most 40 code points (`server/routes-workspace.ts`),
 * and here it is only ever a React text child, so `<img>` shows as those
 * characters.
 *
 * The line is decorative (`aria-hidden`): "Earlier: …", hidden from view,
 * prints the same values, and stands in for a hover layer.
 */
import { useId } from 'react';
import { formatReading, readingTrend, sparklinePoints } from '@/lib/task-reading';
import type { TaskDetailReport, TaskUpdate } from '@/lib/workspace-types';

const SPARK_W = 96;
const SPARK_H = 24;
const SPARK_PAD = 2;

/** The trend as a picture: one muted line, no axes, fill, target or forecast (house rules, §3). Decorative: the same values are printed as text. */
export function ReadingSparkline({ values }: { values: readonly number[] }) {
  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-muted-foreground"
    >
      <polyline
        points={sparklinePoints(values, SPARK_W, SPARK_H, SPARK_PAD)}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** TASK-952. The agent's latest reading and the earlier ones under its label. Always "{agent}’s reading": a number the agent reported, never one ax measured. Nothing when the latest report has none. */
export function TaskReadingBlock({
  agentName,
  task,
  updates,
}: {
  agentName: string;
  task: TaskDetailReport | null;
  updates: readonly TaskUpdate[];
}) {
  const headingId = useId();
  const noteId = useId();
  const reading = task?.reading ?? null;
  if (task === null || reading === null) return null;
  const trend = readingTrend(task, updates);
  const earlier = trend.slice(0, -1);
  const note = `These are the numbers ${agentName} reported at each check-in.`;
  return (
    <section aria-labelledby={headingId} aria-describedby={noteId} className="flex flex-col">
      <h2 id={headingId} className="sr-only">
        {`${agentName}’s reading`}
      </h2>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="text-[20px] font-semibold leading-none tabular-nums">
            {formatReading(reading.value)}
          </span>
          {/* min-w-0, so a long unbroken label wraps instead of widening the page. */}
          <span className="min-w-0 break-words text-[13px] text-muted-foreground">{reading.label}</span>
        </p>
        {trend.length >= 2 && (
          <span className="ml-auto">
            <ReadingSparkline values={trend} />
          </span>
        )}
      </div>
      {/* The trend's values in words: the line above is only its picture. */}
      {earlier.length > 0 && (
        <p className="sr-only">
          {`Earlier: ${earlier.map((value) => formatReading(value)).join(' · ')}`}
        </p>
      )}
      <p id={noteId} className="sr-only">
        {note}
      </p>
    </section>
  );
}
