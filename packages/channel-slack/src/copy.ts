import { cleanPromptSubject, mrkdwnEscape, neutralizeSlackControls } from './format.js';
import { SLASH_COMMAND } from './manifest.js';
import type { SkillReach } from './turn-registry.js';

/**
 * Everything the bot says in Slack on its own behalf. Nothing else in this
 * package may compose Slack-facing words: one place to read them all, and
 * model text never decides what the bot says for itself.
 *
 * No line names the product. A deployment is white-labeled through Branding
 * (the bot's own name defaults to the branding name), so the place people
 * sign in and make agents is "the web app", linked to the public origin.
 * Every line is host-authored and never holds `<!`, `<@`, `<#` or a bare
 * `@here`, `@channel` or `@everyone`: the bot never pings anyone, a name
 * from outside included (copy.test.ts).
 *
 * The `slash*` lines answer `/ax` (commands.ts), the `channel*` lines (with
 * `queueFull`, `turnFailed`, and TASK-1167's `botUnavailable` and
 * `answersAsOwnBot`) can reach a channel mention's sender
 * privately before its turn starts (router.ts), and the `prompt*` and
 * `decision*` lines surround an approval prompt (blocks.ts). All three go
 * out as mrkdwn, not Markdown (but for the prompt's two button labels, which
 * are plain_text): a link is a bare URL, and no line holds a `<` or `>` of
 * its own (mrkdwn reads `<…>` as a link). A name from outside goes through
 * `shown`. A prompt's subject is never a COPY line: it is outside text,
 * shown as `plain_text` (format.ts `cleanPromptSubject`). Two lines frame
 * outside text as a subject, raw, cleaned where it is drawn: `hostSubject`
 * (a host past the egress proxy's HOST_RE, permission-prompts.ts) and
 * `skillSubject` (a catalog skill's id, the hosts it reaches and its
 * description, which can hold anything). Neither is ever mrkdwn, a
 * notification or a log.
 */

/**
 * A name from outside (an agent's, a channel's, a bot's @handle) or the
 * configured origin, as mrkdwn text: neutralized like any other outgoing
 * text, then escaped, so it can't open a link, a mention or a broadcast. In
 * that order: escaped first, mrkdwn's own `&lt;` would reach the neutralizer
 * as the start of an entity, and its mark would make Slack show `&lt;` where
 * the name has a `<`. `before` is what the line puts right before the name:
 * after a line's own `@`, a handle `here` would finish a broadcast, so it is
 * marked as one (format.ts `neutralizeSlackControls`).
 */
const shown = (text: string, before = ''): string => mrkdwnEscape(neutralizeSlackControls(text, before));

/**
 * Why a channel can't have an agent: channels.ts's refusals that are about
 * the channel, and `workspace-policy` (its `not-allowed`: the workspace's
 * settings keep the bot out).
 */
export type ChannelNotAllowed = 'not-public' | 'archived' | 'shared' | 'workspace-policy';

const CONNECT = `\`${SLASH_COMMAND} connect\``;
const DISCONNECT = `\`${SLASH_COMMAND} disconnect\``;

/** `a`, `a and b`, `a, b and c`: in the order given, each as given. */
function listed(items: readonly string[]): string {
  const last = items.length - 1;
  return last < 1 ? items.join('') : `${items.slice(0, last).join(', ')} and ${items[last]}`;
}

/**
 * `skillSubject`'s clause for what a skill reaches (its hosts, and one
 * sentence when it downloads packages, never which: the web app's grant row
 * doesn't name them either), or null when there is nothing to name.
 */
function reachClause(reach: SkillReach): string | null {
  const downloads = 'will download some extra software from the internet';
  if (reach.hosts.length === 0) return reach.downloads ? `which ${downloads}` : null;
  const hosts = `which needs to reach ${listed(reach.hosts)}`;
  return reach.downloads ? `${hosts}, and it ${downloads}` : hosts;
}

export const COPY = {
  notMapped: (origin: string) =>
    `I couldn't match your Slack account to an account in [the web app](${origin}). ` +
    'Sign in there once with your work account, then send your message again.',
  noAgent: (origin: string) =>
    `You don't have a personal agent in [the web app](${origin}) yet. ` +
    'Make one there, then send your message again.',
  filesUnsupported:
    "I can't read files in Slack yet. Send your message as text, or share the file with me in the web app.",
  queueFull:
    "I'm still working on your earlier messages in this thread. Send this one again after I reply.",
  busy: "I'm busy with something else in this conversation. Try again in a moment.",
  turnFailed: "Something went wrong and I couldn't finish. Try again in a moment.",
  emptyReply: "I didn't have anything to add.",
  artifactLink: (link: string) => `I made something you can open in the web app: [Open it](${link})`,
  /*
    A call the turn held for approval (reply-stream.ts `held`). Neither line
    names the tool, its connector or the person: they take nothing but the
    Today link. `heldForOwner` ends an outsider's turn, which runs as the
    person who connected the channel: the call waits in their Today, and the
    reader can't approve it, so it links nowhere. `heldForSender` ends a turn
    whose writer can use the agent (a DM, or an attended channel turn): the
    call waits in their own Today.
  */
  heldForOwner:
    "I need my owner's OK before I can do part of this. I've asked them, and nothing will happen until they approve it.",
  heldForSender: (todayLink: string) =>
    `I need your OK before I can do part of this. Approve it in [Today](${todayLink}). Nothing will happen until you do.`,
  /*
    The same ask when the turn posts a prompt for the call (blocks.ts): it
    ends the reply, and the prompt under it carries the buttons and Today's
    link. It is also the prompt's notification text, and stands in for a
    subject with nothing printable left, so it links nothing and names
    nothing.
  */
  heldAsked: 'I need your OK before I can do part of this.',
  statusDefault: 'Working',

  // ── An approval prompt (blocks.ts; mrkdwn, except the two button labels) ──
  /*
    A call held in a DM or an attended channel turn gets a prompt in the
    thread: its subject (outside text, never one of these lines), Allow and
    Deny (`promptAllow`, `promptDeny`: plain_text labels), then
    `promptOnlyAsker` and `promptToday` as context. Once answered or closed,
    the buttons give way to one `decision*` line or `promptClosed`.
    `promptOnlyAsker`, `promptGone`, `promptFailed` and `promptStillWorking`
    also answer a click privately. None names the person, the agent or the tool, and a link is a
    bare URL that ends its line.
  */
  promptAllow: 'Allow',
  promptDeny: 'Deny',
  promptOnlyAsker: 'Only the person who asked can answer this.',
  promptToday: (todayLink: string) => `You can also answer it in Today: ${shown(todayLink)}`,
  promptGone: (todayLink: string) =>
    `This isn't waiting here anymore. If it still needs an answer, it's in Today: ${shown(todayLink)}`,
  promptFailed: "Something went wrong and I couldn't record your answer. Try again in a moment.",
  // An answer past its deadline may still land, so the prompt stays taken: no "try again" here.
  promptStillWorking: "This is taking longer than usual. I'm still working on your answer, so there's no need to click again.",
  promptClosed: "This can't be answered here anymore.",
  decisionAllowed: "Allowed. I'll pick it up in a moment.",
  decisionDone: 'Allowed, and done.',
  decisionAllowedNextTime: "Allowed. Ask me again and I'll do it.",
  decisionDenied: "Denied. I won't do it.",
  decisionExpired: 'This request expired, so nothing happened.',
  decisionChanged: (todayLink: string) =>
    `Things changed since I asked, so nothing happened. The details are in Today: ${shown(todayLink)}`,
  decisionFailed: (todayLink: string) => `Allowed, but it didn't work. The details are in Today: ${shown(todayLink)}`,
  // An abandoned replay (not a service's own error): nobody can say whether it finished, so no "didn't work".
  decisionInterrupted: (todayLink: string) =>
    `Allowed, but it was interrupted, so I can't tell whether it finished. Check Today before trying again: ${shown(todayLink)}`,
  decisionNotRun: (todayLink: string) =>
    `I couldn't do that just now. You can try again from Today: ${shown(todayLink)}`,

  // ── A host the sandbox was refused (permission-prompts.ts) ─────────────────
  /*
    `hostSubject` is the prompt's subject, plain_text: only ever a host that
    passed HOST_RE (lowercase letters, digits, dots and dashes), never mrkdwn.
    The other three take the buttons' place once the asker has answered.
    Allow lets the host through for the conversation's LIVE sandbox session
    only: the web app's "Just this once", not the whole chat. That session
    ends when it idles (or when a skill's Allow retires it) while the chat
    goes on, so the lines say "for now", never "this chat". `hostEnded` is
    Allow on a session already gone. "Always" stays a web choice, and
    nothing about a blocked host waits in Today, so none of them links there.
  */
  hostSubject: (host: string) => `Wants to connect to ${host}`,
  hostAllowed: "Allowed for now. Ask me again and I'll try it.",
  hostEnded: "I'd already finished working on that, so nothing changed. If I need it again, I'll ask.",
  hostDenied: "Okay. I won't connect to it.",

  // ── A catalog skill the agent asked to use (permission-prompts.ts) ─────────
  /*
    `skillSubject` is the prompt's subject, plain_text: the skill's id, then
    what it reaches (its card's hosts, and one sentence when it downloads
    packages), then the catalog skill's description as its card carries it,
    all raw (the draw cleans the whole subject, once). The reach comes
    BEFORE the description, so the subject's cap (PROMPT_SUBJECT_MAX) can
    only ever cut the description, never a host. Hosts are offered for Allow
    only when each passes HOST_RE and the subject up to the description
    reads the same once cleaned (permission-prompts.ts `skillPromptFor`);
    otherwise the subject leaves the reach out, and the person is sent to
    the web app, which shows it whole. A reach with nothing in it (or none
    given) reads as before. The id is no model text: the card only
    fires after `skills:get` finds an exact catalog match, and a catalog id
    is a manifest name, `^[a-z][a-z0-9-]{0,63}$` (skills-parser NAME_RE; the
    broker's own SKILL_ID_RE is wider, and allows dots). It is still cleaned
    and drawn as plain_text with the rest, never trusted for its shape. The id is what tells two skills with the same, or
    no, description apart. A description with nothing printable in it reads
    as a sentence of its own, not as a colon with nothing after it. Allow
    attaches the skill for the person, and nothing reruns their message, so
    `skillAllowed` asks them to send it again. A skill card waits in Today
    too, so the two that send the person to the web app link Today.
    `skillNeedsWeb` stands where the buttons would be when Slack can't take
    the request (a key to enter, which Slack never collects, or a reach it
    can't show whole);
    `skillFailed` replaces them when an Allow couldn't connect it.
  */
  skillSubject: (skillId: string, description: string, reach?: SkillReach) => {
    const lead = `Wants to start using the ${skillId} skill`;
    const clause = reach === undefined ? null : reachClause(reach);
    const blank = cleanPromptSubject(description) === '';
    if (clause === null) return blank ? `${lead}.` : `${lead}: ${description}`;
    return blank ? `${lead}, ${clause}.` : `${lead}, ${clause}. ${description}`;
  },
  skillAllowed: "Connected. Send your message again and I'll use it.",
  skillDenied: "Okay. I won't use it.",
  skillNeedsWeb: (todayLink: string) =>
    `This one needs a key or a closer look first. Finish it in the web app: ${shown(todayLink)}`,
  skillFailed: (todayLink: string) => `I couldn't connect it from here. Finish it in the web app: ${shown(todayLink)}`,

  // ── Before a channel mention's turn (mrkdwn, shown only to its sender) ────
  /*
    One line for every conversation nothing is connected to: a mention can't
    tell a group DM or a private channel from a public channel without more
    scopes, so it says where an agent can be connected.
  */
  channelNotConnected:
    'No agent is connected here. A team admin can connect one to a public channel ' +
    `by typing ${CONNECT} there, followed by the agent's name. To talk to your own agent, send me a direct message.`,
  /*
    The channel's connection is broken: the person who connected it can't use
    the agent anymore, or the agent is gone. Outsiders' turns would run as
    that person, so none runs until a team admin connects the channel again.
  */
  channelUnavailable: "I can't answer here right now. A team admin needs to connect me to this channel again.",
  channelBusy: "I'm busy with other questions in this channel. Try again in a minute.",
  /*
    A team agent's own bot (TASK-1167) whose requester can't vouch for its
    channels' outsiders anymore: they are no longer a team admin of the
    agent's team, or are gone. An outsider's turn would run as them, so none
    runs until a team admin claims the bot in the web app; members are still
    answered. Only an outsider ever reads it.
  */
  botUnavailable: "I can't answer you here right now. A team admin needs to check my settings in the web app.",
  /*
    The shared bot stepping aside for an agent that has its own bot now
    (TASK-1167), so two bots never answer for one agent. It names that bot by
    its own name and, once its Allow read one, its @handle, both through
    `shown` (the handle after the line's own `@`), and never the agent: the
    sender may not be able to see it.
  */
  answersAsOwnBot: (botName: string, handle: string | null) =>
    handle === null
      ? `${shown(botName)} has its own Slack bot now. Invite it to this channel to keep talking to it here.`
      : `${shown(botName)} answers as @${shown(handle, '@')} now. Invite it with /invite @${shown(handle, '@')}.`,

  // ── /ax replies (mrkdwn, shown only to whoever typed the command) ─────────
  slashUsage:
    `To connect this channel to a team agent, type ${CONNECT} followed by the agent's name. ` +
    `To disconnect whichever agent is connected here, type ${DISCONNECT}.`,
  slashNotMapped: (origin: string) =>
    "I couldn't match your Slack account to an account in the web app. " +
    `Sign in once at ${shown(origin)} with your work account, then try again.`,
  slashNoSuchAgent:
    "I couldn't find a team agent with that name that you can use. Check its name in the web app, then try again.",
  slashNotManager: "Only a team admin of the agent's team can connect it to a channel or disconnect it.",
  slashAmbiguous:
    'More than one team agent you manage has that name. ' +
    "Connect this channel from the agent's settings in the web app instead.",
  slashConnected: (agent: string, channel: string) =>
    `Connected *${shown(agent)}* to #${shown(channel)}. Mention me here to talk to it.\n` +
    '• Anything in its instructions and files can show up in its answers, and everyone in this channel can read them.\n' +
    "• When someone who can't use the agent talks to it here, it works with your access, " +
    'and anything that needs approval waits for you in Today.',
  slashReconnected: (agent: string) =>
    `*${shown(agent)}* was already connected here. From now on, when someone who can't use it talks to it here, ` +
    'it works with your access, and anything that needs approval waits for you in Today.',
  slashDisconnected: "Disconnected. The agent won't answer in this channel anymore.",
  /*
    `/ax disconnect` for an agent whose own bot is live (TASK-1168): the shared
    binding is gone, but its own bot keeps answering wherever it is a member, and
    we can't tell from here whether it is one in this channel. Says so, and how to
    remove it. The bot is named like slashOwnBot names it.
  */
  slashDisconnectedOwnBot: (bot: { botName: string; handle: string | null }) =>
    bot.handle === null
      ? `Disconnected. If ${shown(bot.botName)} is in this channel, it still answers here: remove it with /kick.`
      : `Disconnected. If @${shown(bot.handle, '@')} is in this channel, it still answers here: ` +
        `remove it with /kick @${shown(bot.handle, '@')}.`,
  slashNothingConnected: 'No agent is connected to this channel.',
  slashChannelTaken:
    'Another agent is already connected to this channel. ' +
    `A team admin of that agent's team can disconnect it with ${DISCONNECT}.`,
  /*
    `/ax connect` for an agent whose own bot is live (TASK-1168): the shared
    app connects nothing for it any more, so the line says which bot to
    /invite instead. Only someone who manages the agent ever reads it (the
    rights come first, commands.ts), so the agent is named. The bot is named
    by its @handle, through `shown(handle, '@')` after the line's own `@`, or
    by its name when it has none (the Allow kept no handle: bots.ts
    `keepHandle`).
  */
  slashOwnBot: (agent: string, bot: { botName: string; handle: string | null }) =>
    bot.handle === null
      ? `*${shown(agent)}* has its own Slack bot now, so I can't connect it here. ` +
        `Invite ${shown(bot.botName)} to this channel with /invite instead.`
      : `*${shown(agent)}* has its own Slack bot now, so I can't connect it here. ` +
        `Invite it to this channel with /invite @${shown(bot.handle, '@')} instead.`,
  slashChannelNotAllowed: (reason: ChannelNotAllowed) =>
    reason === 'archived'
      ? "This channel is archived, so I can't connect an agent to it."
      : reason === 'shared'
        ? "This channel is shared with another organization, so I can't connect an agent to it."
        : reason === 'workspace-policy'
          ? "This workspace's settings don't let me join this channel, so I can't connect an agent to it. " +
            'A Slack admin can change that.'
          : 'I can only connect an agent to a public channel, and this is a private channel or a direct message.',
  slashNeedsReconnect:
    'Slack needs to be connected to the web app again before an agent can join a channel. ' +
    "An admin can do that in the web app's admin settings.",
  slashWorking:
    "I'm still working on it. If nothing shows up here, check the agent's Slack settings in the web app.",
  slashFailed: "Something went wrong and I couldn't finish that. Try again in a moment.",
} as const;
