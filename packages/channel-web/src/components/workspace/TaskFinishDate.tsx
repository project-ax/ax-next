/**
 * TaskFinishDate: a "Get something done" task's finish date on its own page,
 * and where its owner sets, changes or removes it (TASK-951).
 *
 * Closed, it is one line, "Finish by Sat, Nov 14 · 9 days left", and a Change
 * button (or only "Add a finish date" while there is none). Open, it is a
 * native date field with Save, Remove date and Cancel. The date is optional
 * and only a person sets it: no tool or model reaches this route.
 *
 * STANDALONE ON PURPOSE, like `TaskReplyBox`: it takes the task's address, the
 * agent's name, the date as the host last sent it and an `onSaved` callback,
 * and nothing else from the page. The page owns the date and shows the host's
 * answer at once (`useTask`'s `applyAnswer`).
 *
 * THE DAYS LEFT COME FROM THE HOST. The browser counts nothing, so this
 * component never works them out from the browser's clock. It knows its own
 * "today", for the field's `min` and the "not in the past" check, which is the
 * reader's own calendar day, the one they are picking against. And it sends its
 * own time zone with a date (`browserTimeZone`, TASK-955), which the host keeps
 * and counts in when the task has no zone of its own. The host decides the rest.
 *
 * A SAVE NOBODY COULD CONFIRM (the network dropped, 5xx, 408 or 429, an
 * unreadable answer) may or may not have landed. Pressing Save again sends the
 * same date, which is safe: a date set twice is the same date. A refusal that
 * pressing again can't fix (the task is gone, or the session ended) disables
 * Save and Remove date and keeps saying so, even after Cancel, where Change (or Add a
 * finish date) goes disabled under the same line.
 *
 * WHERE FOCUS GOES. Opening the field focuses it. Saving, removing and
 * cancelling hand focus back to the button that replaces it (Change, or Add a
 * finish date once the date is gone), unless the person moved on meanwhile.
 * When that button is disabled because the refusal can't be retried, focus goes
 * to the refusal's message instead (a disabled button can't take it). A
 * press that fails leaves the field open and focuses it again, since the
 * pressed button went disabled while it sent and dropped focus on `<body>`.
 */
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ROUTINE_FINISH_BY_LATEST } from '@ax/routines-contract';
import { HTTP_SESSION_ENDED, isConfirmedRefusal, logRequestFailure } from '@/lib/http';
import { browserTimeZone, browserToday, finishByLine, finishByPickIssue } from '@/lib/task-finish-by';
import { workspaceApi } from '@/lib/workspace-api';
import type { TaskFinishBy } from '@/lib/workspace-types';

const UNCONFIRMED = 'We couldn’t save that date. Try again.';
const NOT_FOUND = 'We couldn’t find this task any more. It may have been deleted.';
const NOT_A_REAL_DATE = 'Pick a real date.';

interface Failure {
  line: string;
  /** The date itself is what's wrong: the field is marked invalid. */
  rule: boolean;
  /** Pressing again can't help (the task is gone, or the session ended). */
  dead: boolean;
}

function failureOf(e: unknown): Failure {
  // `isConfirmedRefusal`: a refusal (1xx-4xx, but 408 and 429) is an answer; anything else leaves it unknown
  // whether the date was saved, and a date set twice is the same date, so pressing again is safe.
  if (!isConfirmedRefusal(e)) return { line: UNCONFIRMED, rule: false, dead: false };
  if (e.status === 401) return { line: HTTP_SESSION_ENDED, rule: false, dead: true };
  if (e.status === 403 || e.status === 404) return { line: NOT_FOUND, rule: false, dead: true };
  if (e.status === 400) return { line: NOT_A_REAL_DATE, rule: true, dead: false };
  return { line: UNCONFIRMED, rule: false, dead: false };
}

export function TaskFinishDate({
  agentId,
  routineId,
  agentName,
  finishBy,
  onSaved,
}: {
  agentId: string;
  routineId: string;
  agentName: string;
  /** The date as the host last sent it, or null for none. */
  finishBy: TaskFinishBy | null;
  onSaved: (finishBy: TaskFinishBy | null) => void;
}) {
  const ids = useId();
  const inputId = `${ids}-date`;
  const lineId = `${ids}-line`;
  const helperId = `${ids}-helper`;
  const errorId = `${ids}-error`;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  // The reader's own today, read when the field opens and kept while it is open.
  const [today, setToday] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  // The closed view's kept refusal, there only while the task is gone or the session ended.
  const stuckMessage = useRef<HTMLDivElement | null>(null);
  const focusTrigger = useRef(false);

  // Opening focuses the field; closing hands focus to the button that replaces it. A save closes
  // the field and hands the page its answer in one batch, so the new button is there by now. When
  // that button went disabled (a refusal that can't be retried), a disabled button can't take
  // focus, so the message under it does.
  //
  // A LAYOUT effect, so focus moves in the same commit that removes the field (TASK-960). The
  // host's answer arrives outside any event, so React commits it on a later task, and a plain
  // effect then runs after paint: for that frame focus sat on <body>, and a key pressed in it
  // went nowhere.
  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus();
    } else if (focusTrigger.current) {
      focusTrigger.current = false;
      (stuckMessage.current ?? trigger.current)?.focus();
    }
  }, [editing]);

  const open = () => {
    setValue(finishBy?.date ?? '');
    setToday(browserToday());
    setFailure((f) => (f?.dead === true ? f : null));
    setEditing(true);
  };

  const close = () => {
    focusTrigger.current = true;
    setEditing(false);
    setFailure((f) => (f?.dead === true ? f : null));
  };

  /** Whether focus is somewhere the person would not have chosen: nowhere, or on the field's own controls. */
  const focusIsAdrift = () => {
    const at = document.activeElement;
    return at === null || at === document.body || form.current?.contains(at) === true;
  };

  const save = async (next: string | null) => {
    if (inFlight.current) return;
    if (next !== null) {
      const issue = finishByPickIssue(next, today);
      if (issue !== null) {
        setFailure({ line: issue, rule: true, dead: false });
        return;
      }
    }
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      // The browser's zone travels only with a date: removing the date clears both (TASK-955).
      const answer = await workspaceApi.setTaskFinishBy(
        agentId,
        routineId,
        next,
        next === null ? null : browserTimeZone(),
      );
      if (focusIsAdrift()) focusTrigger.current = true;
      setEditing(false);
      onSaved(answer.finishBy);
    } catch (e) {
      logRequestFailure(e, 'task-finish-by');
      setFailure(failureOf(e));
      if (focusIsAdrift()) input.current?.focus();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Escape' || saving) return;
    e.preventDefault();
    close();
  };

  if (!editing) {
    // A refusal that pressing again can't fix outlives Cancel: the date shown may be stale
    // (the task is gone) and Change would only fail the same way, so say so and stop offering it.
    const stuck = failure?.dead === true ? failure : null;
    const describedBy =
      [finishBy === null ? null : lineId, stuck === null ? null : errorId].filter(Boolean).join(' ') ||
      undefined;
    return (
      <div className="flex flex-wrap items-center gap-x-3">
        {finishBy !== null && (
          <p id={lineId} className="text-[13px] text-muted-foreground">
            {finishByLine(finishBy)}
          </p>
        )}
        <Button
          ref={trigger}
          type="button"
          variant="link"
          size="sm"
          className="px-0"
          disabled={stuck !== null}
          aria-describedby={describedBy}
          onClick={open}
        >
          {finishBy === null ? 'Add a finish date' : 'Change'}
        </Button>
        {stuck !== null && (
          <FieldError
            id={errorId}
            ref={stuckMessage}
            tabIndex={-1}
            className="basis-full text-[13px]"
          >
            {stuck.line}
          </FieldError>
        )}
      </div>
    );
  }

  const dead = failure?.dead === true;
  return (
    <form
      ref={form}
      // The browser's own "value must be later" bubble would stop Save and speak in its own words.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(value);
      }}
      onKeyDown={onKeyDown}
    >
      <FieldGroup>
        <Field data-invalid={failure?.rule === true ? true : undefined}>
          <FieldLabel htmlFor={inputId}>Finish by</FieldLabel>
          <Input
            id={inputId}
            ref={input}
            type="date"
            min={today}
            max={ROUTINE_FINISH_BY_LATEST}
            value={value}
            readOnly={saving}
            className="w-auto self-start"
            aria-describedby={failure === null ? helperId : `${helperId} ${errorId}`}
            aria-invalid={failure?.rule === true ? true : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setFailure((f) => (f?.dead === true ? f : null));
            }}
          />
          <FieldDescription id={helperId}>
            {`${agentName} will tell you if the steps left won’t fit.`}
          </FieldDescription>
          {failure !== null && <FieldError id={errorId}>{failure.line}</FieldError>}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="secondary" disabled={saving || dead}>
            {saving && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Save
          </Button>
          {finishBy !== null && (
            <Button
              type="button"
              variant="ghost"
              disabled={saving || dead}
              onClick={() => void save(null)}
            >
              Remove date
            </Button>
          )}
          <Button type="button" variant="ghost" disabled={saving} onClick={close}>
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
