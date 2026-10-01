/**
 * Every sentence the Models tab and the agent editor's moved-model notice say.
 * Project voice: plain words, short sentences, "we", no blame.
 */
import { HTTP_NO_ACCESS, HTTP_SESSION_ENDED } from './http';
import { ModelsHttpError } from './models-admin';

export const TAB_INTRO = 'Choose which models people can use when they create or edit an agent.';
export const BUILTIN_NOTICE = "You're using the built-in list. Nothing changes until you save.";
export const UNREADABLE_NOTICE =
  "We couldn't read the saved list, so we're using the built-in one for now. Saving will replace the saved list.";
export const POLICY_LOAD_FAILED = "We couldn't load the saved list of models.";
export const CATALOG_LOAD_FAILED = "We couldn't load the model list. Your current selection is safe.";
export const DEFAULT_HELP =
  'The Default is what new agents start with, and where an agent moves if its model is removed.';
export const NONE_SELECTED_TITLE = 'No models yet';
export const NONE_SELECTED_BODY = 'Pick at least one on the left so people can create agents.';
export const NO_LONGER_LISTED = 'No longer listed';
export const NEEDS_KEY = 'Needs an API key';
export const SAVED_TITLE = 'Models saved';
export const SAVED_DETAIL = 'People can now use the models you selected.';

export function providerProblem(name: string): string {
  return `We couldn't reach ${name} just now, so we're showing a shorter list.`;
}
export function providerNoKey(name: string): string {
  return `Add an API key to see ${name}'s models.`;
}
export function timeAgo(iso: string | undefined, nowMs: number): string {
  if (iso === undefined) return 'earlier';
  const mins = Math.floor((nowMs - Date.parse(iso)) / 60_000);
  if (!(mins >= 1)) return 'a moment ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
}
export function cachedNote(iso: string | undefined, nowMs: number): string {
  return `Showing models from ${timeAgo(iso, nowMs)}.`;
}
export function countLine(shown: number, total: number, filtering: boolean): string {
  if (!filtering) return `${total} model${total === 1 ? '' : 's'}`;
  return `${shown} of ${total} models`;
}

export function impactTitle(totalAgents: number | null, defaultLabel: string): string {
  if (totalAgents === null) return `Some agents may move to ${defaultLabel}`;
  return `Move ${totalAgents} agent${totalAgents === 1 ? '' : 's'} to ${defaultLabel}?`;
}
export function impactLine(label: string, agentCount: number): string {
  return `${label}: ${agentCount} agent${agentCount === 1 ? '' : 's'}`;
}
export function impactExplain(defaultLabel: string, known: boolean): string {
  if (!known) {
    return `We couldn't check which agents use the models you removed. Any agent on a removed model will use ${defaultLabel} from its next chat.`;
  }
  return `From their next chat they'll use ${defaultLabel} instead. If you add a model back, the agents that use it switch back on their own.`;
}

export function movedNotice(defaultLabel: string): string {
  return `Your admin changed the available models, so this agent is using ${defaultLabel} now. Pick a different model to change it.`;
}

const CODE_COPY: Record<string, string> = {
  'pick-at-least-one-model': 'Pick at least one model so people can still create agents.',
  'default-not-selected': 'Choose a Default from the selected models.',
  'too-many-models': "That's more models than we can save at once. Try a smaller selection.",
  'invalid-model-ref': "One of the selected models isn't valid. Remove it and try again.",
  'duplicate-model': 'A model is selected twice. Reload and try again.',
};

/** What to tell the admin when a save fails. `stale` means "someone else saved first". */
export function saveFailure(err: unknown): { message: string; stale: boolean } {
  if (err instanceof ModelsHttpError) {
    if (err.status === 409) {
      return { message: 'Someone else just changed this list. Reload to see their version.', stale: true };
    }
    if (err.status === 401) return { message: HTTP_SESSION_ENDED, stale: false };
    if (err.status === 403) return { message: HTTP_NO_ACCESS, stale: false };
    const specific = err.serverError !== undefined ? CODE_COPY[err.serverError] : undefined;
    if (specific !== undefined) return { message: specific, stale: false };
  }
  return { message: "We couldn't save that. Nothing changed. Try again in a moment.", stale: false };
}
