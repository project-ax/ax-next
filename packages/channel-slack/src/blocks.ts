import { COPY } from './copy.js';
import { cleanPromptSubject } from './format.js';
import type { SlackBlock } from './slack-api.js';

/**
 * The Block Kit an approval prompt is drawn with (TASK-1095). A call held in
 * a DM or an attended channel turn gets a prompt in the thread, after the
 * reply: what it asks about, Allow and Deny, and who may answer.
 *
 * Three parts, each trusted differently:
 *   - The SUBJECT is words from outside COPY (a decision's host-authored
 *     summary, which can name a tool; a host; a skill's description). It is
 *     cleaned (`cleanPromptSubject`) and shown only as `plain_text`, which
 *     Slack doesn't format: never mrkdwn, never the notification text.
 *   - The BUTTONS carry nothing but the prompt's id, an opaque value the host
 *     minted. What a click does is decided by the open prompt that id names
 *     and by the checks a click must pass, never by anything this message
 *     says.
 *   - The CONTEXT is COPY lines only, mrkdwn so that the bare Today URL is a
 *     link: who may answer, and Today, where the same question waits. The
 *     link is how an install connected before buttons existed (Slack has
 *     nowhere to send its clicks) still gets an answer in. A question that
 *     doesn't wait in Today (a host the sandbox was refused: channel-web
 *     keeps those out of it) gets no Today line, since it would send the
 *     person nowhere.
 *
 * A request Slack can't take at all (a skill that needs a key) is drawn
 * with `linkOnlyBlocks`: its subject, and a line sending the person to the
 * web app, with no buttons.
 *
 * Give `outcomeBlocks` the subject exactly as `promptBlocks` got it: each
 * cleans it, and cleaning cleaned text reads differently (format.ts), so an
 * answered prompt would no longer show the question as it was asked.
 *
 * No `block_id`s: Slack mints them, and wants a new one per update.
 */

/** What a click on one of a prompt's buttons asks for. */
export type PromptAction = 'allow' | 'deny';

/** The Allow button's `action_id`, which Slack sends back with a click on it. */
export const ACTION_ALLOW = 'ax_prompt_allow';
/** The Deny button's `action_id`. */
export const ACTION_DENY = 'ax_prompt_deny';
/** A bot request DM's Approve button (TASK-1170): a URL button, so its click is ignored. */
export const ACTION_BOT_REQUEST_APPROVE = 'ax_bot_request_approve';
/** A bot request DM's Decline button; its `value` is the request id. */
export const ACTION_BOT_REQUEST_DECLINE = 'ax_bot_request_decline';

/**
 * The action a clicked button's `action_id` names: one of the two above,
 * matched exactly (no case folding, no trimming), else null.
 */
export function actionOf(actionId: string): PromptAction | null {
  if (actionId === ACTION_ALLOW) return 'allow';
  if (actionId === ACTION_DENY) return 'deny';
  return null;
}

/** Text Slack shows as written: no formatting, links, mentions or emoji codes. */
function plainText(text: string): SlackBlock {
  return { type: 'plain_text', text, emoji: false };
}

/** A COPY line as mrkdwn, so that Slack links the bare URL in it. */
function mrkdwn(line: string): SlackBlock {
  return { type: 'mrkdwn', text: line };
}

/**
 * The subject's section, the same on a prompt and on its outcome. Slack
 * refuses a section with empty text, so a subject with nothing printable
 * left reads as the generic ask.
 */
function subjectSection(subject: string, fallback: string = COPY.heldAsked): SlackBlock {
  return { type: 'section', text: plainText(cleanPromptSubject(subject) || fallback) };
}

/**
 * An open prompt: the subject, then Allow and Deny (both carrying
 * `promptId`), then who may answer and the Today link (none when `todayLink`
 * is null: the question doesn't wait in Today). `text` is the notification
 * and the fallback: the generic ask, never the subject.
 */
export function promptBlocks(i: { subject: string; promptId: string; todayLink: string | null }): {
  text: string;
  blocks: SlackBlock[];
} {
  const context = [mrkdwn(COPY.promptOnlyAsker)];
  if (i.todayLink !== null) context.push(mrkdwn(COPY.promptToday(i.todayLink)));
  return {
    text: COPY.heldAsked,
    blocks: [
      subjectSection(i.subject),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: plainText(COPY.promptAllow),
            style: 'primary',
            action_id: ACTION_ALLOW,
            value: i.promptId,
          },
          { type: 'button', text: plainText(COPY.promptDeny), action_id: ACTION_DENY, value: i.promptId },
        ],
      },
      { type: 'context', elements: context },
    ],
  };
}

/**
 * A prompt once answered or closed: the same section, then `line` (a COPY
 * line) where the buttons were. Nothing is left to click. `text` is `line`.
 */
export function outcomeBlocks(i: { subject: string; line: string }): { text: string; blocks: SlackBlock[] } {
  return {
    text: i.line,
    blocks: [subjectSection(i.subject), { type: 'context', elements: [mrkdwn(i.line)] }],
  };
}

/**
 * A request that can't be answered in Slack (a skill that needs a key
 * first): the same section as a prompt's, then `line` (a COPY line sending
 * the person to the web app), and nothing to click. Nothing is opened for
 * it either, so no id goes anywhere. `text` is the notification, as a
 * prompt's is: the generic ask, never the subject.
 */
export function linkOnlyBlocks(i: { subject: string; line: string }): { text: string; blocks: SlackBlock[] } {
  return {
    text: COPY.heldAsked,
    blocks: [subjectSection(i.subject), { type: 'context', elements: [mrkdwn(i.line)] }],
  };
}

/**
 * An admin's DM about a bot request (TASK-1170): the subject (plain_text,
 * outside names), Approve (a URL into the web app's Admin > Slack; it
 * carries no value) and Decline (its value is the request id), then how
 * Approve works. `text` is the notification and the fallback: it names
 * nobody. A subject with nothing printable left reads as that same line.
 */
export function botRequestBlocks(i: { subject: string; requestId: string; approveUrl: string }): {
  text: string;
  blocks: SlackBlock[];
} {
  return {
    text: COPY.botRequestAsked,
    blocks: [
      subjectSection(i.subject, COPY.botRequestAsked),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: plainText(COPY.botRequestApprove),
            style: 'primary',
            url: i.approveUrl,
            action_id: ACTION_BOT_REQUEST_APPROVE,
          },
          {
            type: 'button',
            text: plainText(COPY.botRequestDecline),
            action_id: ACTION_BOT_REQUEST_DECLINE,
            value: i.requestId,
          },
        ],
      },
      { type: 'context', elements: [mrkdwn(COPY.botRequestHow)] },
    ],
  };
}

/**
 * The same DM once answered: the same subject (give it exactly as
 * `botRequestBlocks` got it), then `line` (a COPY line) where the buttons
 * were. Nothing is left to click. `text` is `line`.
 */
export function botRequestOutcomeBlocks(i: { subject: string; line: string }): {
  text: string;
  blocks: SlackBlock[];
} {
  return {
    text: i.line,
    blocks: [subjectSection(i.subject, COPY.botRequestAsked), { type: 'context', elements: [mrkdwn(i.line)] }],
  };
}
