/**
 * TaskFinishDate: a "Get something done" task's finish date on its own page,
 * and where its owner sets, changes or removes it (TASK-951).
 *
 * Closed, it is one of the page's meta chips (the minimal redesign,
 * 2026-10-29): a calendar and "Nov 14 · 9 days", whose tooltip and
 * description are the whole line, "Finish by Sat, Nov 14 · 9 days left", and
 * which is the button that changes it ("Change finish date"); while there is
 * no date, an icon-only "Add a finish date". Open, it is a Popover under the
 * chip holding a native date field with Save, Remove date and Cancel. The
 * date is optional and only a person sets it: no tool or model reaches this
 * route.
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
 * cancelling (or Escape) hand focus back to the button that replaces it (the
 * chip, or Add a finish date once the date is gone), unless the person moved
 * on meanwhile. A click outside the Popover closes it and leaves focus where
 * the click put it; the Popover's own focus moves are switched off, so these
 * rules are the only ones.
 * When that button is disabled because the refusal can't be retried, focus goes
 * to the refusal's message instead (a disabled button can't take it). A
 * press that fails leaves the field open and focuses it again, since the
 * pressed button went disabled while it sent and dropped focus on `<body>`.
 */
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { CalendarDays, CalendarPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ROUTINE_FINISH_BY_LATEST } from '@ax/routines-contract';
import { HTTP_SESSION_ENDED, isConfirmedRefusal, logRequestFailure } from '@/lib/http';
import { browserTimeZone, browserToday, finishByLine, finishByPickIssue } from '@/lib/task-finish-by';
import { finishByShort } from '@/lib/task-meta';
import { workspaceApi } from '@/lib/workspace-api';
import type { TaskFinishBy } from '@/lib/workspace-types';
import { IconAction } from './task-bits';

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

  /** A click outside: the field closes, and focus stays where the click put it. */
  const dismiss = () => {
    if (saving) return;
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

  // A refusal that pressing again can't fix outlives Cancel: the date shown may be stale
  // (the task is gone) and Change would only fail the same way, so say so and stop offering it.
  const stuck = !editing && failure?.dead === true ? failure : null;
  const describedBy =
    [finishBy === null ? null : lineId, stuck === null ? null : errorId].filter(Boolean).join(' ') ||
    undefined;
  const line = finishBy === null ? null : finishByLine(finishBy);
  const dead = failure?.dead === true;
  return (
    <>
      <Popover open={editing} onOpenChange={(next) => (next ? open() : dismiss())}>
        <PopoverTrigger asChild>
          {finishBy === null ? (
            <IconAction
              ref={trigger}
              icon={CalendarPlus}
              label="Add a finish date"
              variant="ghost"
              className="size-7 text-muted-foreground"
              disabled={stuck !== null}
              aria-describedby={describedBy}
            />
          ) : (
            <ChipTip line={line ?? ''}>
              <Button
                ref={trigger}
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-1.5 text-[13px] font-normal"
                disabled={stuck !== null}
                aria-describedby={describedBy}
              >
                <CalendarDays data-icon="inline-start" aria-hidden="true" />
                <span aria-hidden="true">{finishByShort(finishBy)}</span>
                <span className="sr-only">Change finish date</span>
              </Button>
            </ChipTip>
          )}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72"
          // This component moves focus itself (WHERE FOCUS GOES); Escape is the form's. The field
          // is in a portal that mounts a render after the Popover opens, so it's focused from here.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (saving) e.preventDefault();
          }}
        >
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
        </PopoverContent>
      </Popover>
      {/* The whole line, said as the chip's description and shown in its tooltip. */}
      {line !== null && (
        <span id={lineId} className="sr-only">
          {line}
        </span>
      )}
      {stuck !== null && (
        <FieldError id={errorId} ref={stuckMessage} tabIndex={-1} className="basis-full text-[13px]">
          {stuck.line}
        </FieldError>
      )}
    </>
  );
}

/**
 * The chip's whole line on hover and focus. Only a picture of the words: the
 * same line is the chip's description (`aria-describedby`), which is what a
 * screen reader hears.
 */
function ChipTip({ line, children, ...props }: { line: string; children: ReactElement }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild {...props}>
          {children}
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[12px]" aria-hidden="true">
          {line}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
