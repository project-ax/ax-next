/**
 * THE WORDS FOR STOPPING A REPLY (TASK-688).
 *
 * Kept out of `AgentView.tsx` for the one reason the other copy tables there
 * are not: tests assert on these sentences, and a test importing a component
 * file to reach a string is a test that also imports the component's world.
 * Not in `decision-copy.ts`, which is a decisions vocabulary by its own stated
 * design — nothing here is about a decision.
 */
import { HTTP_SESSION_ENDED } from '@/lib/http';
import type { ReadOutcome } from '@/lib/read-register';

/**
 * The note that follows a reply the person stopped.
 *
 * What it does NOT say is "what was written so far is above". It usually is,
 * but a stop can land before the first word, and a note that points at a reply
 * that is not there is a small lie in the one sentence whose job is to reassure.
 * It says what happened and what to do next, and stops.
 */
export const STOPPED_NOTICE =
  'You stopped this reply. Send another message whenever you want to carry on.';

/**
 * The strip's sentence when the STOP itself did not go through — three
 * outcomes, one sentence each, and `Record<ReadOutcome, …>` so the compiler
 * notices a fourth.
 *
 * Not `TURN_COPY`. That table says "That reply didn’t finish", which is exactly
 * wrong here: after a failed stop the reply is very likely still running, and
 * telling the person it ended would have them wait for a Resend that never
 * appears. `failed` says what we do not know ("may still be running") rather
 * than what we would like to be true.
 */
export const STOP_COPY: Record<ReadOutcome, string> = {
  expired: HTTP_SESSION_ENDED,
  gone: 'We couldn’t stop that reply because this conversation is no longer available. It may have been removed, or is no longer yours.',
  failed:
    'We couldn’t stop that reply just now. It may still be running — try Stop again in a moment.',
};

/**
 * How long a confirmed Stop waits for the reply stream to say the turn is over
 * before the view stops waiting (ms).
 *
 * The host answering `interrupted: true` means the stop was QUEUED. The runner
 * then has to notice it, and a tool that ignores cancellation can take a while
 * to let go. Waiting for the stream's own `done` is right (it is the only frame
 * that says the transcript is settled) — but a Stop button that never comes
 * back is a worse failure than a reply that trails off, so after this long the
 * view closes the stream itself, re-reads the thread, and gives the composer
 * back.
 */
export const STOP_FALLBACK_MS = 8000;
