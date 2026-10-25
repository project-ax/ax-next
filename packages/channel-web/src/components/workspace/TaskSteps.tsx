/**
 * A "Get something done" task's steps (TASK-948): the checklist its agent
 * drafts at its first check-in, shown on the task's page under the latest
 * update. Its owner changes it here (TASK-949): they tick or untick any step,
 * add one, and reword or delete any step, the agent's included, from the
 * step's options menu. No approval, and no new revision.
 *
 * WHO MAY. The page is its owner's only: the route answers 404 alike for a
 * task that isn't there and one that isn't yours, and `routines:set-steps`
 * checks the owner again under the routine's row lock. A refusal reads "We
 * couldn't find this task any more." It asks the page to read the task again
 * (`onRefused`), since a task marked done since the page read it is refused
 * the same way (TASK-950): the re-read shows which it was.
 *
 * ONE CHANGE PER PRESS, ONE AT A TIME. A tick, an untick, an Add, a Save or a
 * Delete sends one change, the same kind the agent's report sends
 * (`RoutineStepOpSchema`). Its answer is the steps as they are now, which the
 * page swaps in without reading the task again (`onChanged`); one that skipped
 * the change says the list was reloaded, and why when the answer shows it (an
 * add whose step is now listed, or one at the cap). A box isn't
 * ticked ahead of the answer. While a change is out every control waits, the
 * open input goes read-only (so focus stays in it), and Escape does nothing,
 * so the editor whose change is out is still there for its answer. Delete asks
 * nothing: a step is one line, and it can be added back.
 *
 * BEFORE A CHANGE GOES. An Add or a Save runs the contract's own text rule
 * (`RoutineStepTextSchema`) on the text as typed, so the person reads what to
 * fix, and where, rather than a bare 400; an Add whose text is already listed
 * says so rather than being skipped. Then the text goes as the page will show
 * it, whitespace runs folded and trimmed (the route's fence), so what's stored
 * is what the person saw, and the host's duplicate check, which compares
 * stored text, sees what the page does. A Save that only changes spaces sends
 * nothing: a reword makes a step the agent added the person's (its editor
 * says so), and a change nobody can see mustn't.
 *
 * THE REQUEST ID (`TaskReplyBox`'s rule, `isConfirmedRefusal`). A change that
 * nobody can confirm (no answer, a 5xx, a 408 or 429, an answer we couldn't
 * read) may or may not have applied. The same change again carries the same
 * id, so the host answers with the steps as they are instead of applying it
 * twice. Any other change gets a new id, and an answer or an answered refusal
 * ends the id.
 *
 * WHERE FOCUS GOES, once the answer is on screen, and only from `<body>` or
 * inside this section (someone who moved on stays where they went): after a
 * tick, that step's box; after Save or Cancel, that step's options button;
 * after an Add, the add input, which stays open for the next step; after the
 * add editor's Cancel, Add a step (or, while that's disabled at the cap, the
 * last step's box); after a Delete, or any change whose step is no longer
 * listed, the box of the step now in its place, else of the one before it,
 * else Add a step. A failed Delete goes back to its options button, and a
 * failed Add or Save to its input, so pressing again retries.
 *
 * A DONE TASK'S STEPS ARE A RECORD (TASK-950). Once a person marks the task
 * done, `readOnly` shows its steps as they were left, ticked or not, with
 * nothing to change: each box is a picture of its state, said to a screen
 * reader in words (`Done: ` / `Not done: `), and there are no options and no
 * Add a step. An editor left open closes, and a change's failure or skipped
 * line goes. If that editor held changed text the steps don't show, or a
 * refused change (the task was marked done elsewhere first) isn't on the
 * record, the status line says "This task was marked done, so that change
 * wasn’t saved." A refused change can be on the record: a retry of one that
 * landed, its first try unconfirmed, is refused once the task is Done. A
 * change nobody could confirm says nothing more: the record shows whether it
 * landed. Reopening the task brings the controls back. `footer` is drawn
 * last, under the steps and their controls: the page's Mark done.
 *
 * AGENT- OR PERSON-WRITTEN TEXT IS DRAWN AS TEXT. A step was written by a
 * model or by the person, and the server fenced it to one line before it left
 * (`server/routes-workspace.ts`). Here it is only ever a React text child, or
 * an input's value while it's reworded: never `dangerouslySetInnerHTML`, never
 * the markdown renderer, and no attribute is built from it. `**bold**` and
 * `<img>` show as those characters. It is drawn at full contrast, because a
 * person audits it. Each box is named by its step's text and described by
 * "added by {agent}", and each options button points at the text it opens
 * (`aria-describedby`), so fifty of them still say which is which.
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { MoreHorizontal, Plus, Square, SquareCheck } from 'lucide-react';
import {
  ROUTINE_STEP_TEXT_MAX_CHARS,
  ROUTINE_STEPS_MAX,
  RoutineStepTextSchema,
  type RoutineStepOp,
} from '@ax/routines-contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { HTTP_SESSION_ENDED, isConfirmedRefusal, isSessionEnded, logRequestFailure } from '@/lib/http';
import type { AlertRegister } from '@/lib/read-register';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/workspace-api';
import type { TaskStep, TaskStepsResponse } from '@/lib/workspace-types';

/** What a step the server couldn't read says instead of its text. */
export const STEP_CANT_SHOW = 'We can’t show this step’s text.';

const UNCONFIRMED = 'We couldn’t confirm that change. Try again, and it won’t happen twice.';
const NOT_FOUND = 'We couldn’t find this task any more. It may have been deleted.';
const AS_WRITTEN = 'We couldn’t save that step as written. Change it and try again.';
const SKIPPED = 'That step was changed or removed meanwhile, so we’ve loaded the latest.';
const DUPLICATE = 'That step is already on the list.';
const ALREADY_LISTED = 'That step is already on the list, so we’ve loaded the latest.';
const AT_CAP = `A task can have up to ${ROUTINE_STEPS_MAX} steps.`;
/** A skipped add at the cap: the list filled meanwhile. The open add editor's note already states the cap. */
const CAP_REACHED = `The list reached ${ROUTINE_STEPS_MAX} steps meanwhile, so we’ve loaded the latest.`;
/** A change the person had out, or was typing, when the task was marked done elsewhere (TASK-950). */
const NOT_SAVED_DONE = 'This task was marked done, so that change wasn’t saved.';

/** A failed change, worded from its status, never from the server's message. */
function failureLine(e: unknown): string {
  if (!isConfirmedRefusal(e)) return UNCONFIRMED;
  if (e.status === 401) return HTTP_SESSION_ENDED;
  if (e.status === 403 || e.status === 404) return NOT_FOUND;
  return AS_WRITTEN;
}

/** A step's text as the page shows it: whitespace runs folded to one space, then trimmed (the route's fence). */
function asShown(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Why the host skipped a change, read from its answer. The host skips an add
 * whose text is already listed, or one past the cap (the agent's add rules),
 * and any change whose step has gone meanwhile.
 */
function skippedLine(op: RoutineStepOp, steps: TaskStep[]): string {
  if (op.op !== 'add') return SKIPPED;
  const text = asShown(op.text);
  if (steps.some((step) => step.text !== null && asShown(step.text) === text)) return ALREADY_LISTED;
  if (steps.length >= ROUTINE_STEPS_MAX) return CAP_REACHED;
  return SKIPPED;
}

/** The first thing the contract's text rule finds wrong, in the person's words, or null. */
function textProblem(text: string): string | null {
  const rule = RoutineStepTextSchema.safeParse(text);
  return rule.success ? null : (rule.error.issues[0]?.message ?? AS_WRITTEN);
}

/** What an editor says under its input: a rule its text breaks (`invalid`), or why its change failed. */
type EditorFailure = { line: string; invalid: boolean };

/** The one open editor: a step being reworded (`opened`: the text it opened with), or a new one. */
type Editor =
  | { kind: 'edit'; id: string; text: string; opened: string; failure: EditorFailure | null }
  | { kind: 'add'; text: string; failure: EditorFailure | null };

/**
 * What the person was changing when the task turned Done (TASK-950): an
 * editor's text, or a change refused as not there (403 or 404). Kept so the
 * record can say it wasn't saved, unless the record shows it was.
 */
type Left =
  | { kind: 'edit'; id: string; text: string; opened: string }
  | { kind: 'add'; text: string }
  | { kind: 'refused'; op: RoutineStepOp };

/** Whether a step's text, as shown, is `text`. */
function reads(step: TaskStep, text: string): boolean {
  return step.text !== null && asShown(step.text) === asShown(text);
}

/**
 * Whether the steps show what was left. An editor's text: left as it opened
 * (nothing to save, even if its step has gone), or once a step reads it. A
 * refused change: once the steps show it, since a retry of one that landed
 * (its first try unconfirmed) is refused too once the task is Done.
 */
function onRecord(left: Left, steps: TaskStep[]): boolean {
  switch (left.kind) {
    case 'add':
      return asShown(left.text) === '' || steps.some((step) => reads(step, left.text));
    case 'edit':
      return (
        asShown(left.text) === asShown(left.opened) ||
        steps.some((step) => step.id === left.id && reads(step, left.text))
      );
    case 'refused': {
      const { op } = left;
      switch (op.op) {
        case 'tick':
        case 'untick':
          return steps.some((step) => step.id === op.id && step.done === (op.op === 'tick'));
        case 'remove':
          return !steps.some((step) => step.id === op.id);
        case 'edit':
          return steps.some((step) => step.id === op.id && reads(step, op.text));
        case 'add':
          return steps.some((step) => reads(step, op.text));
      }
    }
  }
}

/** Where focus goes once a change's answer, or a closed editor, is on screen (see WHERE FOCUS GOES). */
type FocusTarget =
  | { to: 'box' | 'options'; id: string; index: number }
  | { to: 'in-place-of'; index: number }
  | { to: 'editor' }
  | { to: 'add' };

/** Where a change came from, which is where its failure is said. */
type Place = 'editor' | 'list';

/** A ref that files a step's element under its id while it's mounted. */
function fileUnder(map: Map<string, HTMLButtonElement>, id: string) {
  return (el: HTMLButtonElement | null) => {
    if (el === null) map.delete(id);
    else map.set(id, el);
  };
}

export function TaskSteps({
  agentId,
  routineId,
  steps,
  agentName,
  onChanged,
  onRefused,
  readOnly = false,
  footer,
}: {
  agentId: string;
  routineId: string;
  steps: TaskStep[];
  agentName: string;
  /** Each answer's steps, which the page shows in place of its own. */
  onChanged: (steps: TaskStep[]) => void;
  /** A change was refused as not there or not theirs (403 or 404): the page reads the task again (TASK-950). */
  onRefused?: () => void;
  /** A Done task's steps (TASK-950): shown as they are, with nothing to change. */
  readOnly?: boolean;
  /** Drawn last, under the steps and their controls (TASK-950: the page's Mark done). */
  footer?: ReactNode;
}) {
  const ids = useId();
  const headingId = `${ids}-heading`;
  const capId = `${ids}-cap`;
  const [editor, setEditor] = useState<Editor | null>(null);
  // The change out, if any, by where it came from: only its own editor's button spins.
  const [busy, setBusy] = useState<Place | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  // `refused`: the change, answered 403 or 404 (said once the task is Done, A DONE TASK'S STEPS), else null.
  const [listFailure, setListFailure] = useState<{
    line: string;
    register: AlertRegister;
    refused: RoutineStepOp | null;
  } | null>(null);
  const [left, setLeft] = useState<Left | null>(null);
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  const focusNext = useRef<FocusTarget | null>(null);
  const section = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const boxes = useRef(new Map<string, HTMLButtonElement>());
  const optionButtons = useRef(new Map<string, HTMLButtonElement>());

  // The step being reworded left the list (a re-read, or another change's
  // answer), so its editor closes. Adjusted while rendering (React's "storing
  // information from previous renders"), as `TaskNotes` does. Focus isn't
  // moved for it: the person may be mid-word, and a box under their next
  // space would tick.
  if (editor?.kind === 'edit' && !steps.some((step) => step.id === editor.id)) setEditor(null);
  // A Done task's steps change no more (TASK-950): an open editor closes, and a change's failure or
  // skipped line goes, so the record never shows a change it can't take. What the person was changing
  // is kept, to say it wasn't saved. Adjusted while rendering, too. Level-triggered, not on the change
  // to `readOnly`: a change out when the task turned Done may fail after it.
  if (readOnly && (editor !== null || listFailure !== null || skipped !== null)) {
    const leaving: Left | null =
      listFailure?.refused != null
        ? { kind: 'refused', op: listFailure.refused }
        : editor === null
          ? null
          : editor.kind === 'edit'
            ? { kind: 'edit', id: editor.id, text: editor.text, opened: editor.opened }
            : { kind: 'add', text: editor.text };
    if (leaving !== null) setLeft(leaving);
    setEditor(null);
    setListFailure(null);
    setSkipped(null);
  }
  // Reopened: the controls are back, and the line goes.
  if (!readOnly && left !== null) setLeft(null);
  const notSaved = readOnly && left !== null && !onRecord(left, steps);

  const done = steps.filter((step) => step.done).length;
  const atCap = steps.length >= ROUTINE_STEPS_MAX;

  // Add a step, or the last step's box while Add a step is disabled at the cap, or the add input while it's open.
  const addOrLast = (): HTMLElement | null => {
    const add = addButton.current;
    if (add !== null && !add.disabled) return add;
    const last = steps.at(-1);
    return (last === undefined ? undefined : boxes.current.get(last.id)) ?? input.current;
  };
  // The box of the step now at `index`, else of the one before it, else Add a step.
  const inPlaceOf = (index: number): HTMLElement | null => {
    const step = steps[Math.min(index, steps.length - 1)];
    return (step === undefined ? undefined : boxes.current.get(step.id)) ?? addOrLast();
  };
  const focusFor = (target: FocusTarget): HTMLElement | null => {
    switch (target.to) {
      case 'box':
        return boxes.current.get(target.id) ?? inPlaceOf(target.index);
      case 'options':
        return optionButtons.current.get(target.id) ?? inPlaceOf(target.index);
      case 'in-place-of':
        return inPlaceOf(target.index);
      case 'editor':
        return input.current;
      case 'add':
        return addOrLast();
    }
  };

  // After every commit: once nothing is out, focus goes where the last press
  // asked. A layout effect, so it lands in the same commit that enables the
  // controls again, and a keystroke right then isn't lost on `<body>`.
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (target === null || busy !== null) return;
    focusNext.current = null;
    const at = document.activeElement;
    if (at !== null && at !== document.body && !section.current?.contains(at)) return;
    const el = focusFor(target);
    if (el !== null && el !== at) el.focus();
  });

  const change = async (
    op: RoutineStepOp,
    place: Place,
    focus: { answered: FocusTarget; failed: FocusTarget },
    answered?: (answer: TaskStepsResponse) => void,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(place);
    setSkipped(null);
    setListFailure(null);
    setEditor((open) => (open === null ? open : { ...open, failure: null }));
    const key = JSON.stringify(op);
    const ticket =
      pending.current?.key === key ? pending.current : { key, requestId: crypto.randomUUID() };
    pending.current = ticket;
    try {
      const answer = await workspaceApi.setTaskSteps(agentId, routineId, {
        requestId: ticket.requestId,
        ops: [op],
      });
      pending.current = null;
      onChanged(answer.steps);
      setSkipped(answer.skipped > 0 ? skippedLine(op, answer.steps) : null);
      answered?.(answer);
      focusNext.current = focus.answered;
    } catch (e) {
      logRequestFailure(e, 'task-steps');
      if (isConfirmedRefusal(e)) pending.current = null;
      // Not there or not theirs, maybe since the page read it: marked done (TASK-950), or deleted. The page reads it
      // again and shows which; a Done task's steps then show as its record, and this line goes with the controls,
      // leaving the record's own (NOT_SAVED_DONE).
      const refused = isConfirmedRefusal(e) && (e.status === 403 || e.status === 404);
      if (refused) onRefused?.();
      const line = failureLine(e);
      if (place === 'editor') {
        setEditor((open) => (open === null ? open : { ...open, failure: { line, invalid: false } }));
      } else {
        // An ended session isn't a malfunction (`lib/read-register.ts`).
        setListFailure({ line, register: isSessionEnded(e) ? 'default' : 'destructive', refused: refused ? op : null });
      }
      focusNext.current = focus.failed;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const tick = (step: TaskStep, index: number, checked: boolean) => {
    const back: FocusTarget = { to: 'box', id: step.id, index };
    void change({ op: checked ? 'tick' : 'untick', id: step.id }, 'list', { answered: back, failed: back });
  };

  const remove = (step: TaskStep, index: number) => {
    void change({ op: 'remove', id: step.id }, 'list', {
      answered: { to: 'in-place-of', index },
      failed: { to: 'options', id: step.id, index },
    });
  };

  const openEditor = (next: Editor) => {
    if (inFlight.current) return;
    setEditor(next);
    focusNext.current = { to: 'editor' };
  };

  const closeEditor = () => {
    if (editor === null || inFlight.current) return;
    const { id } = editor.kind === 'edit' ? editor : { id: null };
    focusNext.current =
      id === null
        ? { to: 'add' }
        : { to: 'options', id, index: steps.findIndex((step) => step.id === id) };
    setEditor(null);
  };

  const typed = (text: string) =>
    setEditor((open) => (open === null ? open : { ...open, text, failure: null }));

  const refuse = (line: string) => {
    setEditor((open) => (open === null ? open : { ...open, failure: { line, invalid: true } }));
    focusNext.current = { to: 'editor' };
  };

  const save = () => {
    if (editor?.kind !== 'edit' || inFlight.current) return;
    const index = steps.findIndex((step) => step.id === editor.id);
    const step = steps[index];
    if (step === undefined) return;
    if (asShown(editor.text) === asShown(step.text ?? '')) {
      closeEditor();
      return;
    }
    const problem = textProblem(editor.text);
    if (problem !== null) {
      refuse(problem);
      return;
    }
    void change(
      { op: 'edit', id: step.id, text: asShown(editor.text) },
      'editor',
      { answered: { to: 'options', id: step.id, index }, failed: { to: 'editor' } },
      () => setEditor(null),
    );
  };

  const add = () => {
    if (editor?.kind !== 'add' || atCap || inFlight.current) return;
    const { text } = editor;
    const problem = textProblem(text);
    if (problem !== null) {
      refuse(problem);
      return;
    }
    if (steps.some((step) => step.text !== null && asShown(step.text) === asShown(text))) {
      refuse(DUPLICATE);
      return;
    }
    void change(
      { op: 'add', text: asShown(text) },
      'editor',
      { answered: { to: 'editor' }, failed: { to: 'editor' } },
      // Applied, it empties for the next step; skipped, it keeps its text beside the skipped line.
      (answer) => {
        if (answer.skipped === 0) setEditor((open) => (open?.kind === 'add' ? { ...open, text: '' } : open));
      },
    );
  };

  return (
    <section ref={section} aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className="text-[12.5px] font-medium">
        {steps.length === 0 ? 'Steps' : `Steps · ${done} of ${steps.length} done`}
      </h2>
      {steps.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {readOnly ? 'No steps.' : `No steps yet. Add one, or ${agentName} drafts them at its next check-in.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {steps.map((step, index) => {
            if (readOnly) return <DoneStep key={step.id} step={step} agentName={agentName} />;
            const editing = editor?.kind === 'edit' && editor.id === step.id ? editor : null;
            return (
              <StepRow
                key={step.id}
                step={step}
                agentName={agentName}
                busy={busy !== null}
                editing={editing !== null}
                boxRef={fileUnder(boxes.current, step.id)}
                optionsRef={fileUnder(optionButtons.current, step.id)}
                onTick={(checked) => tick(step, index, checked)}
                onEdit={() => {
                  const text = step.text ?? '';
                  openEditor({ kind: 'edit', id: step.id, text, opened: text, failure: null });
                }}
                onDelete={() => remove(step, index)}
              >
                {editing !== null && (
                  <StepEditor
                    label="Edit step"
                    submit="Save"
                    text={editing.text}
                    failure={editing.failure}
                    note={step.byAgent ? `Once you save it, ${agentName} reads this as your words.` : null}
                    busy={busy !== null}
                    sending={busy === 'editor'}
                    canSubmit
                    inputRef={input}
                    onText={typed}
                    onSubmit={save}
                    onCancel={closeEditor}
                  />
                )}
              </StepRow>
            );
          })}
        </ul>
      )}
      {listFailure !== null && (
        <Alert variant={listFailure.register}>
          <AlertDescription>{listFailure.line}</AlertDescription>
        </Alert>
      )}
      {readOnly ? null : editor?.kind === 'add' ? (
        <StepEditor
          label="New step"
          submit="Add"
          text={editor.text}
          failure={editor.failure}
          note={atCap ? AT_CAP : null}
          busy={busy !== null}
          sending={busy === 'editor'}
          canSubmit={!atCap}
          inputRef={input}
          onText={typed}
          onSubmit={add}
          onCancel={closeEditor}
        />
      ) : (
        <div className="flex flex-col items-start gap-1">
          <Button
            ref={addButton}
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-3"
            disabled={busy !== null || atCap}
            aria-describedby={atCap ? capId : undefined}
            onClick={() => openEditor({ kind: 'add', text: '', failure: null })}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add a step
          </Button>
          {atCap && (
            <p id={capId} className="text-[12px] text-muted-foreground">
              {AT_CAP}
            </p>
          )}
        </div>
      )}
      {/*
        Mounted with the section, not with its sentence: a region created and
        filled together is the announcement screen readers drop (TASK-651).
      */}
      <p role="status" className="text-[12.5px] text-muted-foreground empty:-mt-2.5">
        {notSaved ? NOT_SAVED_DONE : (skipped ?? '')}
      </p>
      {footer}
    </section>
  );
}

/**
 * One step of a Done task (TASK-950): its state as a picture, said in words,
 * then its text and who added it. Laid out as `StepRow` is, without a control.
 */
function DoneStep({ step, agentName }: { step: TaskStep; agentName: string }) {
  const Box = step.done ? SquareCheck : Square;
  return (
    <li className="flex min-w-0 items-start gap-2 text-[13px] leading-relaxed">
      <Box aria-hidden="true" className="mt-2 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col py-1.5">
        <span className={cn('break-words', step.text === null && 'text-muted-foreground')}>
          <span className="sr-only">{step.done ? 'Done: ' : 'Not done: '}</span>
          {step.text ?? STEP_CANT_SHOW}
        </span>
        {step.byAgent && (
          <span className="break-words text-[12px] text-muted-foreground">{`added by ${agentName}`}</span>
        )}
      </span>
    </li>
  );
}

/** One step: its box, its text and who added it (or its editor), and its options. */
function StepRow({
  step,
  agentName,
  busy,
  editing,
  boxRef,
  optionsRef,
  onTick,
  onEdit,
  onDelete,
  children,
}: {
  step: TaskStep;
  agentName: string;
  busy: boolean;
  editing: boolean;
  boxRef: (el: HTMLButtonElement | null) => void;
  optionsRef: (el: HTMLButtonElement | null) => void;
  onTick: (checked: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  /** The step's editor, while it's open. */
  children?: ReactNode;
}) {
  const ids = useId();
  const textId = `${ids}-text`;
  const byId = `${ids}-by`;
  return (
    <li className="flex min-w-0 items-start gap-2 text-[13px] leading-relaxed">
      <Checkbox
        ref={boxRef}
        className="mt-2"
        checked={step.done}
        disabled={busy}
        aria-labelledby={textId}
        aria-describedby={step.byAgent ? byId : undefined}
        onCheckedChange={(checked) => {
          // Radix can also report 'indeterminate', which no step is.
          if (typeof checked === 'boolean') onTick(checked);
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col py-1.5">
        {/* While the step is reworded its text stays, unseen, so its box keeps its name. */}
        <span
          id={textId}
          className={cn('break-words', step.text === null && 'text-muted-foreground', editing && 'sr-only')}
        >
          {step.text ?? STEP_CANT_SHOW}
        </span>
        {step.byAgent && (
          <span
            id={byId}
            className={cn('break-words text-[12px] text-muted-foreground', editing && 'sr-only')}
          >
            {`added by ${agentName}`}
          </span>
        )}
        {children}
      </div>
      {!editing && (
        <StepOptions textId={textId} busy={busy} buttonRef={optionsRef} onEdit={onEdit} onDelete={onDelete} />
      )}
    </li>
  );
}

/**
 * A step's options menu: Edit and Delete, on every step. Not modal, because
 * Delete takes its own row away (`AgentConnectors`' rule: a modal menu would
 * leave `<body>` unclickable). The choice runs once the menu has closed and
 * handed focus back to its button (`FactsMemory`'s `MemoryActions`), so
 * Edit's input and Delete's answer each take focus from a button still there.
 */
function StepOptions({
  textId,
  busy,
  buttonRef,
  onEdit,
  onDelete,
}: {
  textId: string;
  busy: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const chosen = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={(el) => {
            trigger.current = el;
            buttonRef(el);
          }}
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          disabled={busy}
          aria-label="Step options"
          aria-describedby={textId}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const action = chosen.current;
          chosen.current = null;
          if (action === null) return;
          event.preventDefault();
          trigger.current?.focus();
          setTimeout(action, 0);
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => {
              chosen.current = onEdit;
            }}
          >
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              chosen.current = onDelete;
            }}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One line of text to save, for a step being reworded or a new one: the
 * contract's cap on its input, its note and its failure under it, then its two
 * buttons. Enter saves (it's a form) and Escape cancels, but neither while a
 * change is out: the input goes read-only, so focus stays in it.
 */
function StepEditor({
  label,
  submit,
  text,
  failure,
  note,
  busy,
  sending,
  canSubmit,
  inputRef,
  onText,
  onSubmit,
  onCancel,
}: {
  label: string;
  submit: string;
  text: string;
  failure: EditorFailure | null;
  note: string | null;
  busy: boolean;
  /** The change out is this editor's own, so its button spins. */
  sending: boolean;
  canSubmit: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onText: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const inputId = `${ids}-input`;
  const noteId = `${ids}-note`;
  const errorId = `${ids}-error`;
  const describedBy = [note === null ? null : noteId, failure === null ? null : errorId]
    .filter((id) => id !== null)
    .join(' ');
  const invalid = failure?.invalid === true ? true : undefined;
  return (
    <form
      className="w-full"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <FieldGroup className="gap-2">
        <Field data-invalid={invalid} className="gap-1.5">
          <FieldLabel htmlFor={inputId} className="sr-only">
            {label}
          </FieldLabel>
          <Input
            id={inputId}
            ref={inputRef}
            value={text}
            maxLength={ROUTINE_STEP_TEXT_MAX_CHARS}
            readOnly={busy}
            aria-invalid={invalid}
            aria-describedby={describedBy === '' ? undefined : describedBy}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              // `onCancel` does nothing while a change is out.
              onCancel();
            }}
          />
          {note !== null && <FieldDescription id={noteId}>{note}</FieldDescription>}
          {failure !== null && <FieldError id={errorId}>{failure.line}</FieldError>}
        </Field>
        <Field orientation="horizontal" className="gap-2">
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !canSubmit}>
            {sending && <Spinner data-icon="inline-start" aria-hidden="true" />}
            {submit}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
