import { mrkdwnEscape, neutralizeSlackControls } from './format.js';
import { SLASH_COMMAND } from './manifest.js';

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
 * The `slash*` lines answer `/ax` (commands.ts), and the `channel*` lines
 * (with `queueFull` and `turnFailed`) can reach a channel mention's sender
 * privately before its turn starts (router.ts). Both go out as mrkdwn `text`,
 * not Markdown: a link is a bare URL, and no line holds a `<` or `>` of its
 * own (mrkdwn reads `<…>` as a link). A name from outside goes through `shown`.
 */

/**
 * A name from outside (an agent's, a channel's) or the configured origin, as
 * mrkdwn text: neutralized like any other outgoing text, then escaped, so it
 * can't open a link, a mention or a broadcast. In that order: escaped first,
 * mrkdwn's own `&lt;` would reach the neutralizer as the start of an entity,
 * and its mark would make Slack show `&lt;` where the name has a `<`.
 */
const shown = (text: string): string => mrkdwnEscape(neutralizeSlackControls(text));

/**
 * Why a channel can't have an agent: channels.ts's refusals that are about
 * the channel, and `workspace-policy` (its `not-allowed`: the workspace's
 * settings keep the bot out).
 */
export type ChannelNotAllowed = 'not-public' | 'archived' | 'shared' | 'workspace-policy';

const CONNECT = `\`${SLASH_COMMAND} connect\``;
const DISCONNECT = `\`${SLASH_COMMAND} disconnect\``;

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
  statusDefault: 'Working',

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
  slashNothingConnected: 'No agent is connected to this channel.',
  slashChannelTaken:
    'Another agent is already connected to this channel. ' +
    `A team admin of that agent's team can disconnect it with ${DISCONNECT}.`,
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
