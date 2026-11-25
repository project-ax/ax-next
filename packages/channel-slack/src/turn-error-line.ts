import { turnErrorLabel } from '@ax/core/turn-error-text';
import { COPY } from './copy.js';
import { cleanDetailLine } from './format.js';
import type { TurnErrorIn } from './turn-registry.js';
import type { TurnMode } from './turn.js';

/**
 * The line a failed Slack turn ends with (TASK-1250): why it failed, in the
 * words the web app uses for the same failure, with the host's detail under
 * it.
 *
 * The turn-error's `reason` picks the sentence. It is looked up, never
 * shown: on a member's turn it can be the runner's own text. Slack's own
 * wording comes first (`SLACK_TURN_ERRORS`, lines in copy.ts), for the three
 * reasons whose web sentence points at a web-app screen; then the shared
 * table (`@ax/core/turn-error-text`), the web's own sentences. A reason in
 * neither, or none at all, keeps Slack's generic line (`COPY.turnFailed`),
 * not the web's default: Slack says its own words for what the table
 * doesn't explain. Only a Map, a Set and core's guarded `turnErrorLabel`
 * are asked, so a reason spelled `toString` or `__proto__` finds nothing.
 *
 * An outsider's turn (`external`) runs as the bot's requester, so most
 * sentences would tell a third party something false about themselves:
 * "You've reached your daily usage limit", or "needs you to sign in again"
 * with a link to settings they can't open. Only a reason in
 * `OUTSIDER_TURN_ERRORS` gets its sentence there. It is an allowlist, so a
 * reason added to the table later fails closed, and so does a mode this
 * build doesn't know, as in `turnContextFields`. The precedent is TASK-1091:
 * an outsider is told only that some tools aren't available, never the
 * owner's connector wording.
 *
 * Whether there is a detail to show is the host's decision, not this
 * file's: the host withholds it on an outsider's turn (chat-orchestrator
 * `fireTurnError`), and Slack shows whatever arrives, so that rule lives in
 * one place. The detail is untrusted (a dev service's logged path, a
 * connector's name), so it is cleaned here, once (`cleanDetailLine`), and
 * goes last, after a blank line: a paragraph of its own, so a stray `*` or
 * backtick in it can't pair with one in the sentence. It shows under the
 * generic line too.
 */

/**
 * Slack's own sentence, given the agent's Connectors settings link, for each
 * reason a live Slack turn can fail with whose web sentence points at a
 * web-app screen. The table's other such reasons (`connector-needs-sign-in`,
 * `provider-key-missing-connector-needs-sign-in`,
 * `system-prompt:brief-too-long`) are replayed rows or routine check-ins,
 * never a live Slack turn.
 */
export const SLACK_TURN_ERRORS: ReadonlyMap<string, (connectorsLink: string) => string> = new Map<
  string,
  (connectorsLink: string) => string
>([
  ['agent-model-provider-unknown', () => COPY.turnErrorProvider],
  ['connector-needs-reconnect', COPY.turnErrorReconnect],
  ['connectors-need-reconnect', COPY.turnErrorReconnectMany],
]);

/**
 * The reasons whose sentence is true whoever reads it: each says what
 * happened to the agent, its service, the workspace or the reader's own
 * message. The rest speak to the account the turn runs as (its usage, its
 * sign-ins, its storage), or never reach a live Slack turn.
 */
export const OUTSIDER_TURN_ERRORS: ReadonlySet<string> = new Set([
  'chat-run-timeout',
  'dev-service-failed',
  'agent-model-provider-unknown',
  'chat:start:usage-limit-fleet',
  'runner-boot-failed',
  'system-prompt:identity-unavailable',
  'conversation:message-not-saved',
]);

/**
 * A failed turn's closing line: its sentence, then its detail, cleaned,
 * after a blank line when anything printable is left of it. `error` is the
 * reason (and detail) the turn failed with, or undefined when it failed
 * with none (the generic line). `connectorsLink` is built by the host,
 * never from outside.
 */
export function turnFailureLine(error: TurnErrorIn | undefined, mode: TurnMode, connectorsLink: string): string {
  const sentence = sentenceFor(error?.reason, mode, connectorsLink);
  const detail = typeof error?.detail === 'string' ? cleanDetailLine(error.detail) : '';
  return detail.length > 0 ? `${sentence}\n\n${detail}` : sentence;
}

function sentenceFor(reason: string | undefined, mode: TurnMode, connectorsLink: string): string {
  if (typeof reason !== 'string') return COPY.turnFailed;
  // Exact matches only: any other mode is an outsider's (fail closed).
  const member = mode === 'dm' || mode === 'attended';
  if (!member && !OUTSIDER_TURN_ERRORS.has(reason)) return COPY.turnFailed;
  return SLACK_TURN_ERRORS.get(reason)?.(connectorsLink) ?? turnErrorLabel(reason) ?? COPY.turnFailed;
}
