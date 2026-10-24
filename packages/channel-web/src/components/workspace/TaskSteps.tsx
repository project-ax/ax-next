/**
 * A "Get something done" task's steps (TASK-948): the checklist its agent
 * drafts at its first check-in and then ticks, shown on the task's page under
 * the latest update, read-only.
 *
 * AGENT-WRITTEN TEXT IS DRAWN AS TEXT. A step was written by a model (or, from
 * the next card on, by the person) and the server fenced it to one line before
 * it left (`server/routes-workspace.ts`). Here it is only ever a React text
 * child: never `dangerouslySetInnerHTML`, never the markdown renderer, and no
 * attribute is built from it. `**bold**` and `<img>` show as those characters.
 * It is drawn at full contrast, because a person audits it.
 *
 * READ-ONLY IN THIS CARD. Ticking, adding and rewording a step by hand is the
 * next card (TASK-949), so the boxes here are pictures of state, not controls:
 * the state is said to a screen reader in words (`Done: ` / `Not done: `).
 */
import { useId } from 'react';
import { Square, SquareCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskStep } from '@/lib/workspace-types';

/** What a step the server couldn't read says instead of its text. */
export const STEP_CANT_SHOW = 'We can’t show this step’s text.';

export function TaskSteps({ steps, agentName }: { steps: TaskStep[]; agentName: string }) {
  const headingId = useId();
  const done = steps.filter((step) => step.done).length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className="text-[12.5px] font-medium">
        {steps.length === 0 ? 'Steps' : `Steps · ${done} of ${steps.length} done`}
      </h2>
      {steps.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {`No steps yet. ${agentName} drafts them at its next check-in.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-start gap-2 text-[13px] leading-relaxed">
              {step.done ? (
                <SquareCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Square aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="sr-only">{step.done ? 'Done: ' : 'Not done: '}</span>
              <span className="flex min-w-0 flex-col">
                <span className={cn('break-words', step.text === null && 'text-muted-foreground')}>
                  {step.text ?? STEP_CANT_SHOW}
                </span>
                {step.byAgent && (
                  <span className="break-words text-[12px] text-muted-foreground">{`added by ${agentName}`}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
