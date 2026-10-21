/**
 * DecisionTaskBlock — the task a held call proposes, in its own fields
 * (TASK-906).
 *
 * When an agent asks to start a "Stay on top of something" task, or to give a
 * routine a going-well-when or a task kind, the request block shows the whole
 * call as JSON. That is complete, and it isn't how a person reads a brief. This
 * block shows what they're really agreeing to: the task's name, what the agent
 * will do, how they'll know it's going well, and when it checks in. A change
 * shows only the fields it changes.
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

const LABEL = 'text-[11.5px] text-muted-foreground';
const VALUE = 'text-[13px] leading-relaxed text-foreground';
// The two prose fields keep the agent's own line breaks. The server caps them
// at 40 lines; past a screenful they scroll here, the way the request block's
// input does, so the buttons stay near the question they answer.
const PROSE = 'max-h-64 overflow-auto whitespace-pre-wrap break-words';

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
          <div className="flex flex-col gap-0.5">
            <dt className={LABEL}>{decisionTaskInstructionsLabel(agentName)}</dt>
            <dd data-testid="decision-task-instructions" className={cn(VALUE, PROSE)}>
              {task.instructions.text}
            </dd>
            {task.instructions.truncated && <dd className={LABEL}>{DECISION_TASK_TRUNCATED}</dd>}
          </div>
        )}
        {task.goodWhen !== null && (
          <div className="flex flex-col gap-0.5">
            <dt className={LABEL}>{DECISION_TASK_GOOD_WHEN_LABEL}</dt>
            <dd data-testid="decision-task-good-when" className={cn(VALUE, PROSE)}>
              {task.goodWhen.text}
            </dd>
            {task.goodWhen.truncated && <dd className={LABEL}>{DECISION_TASK_TRUNCATED}</dd>}
          </div>
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
