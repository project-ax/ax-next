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
 */

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
