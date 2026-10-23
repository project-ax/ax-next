/**
 * TaskReplyBox: where a task's owner writes to their agent about that task
 * (TASK-931).
 *
 * STANDALONE ON PURPOSE. It takes the task's address, the agent's name and two
 * flags, and nothing from the page's data, so TASK-933 can put the same box on
 * Today. Today has to decide `canStart` itself: a `TaskRow` carries no
 * permissions.
 *
 * THE TEXT IS THE PERSON'S OWN. It goes to the host as written (no trimming,
 * no rewriting); the host stores it, shows it in Updates, and quotes the last
 * few replies in every later check-in message. Here it is only ever a
 * textarea's value and never markup. Before sending, the box runs the same
 * `RoutineReplyTextSchema` the host does, so a too-long or invisible-character
 * reply is told so in the person's words instead of bouncing as a bare 400.
 *
 * THE REQUEST ID. A send that nobody can confirm (the network dropped, the
 * host answered 5xx, 408 or 429, the answer was unreadable) may or may not have been
 * stored. Sending the same words again carries the SAME id, so the host
 * recognises the retry and never stores or starts a check-in twice. The id is
 * kept only for the same text: a person who fixes a typo after "couldn't
 * confirm" is writing a new reply, and a replay would silently keep the first
 * text while the box cleared. It is dropped on success and on a confirmed
 * refusal (any other 1xx-4xx answer), where a retry is a new attempt.
 *
 * WHERE FOCUS GOES. A clicked Send goes disabled while it sends (and stays
 * disabled once the box clears), which drops focus on `<body>`. When the send
 * settles, if focus is on `<body>` or on Send it moves back to the textarea,
 * so the next reply can be typed at once. Someone who moved on meanwhile stays
 * where they went (TaskPage's rule).
 */
import { useCallback, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { RoutineReplyTextSchema } from '@ax/routines-contract';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { HTTP_SESSION_ENDED, HttpError, logRequestFailure } from '@/lib/http';
import { workspaceApi } from '@/lib/workspace-api';
import type { TaskReplyCheckIn } from '@/lib/workspace-types';

const UNCONFIRMED =
  'We couldn’t confirm your reply was sent. Try again, and it won’t be sent twice.';
const NOT_FOUND = 'We couldn’t find this task any more. It may have been deleted.';
const AS_WRITTEN = 'We couldn’t send that reply as written. Change it and try again.';

/**
 * Statuses below 500 that still leave it unknown whether the reply was
 * stored: a timeout or a rate limit can come from anything in front of the
 * host, and neither is the person's text being wrong.
 */
const UNCONFIRMED_4XX: ReadonlySet<number> = new Set([408, 429]);

/** A refusal (1xx-4xx, but 408 and 429) is an answer; anything else leaves it unknown whether the reply was stored. */
function confirmed(e: unknown): e is HttpError {
  return e instanceof HttpError && e.status >= 1 && e.status < 500 && !UNCONFIRMED_4XX.has(e.status);
}

function failureLine(e: unknown): string {
  if (!confirmed(e)) return UNCONFIRMED;
  if (e.status === 401) return HTTP_SESSION_ENDED;
  if (e.status === 403 || e.status === 404) return NOT_FOUND;
  return AS_WRITTEN;
}

function helperLine(agentName: string, enabled: boolean, canStart: boolean): string {
  if (!enabled) {
    return canStart
      ? `It’s paused, so ${agentName} will read this once you resume it.`
      : `It’s paused, so ${agentName} will read this once it’s resumed.`;
  }
  return canStart
    ? `${agentName} reads your replies every time it checks in. Sending one starts a check-in now.`
    : `${agentName} reads your replies every time it checks in.`;
}

function sentLine(agentName: string, checkIn: TaskReplyCheckIn, enabled: boolean): string {
  switch (checkIn) {
    case 'started':
    case 'replayed':
      return `Sent. ${agentName} started checking in.`;
    case 'paused':
      return `Sent. ${agentName} will read it when you resume the task.`;
    case 'not-allowed':
      // A paused task has no next check-in until someone resumes it.
      return enabled
        ? `Sent. ${agentName} will read it at its next check-in.`
        : `Sent. ${agentName} will read it once the task is resumed.`;
  }
}

export function TaskReplyBox({
  agentId,
  routineId,
  agentName,
  enabled,
  canStart,
  onSent,
  inputRef,
}: {
  agentId: string;
  routineId: string;
  agentName: string;
  /** Whether the task is switched on (not paused). */
  enabled: boolean;
  /** The task's `permissions.fire`: whether a reply can start a check-in (for its owner, also whether they can resume it). */
  canStart: boolean;
  onSent: (checkIn: TaskReplyCheckIn) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const ids = useId();
  const helperId = `${ids}-helper`;
  const errorId = `${ids}-error`;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<TaskReplyCheckIn | null>(null);
  const [failure, setFailure] = useState<{ line: string; rule: boolean } | null>(null);
  const pending = useRef<{ text: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const sendButton = useRef<HTMLButtonElement | null>(null);

  // The box needs its own handle on the textarea as well as the caller's.
  const setTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textarea.current = el;
      if (typeof inputRef === 'function') inputRef(el);
      else if (inputRef) inputRef.current = el;
    },
    [inputRef],
  );

  const send = async () => {
    if (inFlight.current || text.trim() === '') return;
    const rule = RoutineReplyTextSchema.safeParse(text);
    if (!rule.success) {
      setSent(null);
      setFailure({ line: rule.error.issues[0]?.message ?? AS_WRITTEN, rule: true });
      return;
    }
    inFlight.current = true;
    setSending(true);
    setSent(null);
    setFailure(null);
    const op =
      pending.current !== null && pending.current.text === text
        ? pending.current
        : { text, requestId: crypto.randomUUID() };
    pending.current = op;
    try {
      const answer = await workspaceApi.sendTaskReply(agentId, routineId, {
        text: op.text,
        requestId: op.requestId,
      });
      pending.current = null;
      setText('');
      setSent(answer.checkIn);
      onSent(answer.checkIn);
    } catch (e) {
      logRequestFailure(e, 'task-reply');
      if (confirmed(e)) pending.current = null;
      setFailure({ line: failureLine(e), rule: false });
    } finally {
      inFlight.current = false;
      setSending(false);
      const at = document.activeElement;
      if (at === null || at === document.body || at === sendButton.current) {
        textarea.current?.focus();
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <FieldGroup>
        <Field data-invalid={failure?.rule === true ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-text`}>{`Reply to ${agentName} about this task`}</FieldLabel>
          <Textarea
            id={`${ids}-text`}
            ref={setTextarea}
            rows={3}
            value={text}
            readOnly={sending}
            aria-describedby={failure === null ? helperId : `${helperId} ${errorId}`}
            aria-invalid={failure?.rule === true ? true : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setSent(null);
              setFailure(null);
            }}
            onKeyDown={onKeyDown}
          />
          <FieldDescription id={helperId}>{helperLine(agentName, enabled, canStart)}</FieldDescription>
          {failure !== null && <FieldError id={errorId}>{failure.line}</FieldError>}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            ref={sendButton}
            type="submit"
            variant="secondary"
            disabled={sending || text.trim() === ''}
          >
            {sending && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Send
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {sent === null ? '' : sentLine(agentName, sent, enabled)}
          </p>
        </div>
      </FieldGroup>
    </form>
  );
}
