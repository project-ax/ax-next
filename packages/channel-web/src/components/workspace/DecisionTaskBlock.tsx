/**
 * DecisionTaskBlock — the brief a held call writes, in its own fields
 * (TASK-906).
 *
 * When an agent asks to start a "Stay on top of something" task, or to change
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
import { cn } from '@/lib/utils';
import type { DecisionTask } from '@/lib/workspace-types';
import { DECISION_REQUEST_PROVENANCE } from './DecisionRequestBlock';

export const DECISION_TASK_HEADING_START = 'The task';
export const DECISION_TASK_HEADING_CHANGE = 'What changes';
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
export function decisionTaskScrollNote(lines: number): string {
  return `Scroll to read all ${lines} lines.`;
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
 * scrolls, so a field with more lines than the box shows says how many it
 * has. It counts line breaks, so one long paragraph that only wraps past the
 * box gets no note. The contract keeps a task's padding short (no more than
 * two blank lines or 16 spaces in a row), so what fills the box is text.
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
  const lines = value.text.split('\n').length;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className={LABEL}>{label}</dt>
      <dd data-testid={testId} className={cn(VALUE, PROSE)}>
        {value.text}
      </dd>
      {lines > DECISION_TASK_VISIBLE_LINES && <dd className={LABEL}>{decisionTaskScrollNote(lines)}</dd>}
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
