/**
 * Coming back from Slack's Allow page for an agent's own Slack bot (TASK-1167).
 *
 * @ax/channel-slack's bot callback (`bot-callback.ts`) sends the person's
 * browser to `/?slack-bot=connected|cancelled|failed[&agentId=<id>]`. That is
 * not `?slack=` (`lib/slack-install-return.ts`), which opens Admin › Slack for
 * admins: a team agent's admin needn't be a workspace admin, and the bot's
 * settings are the agent's. `App.tsx` reads this once, takes both parameters
 * out of the address bar, says what happened in a toast, and goes to that
 * agent's Slack settings.
 *
 * Only the three exact words are read, and what is shown is a fixed sentence
 * per word: nothing from the URL reaches the page. The agent id is never
 * shown; it only picks a route, and only one the workspace router accepts
 * (the same rule `lib/oauth-full-page-return.ts` follows).
 */
import { parseWorkspaceRoute, workspaceRoutePath } from './workspace-route';

export type SlackBotOutcome = 'connected' | 'cancelled' | 'failed';

export interface SlackBotReturn {
  outcome: SlackBotOutcome;
  /** The agent's Slack settings, when the id is usable. */
  returnPath: string | null;
}

const OUTCOME_PARAM = 'slack-bot';
const AGENT_PARAM = 'agentId';

function isOutcome(value: string | null): value is SlackBotOutcome {
  return value === 'connected' || value === 'cancelled' || value === 'failed';
}

/** The return a location's `search` carries, or null when it carries none. */
export function readSlackBotReturn(search: string): SlackBotReturn | null {
  const params = new URLSearchParams(search);
  const outcome = params.get(OUTCOME_PARAM);
  if (!isOutcome(outcome)) return null;
  // Reject an empty id before the lenient parser can drop an empty segment, and
  // an id URLSearchParams had to repair (a bad escape comes back as U+FFFD);
  // the workspace parser owns the rest (dot ids).
  const agentId = params.get(AGENT_PARAM);
  const route =
    agentId === null || agentId.length === 0 || agentId.includes('�')
      ? null
      : parseWorkspaceRoute(`/workspace/agents/${encodeURIComponent(agentId)}/settings/slack`);
  const returnPath = route?.kind === 'agent-settings' ? workspaceRoutePath(route) : null;
  return { outcome, returnPath };
}

/** `search` without the two return parameters, keeping everything else (`''` when nothing is left). */
export function withoutSlackBotReturn(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(OUTCOME_PARAM);
  params.delete(AGENT_PARAM);
  const rest = params.toString();
  return rest === '' ? '' : `?${rest}`;
}

/** What the toast says. `failed` is shown as an error, `cancelled` as information. */
export const SLACK_BOT_RETURN_MESSAGES: Readonly<Record<SlackBotOutcome, string>> = Object.freeze({
  connected: 'The Slack bot is live. Invite it to a channel with /invite.',
  cancelled: "Slack install was cancelled. You can continue it from the agent's Slack settings.",
  failed: "We couldn't finish adding the Slack bot. Try again from the agent's Slack settings.",
});
