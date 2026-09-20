/**
 * The words a capability grant is asked for in — owned in one place, read by
 * every surface that asks (TASK-350).
 *
 * WHY THIS FILE EXISTS. These strings used to be module-private consts and
 * inline JSX inside `src/components/PermissionCard.tsx`. That was fine while
 * chat was the only surface that could raise a grant. The agent workspace can
 * now raise one too, and `PermissionCard.tsx` is deleted by TASK-360 — so
 * repeating the literals in the second renderer would leave two copies of
 * security-critical text, one of them in a file scheduled for removal, with
 * nothing keeping them in step. That is the hazard TASK-372 was filed for, one
 * module over; making it twice would be worse than making it once.
 *
 * So the copy lives here, React-free and outside the tree TASK-360 deletes, and
 * both renderers import it. Moving a literal out of JSX does not change what
 * renders, which is why chat's existing copy tests — they assert by regex on
 * rendered text, not by importing these names — stay green and unedited.
 *
 * NO JOKES IN THIS FILE. Every string here is read at the moment a person is
 * deciding whether to widen what software may do on their behalf, and two of
 * them are read while they are holding a secret. CLAUDE.md's voice guidance
 * says to drop the humour when the subject is security; this is that.
 *
 * THREE DERIVATION FUNCTIONS LIVE HERE TOO (TASK-390), not just constants.
 * `grantTitle` / `grantDescription` / `grantPackagesVisible` used to be
 * computed inline inside `GrantRow.tsx`. `lib/thread-find.ts` needs the exact
 * same answers to decide what a grant's find-index entry says — and "the exact
 * same answers" has to mean one function, not two copies that happen to agree
 * today. A title-format tweak in one and not the other is a search result that
 * quotes text nobody can see, or a card whose visible words find cannot find —
 * the invariant-4 bug this repo's memory keeps re-discovering. So the render
 * site and the index both call these, and neither hand-builds the string.
 */
import { humanizeId } from './humanize';
import type { PermissionRequest } from '@/server/types';

/**
 * THE TITLE IS THE SUBJECT OF THE CONSENT (see `GrantRow.tsx`'s own note on
 * why an empty/undefined connector name must fall back rather than render
 * "Connect undefined"). Pulled out here so `thread-find.ts` cannot compute a
 * different title for the same grant.
 */
export function grantTitle(request: PermissionRequest): string {
  if (request.kind === 'host') return `Allow access to ${request.host}?`;
  if (request.kind === 'connector') {
    const name =
      typeof request.name === 'string' && request.name.trim().length > 0
        ? request.name
        : humanizeId(request.connectorId);
    return `Connect ${name}`;
  }
  return `Connect ${humanizeId(request.skillId)}`;
}

/**
 * Skill grants only — connectors and hosts have no free-text description
 * field. Coalesced to `''` rather than validated, same reasoning as
 * `GrantRow.tsx`'s own comment: a missing description is still an answerable
 * row, just a plainer-looking one.
 */
export function grantDescription(request: PermissionRequest): string {
  return request.kind === 'skill' && typeof request.description === 'string'
    ? request.description
    : '';
}

/** Whether the packages line is shown at all — host grants never show it. */
export function grantPackagesVisible(request: PermissionRequest): boolean {
  if (request.kind === 'host') return false;
  const packages = request.packages;
  return (
    packages != null &&
    ((packages.npm?.length ?? 0) > 0 || (packages.pypi?.length ?? 0) > 0)
  );
}

/**
 * The reassurance line, shared by the skill and connector cards.
 *
 * `workspace/ApprovalCard.tsx` has said something like this for a while and it
 * is the reason that surface reads as trustworthy: it tells you what the button
 * does, that nothing has happened yet, and that the decision is reversible. The
 * grant card — the one that actually widens what an agent may do — said none of
 * it. Every clause here is true: the grant is durable, nothing is applied until
 * the click, and both halves are revocable in Settings (skills detach from the
 * Skills tab, hosts from Allowed sites).
 */
export const GRANT_REASSURANCE =
  'Connecting lets this agent do this from now on. Nothing happens until you ' +
  'choose, and you can change it later in Settings.';

/**
 * The single trust moment of the product: we are asking for a secret.
 *
 * The field used to be labelled `api_key` with nothing saying where the key
 * goes. This line states the one fact a person hesitating over that field
 * actually wants, and the claim is true — the value posts straight to the host
 * credential store and never reaches the model or the transcript (§10,
 * TASK-35).
 */
export const KEY_SAFETY =
  'We store this key on the server. The agent never sees it, and it never ' +
  'appears in your conversation.';

/** Why the Connect button is disabled, instead of it just sitting there greyed out. */
export const SLOT_HINT = 'Add the key above to continue';

/**
 * The other reason Connect can be off, and the one a person cannot act on by
 * typing. Workspace-only: chat always has an active conversation, but a grant
 * in the Today queue can arrive before the view has resolved which conversation
 * raised it, and `/api/chat/permission-decision` cannot be posted without one.
 *
 * Without this the button was simply dead with no explanation — a control that
 * cannot work and does not say so, which is the failure `hideClose`
 * (`components/ui/dialog.tsx`) exists to prevent elsewhere in this product.
 *
 * THE ADVICE HAS TO BE THE ACTION THAT WORKS. This first said "Open the agent
 * and try again", which is wrong in a way that would have wasted someone's
 * time: opening the agent sets the ref for FUTURE frames but does not heal the
 * row already sitting in the queue with no conversation on it. Only a re-sent
 * turn raises a fresh frame, which replaces the row in place with the id now
 * set. The common cause of this state is fixed at the source — `pendingReply`
 * now carries the conversation the send created — so this is the residual race,
 * and the sentence points at the one thing that resolves it.
 */
export const GRANT_NO_CONVERSATION =
  'We could not tell which conversation this came from. Send your message ' +
  'again and the agent will ask a second time.';

/**
 * Lead-in for the host list. A bare list of hostnames asks the reader to work
 * out why it is there; say what the list is for before showing it.
 */
export const REACH_LEAD_IN = 'To do this, it needs to reach:';

/**
 * What a package-using grant will do, without the registry hostnames.
 *
 * "Installs npm packages → reaches registry.npmjs.org" is a true sentence that
 * means nothing to most people. What they need to know is that something gets
 * downloaded; which registry it comes from is the grant's business, not theirs.
 */
export const PACKAGES_LINE =
  'It will download some extra software it needs from the internet to do this.';

/**
 * Open-mode banner: the agent wrote this itself, just now, and the person may
 * not have been expecting that. Two nouns, one sentence shape — a shared
 * template would save nothing and read worse.
 */
export const AUTHORED_SKILL_WARNING =
  'Your assistant wrote this skill itself, just now. Connect it only if you ' +
  'were expecting that.';

export const AUTHORED_CONNECTOR_WARNING =
  'Your assistant wrote this connector itself, just now. Connect it only if ' +
  'you were expecting that.';

/**
 * The reactive egress wall. Note the curly apostrophe in "isn’t" — it is the
 * typographic apostrophe used throughout the product's authored copy, and a
 * straight one here would be the only one on the surface.
 */
export const HOST_WALL_EXPLANATION =
  'Your assistant tried to reach a site it isn’t allowed to yet.';

/** Button labels. Shared so the two surfaces cannot drift into saying different things. */
export const GRANT_REJECT_LABEL = 'Not now';
export const GRANT_CONNECT_LABEL = 'Connect';
export const GRANT_CONNECTING_LABEL = 'Connecting…';
export const HOST_ALLOW_ONCE_LABEL = 'Just this once';
export const HOST_ALLOW_ALWAYS_LABEL = 'Always for this agent';
export const HOST_ALLOWING_LABEL = 'Allowing…';

/**
 * What "Not now" actually does (TASK-444). Rendered under the button, on every
 * kind of grant, because it is true of all of them.
 *
 * THE LABEL STAYS, AND THIS IS WHAT MAKES IT HONEST. "Not now" reads as a
 * permanent no — a dismissal — and it is not one: the refusal is remembered, so
 * we stop replaying the question, but the moment the agent genuinely needs that
 * capability to get on with something, it asks again. Without this line the two
 * plausible readings ("gone forever" and "it'll nag me on every reload") are
 * both wrong, and the person has no way to tell which we meant.
 *
 * No timer in the sentence, because there is no timer in the behaviour — it is
 * the need that brings the question back, never the clock.
 *
 * Curly apostrophes, for the reason `HOST_WALL_EXPLANATION` above gives: this
 * line is drawn on the same card as that one, and a straight apostrophe here
 * would be the only one on the surface.
 */
export const GRANT_REJECT_HINT = 'We’ll only ask if it’s needed again.';

/**
 * The grant landed and the agent did not pick up again (TASK-374).
 *
 * The behaviour this replaces was SILENCE: the row vanished, the capability was
 * genuinely attached, and the agent sat stopped with nothing on screen saying
 * so or saying what to do. A person who had just been told "connecting lets
 * this agent do this from now on" reasonably read that as "and now it will".
 *
 * Three things have to be true in one sentence, and all three are load-bearing:
 * the connection WORKED (so nobody re-enters a key that is already saved), the
 * agent stopped BEFORE they answered (so this reads as timing rather than as
 * the grant failing), and messaging the agent is what gets it going.
 *
 * ONE SENTENCE FOR EVERY `ResumeFailure`, and the wording is what makes that
 * honest. The reasons differ in what WE could not do — read the conversation,
 * find a turn in it, post it — and not at all in what the person should do
 * next, so spelling the difference out would ask them to care about our
 * plumbing at the moment they are least able to.
 *
 * It says "send it a message" and NOT "send your message again", which reads
 * better and is false in one branch: `nothing-to-resume` means there was no
 * message of theirs in that conversation to begin with, so "again" would be
 * telling someone to repeat something they never did. The action is the same
 * either way — say something to the agent — so the sentence says the thing that
 * is true in both.
 */
export const GRANT_NOT_RESUMED =
  'Connected. The agent had already stopped by the time you answered, though, ' +
  'and we could not start it again from here — send it a message and it will ' +
  'carry on with this connection in place.';

/** Clears the stopped-agent row. It is an acknowledgement, not an action. */
export const GRANT_NOT_RESUMED_DISMISS = 'Got it';

/**
 * The grant landed and the agent DID start again — said out loud, but only
 * where the person cannot already see it happening (TASK-374).
 *
 * The asymmetry is deliberate. Answering a grant in the agent's own thread puts
 * the reply on screen as it streams, and a toast on top of that would be a
 * notification about something the reader is already watching. Answering one in
 * the Today queue has no such view: the row disappears and the agent restarts
 * somewhere else. Without this, the queue's successful case would look exactly
 * like the silence this task set out to fix.
 *
 * The name is a parameter rather than "your agent" because Today can hold
 * grants from several agents and the reader needs to know WHICH one just
 * started. `null` is the fallback for the window before the roster has loaded —
 * rare, since answering a row means the roster drew it, and still better than
 * interpolating `undefined` into a sentence.
 */
export const grantResumedTitle = (agentName: string | null): string =>
  agentName === null
    ? 'Connected. Your agent is picking up where it left off.'
    : `Connected. ${agentName} is picking up where it left off.`;
