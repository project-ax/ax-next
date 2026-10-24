/**
 * DecisionTaskBlock — the brief a held call writes, in its own fields
 * (TASK-906).
 *
 * When an agent asks to start a task (either kind, TASK-948), or to change
 * a routine's name, instructions or going-well-when, the request block shows
 * the whole call as JSON, cut short past 2000 characters. That isn't how a
 * person reads a brief, and it isn't all of it. This block shows what they're
 * really agreeing to, whole: the task's name, what the agent will do, how
 * they'll know it's going well, and when it checks in. A change shows only the
 * fields it changes, under "What changes", whatever the routine is (the server
 * can't tell an existing task from a repeat routine).
 *
 * It sits ABOVE the request block, never instead of it: the fields it leaves
 * out (description, enabled, active hours) are approved too. Both renderers of
 * an open decision, the in-thread `ApprovalCard` and the Today queue's
 * `DecisionRow`, draw this one block, so they can't disagree.
 *
 * EVERY VALUE HERE IS AGENT-AUTHORED DATA, not our voice. The server fenced and
 * capped each one (`wireTask` in `server/routes-workspace.ts`), and this draws
 * them as plain React text: no markdown, no HTML, and no attribute built from
 * them. `**bold**` stays two asterisks either side, and `<img>` stays text.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { TASK_KIND_LABELS } from '@/lib/task-kinds';
import type { DecisionTask } from '@/lib/workspace-types';
import { DECISION_REQUEST_PROVENANCE } from './DecisionRequestBlock';

export const DECISION_TASK_HEADING_START = 'The task';
export const DECISION_TASK_HEADING_CHANGE = 'What changes';
export const DECISION_TASK_KIND_LABEL = 'Kind';
export const DECISION_TASK_NAME_LABEL = 'Name';
export function decisionTaskInstructionsLabel(agentName: string): string {
  return `What ${agentName} will do`;
}
export const DECISION_TASK_GOOD_WHEN_LABEL = 'Going well when';
export const DECISION_TASK_CHECKS_IN_LABEL = 'Checks in';
export const DECISION_TASK_TRUNCATED = 'This is only the beginning. The full text is longer.';
/**
 * How many lines the prose box shows before it scrolls: `max-h-64` is 16rem,
 * and a line of `VALUE` text is 13px × 1.625, so twelve fit and the thirteenth
 * doesn't.
 */
export const DECISION_TASK_VISIBLE_LINES = 12;
/**
 * Where a line is taken to wrap, in columns. The narrowest box we lay out is
 * on a 360px phone (the shell is one column below `md`): about 214px of text
 * in both the queue row (`pl-[46px] pr-5` inside `px-6`) and the in-thread
 * card (avatar, gap and `p-3.5` inside `px-6`). Prose in 13px Inter averages
 * about 6.5px a character, so 28 columns over-counts lines a little there and
 * a lot on a desktop.
 */
export const DECISION_TASK_LINE_COLUMNS = 28;
export const DECISION_TASK_SCROLL_NOTE = 'Scroll to read all of it.';

/**
 * Code points a renderer draws two columns wide: East Asian wide and fullwidth
 * (Hangul, CJK, kana, Yi, fullwidth forms) and emoji. Whole blocks are counted
 * where only part of one is wide, which errs wide.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23f3], [0x25fd, 0x25fe],
  [0x2600, 0x27bf], [0x2b00, 0x2bff], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x18aff],
  [0x1b000, 0x1b2ff], [0x1f000, 0x1faff], [0x20000, 0x3fffd],
];
function columns(codePoint: number): number {
  return codePoint >= 0x1100 && WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high) ? 2 : 1;
}

/**
 * Whether a field is taller than its box by an estimate from the text alone:
 * CR, LF and CRLF each start a line, and a line wraps every
 * `DECISION_TASK_LINE_COLUMNS` columns. It errs toward "taller", and it holds
 * where nothing is laid out (tests), so the note never rests on layout alone.
 * Stops counting once the answer is known.
 */
function estimatedTallerThanBox(text: string): boolean {
  let lines = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    let width = 0;
    for (const char of line) width += columns(char.codePointAt(0)!);
    lines += Math.max(1, Math.ceil(width / DECISION_TASK_LINE_COLUMNS));
    if (lines > DECISION_TASK_VISIBLE_LINES) return true;
  }
  return false;
}

/**
 * Whether the box's content is taller than the box, as the browser laid it
 * out: checked when the text changes and whenever the box resizes, as a
 * narrower window wraps the text sooner. A pixel of rounding isn't overflow.
 * False where nothing is laid out (jsdom reads every height as 0), and
 * measured once where `ResizeObserver` is missing.
 */
function useOverflows(box: RefObject<HTMLElement | null>, text: string): boolean {
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return;
    const check = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [box, text]);
  return overflows;
}

const LABEL = 'text-[11.5px] text-muted-foreground break-words';
const VALUE = 'text-[13px] leading-relaxed text-foreground';
// The two prose fields keep the agent's own line breaks. The server sends every
// valid brief whole, however long, because the person is approving all of it;
// past a screenful they scroll here, the way the request block's input does,
// so the buttons stay near the question they answer.
const PROSE = 'max-h-64 overflow-auto whitespace-pre-wrap break-words';

/**
 * One prose field: its label, the text, and what a person needs to know to
 * read all of it. On systems that hide scrollbars nothing else says the box
 * scrolls, so a field the box can't show whole says so under it: when the
 * browser's layout says so, or the text's own estimate does. The contract
 * keeps a task's padding short (no more than two blank lines or 16 spaces in
 * a row, no marks without a character), so what fills the box is text.
 */
function TaskProse({
  label,
  value,
  testId,
}: {
  label: string;
  value: { text: string; truncated: boolean };
  testId: string;
}) {
  const box = useRef<HTMLElement>(null);
  const overflows = useOverflows(box, value.text);
  return (
    <div className="flex flex-col gap-0.5">
      <dt className={LABEL}>{label}</dt>
      <dd ref={box} data-testid={testId} className={cn(VALUE, PROSE)}>
        {value.text}
      </dd>
      {(overflows || estimatedTallerThanBox(value.text)) && <dd className={LABEL}>{DECISION_TASK_SCROLL_NOTE}</dd>}
      {value.truncated && <dd className={LABEL}>{DECISION_TASK_TRUNCATED}</dd>}
    </div>
  );
}

export function DecisionTaskBlock({
  task,
  agentName,
  className,
}: {
  task: DecisionTask;
  agentName: string;
  className?: string;
}) {
  return (
    <div
      data-testid="decision-task"
      className={cn('rounded-md border border-border bg-muted px-3.5 py-2.5', className)}
    >
      <div className={LABEL}>
        {task.action === 'start' ? DECISION_TASK_HEADING_START : DECISION_TASK_HEADING_CHANGE}
      </div>
      <dl className="mt-1.5 flex flex-col gap-2">
        {/* Absent from an older host, or a kind this page has no words for: no row. */}
        {task.kind !== null && Object.hasOwn(TASK_KIND_LABELS, task.kind) && (
          <div className="flex flex-col gap-0.5">
            <dt className={LABEL}>{DECISION_TASK_KIND_LABEL}</dt>
            <dd className={cn(VALUE, 'break-words')}>{TASK_KIND_LABELS[task.kind]}</dd>
          </div>
        )}
        {task.name !== null && (
          <div className="flex flex-col gap-0.5">
            <dt className={LABEL}>{DECISION_TASK_NAME_LABEL}</dt>
            <dd className={cn(VALUE, 'break-words font-medium')}>{task.name}</dd>
          </div>
        )}
        {task.instructions !== null && (
          <TaskProse
            label={decisionTaskInstructionsLabel(agentName)}
            value={task.instructions}
            testId="decision-task-instructions"
          />
        )}
        {task.goodWhen !== null && (
          <TaskProse label={DECISION_TASK_GOOD_WHEN_LABEL} value={task.goodWhen} testId="decision-task-good-when" />
        )}
        {task.checksIn !== null && (
          <div className="flex flex-col gap-0.5">
            <dt className={LABEL}>{DECISION_TASK_CHECKS_IN_LABEL}</dt>
            <dd className={cn(VALUE, 'break-words')}>{task.checksIn}</dd>
          </div>
        )}
      </dl>
      <p className={cn(LABEL, 'mt-2')}>{DECISION_REQUEST_PROVENANCE}</p>
    </div>
  );
}
