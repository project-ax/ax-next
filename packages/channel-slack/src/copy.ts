/**
 * Everything the bot says in Slack on its own behalf. Nothing else in this
 * package may compose Slack-facing words: one place to read them all, and
 * model text never decides what the bot says for itself.
 *
 * No line names the product. A deployment is white-labeled through Branding
 * (the bot's own name defaults to the branding name), so the place people
 * sign in and make agents is "the web app", linked to the public origin.
 * Every line is host-authored and never holds `<!`, `<@` or `<#`: the bot
 * never pings anyone (copy.test.ts).
 */
export const COPY = {
  notMapped: (origin: string) =>
    `I couldn't match your Slack account to an account in [the web app](${origin}). ` +
    'Sign in there once with your work account, then send your message again.',
  noAgent: (origin: string) =>
    `You don't have a personal agent in [the web app](${origin}) yet. ` +
    'Make one there, then send your message again.',
  mentionRefusal: 'I only answer direct messages for now. Send me a DM to talk to your own agent.',
  filesUnsupported:
    "I can't read files in Slack yet. Send your message as text, or share the file with me in the web app.",
  queueFull:
    "I'm still working on your earlier messages in this thread. Send this one again after I reply.",
  busy: "I'm busy with something else in this conversation. Try again in a moment.",
  turnFailed: "Something went wrong and I couldn't finish. Try again in a moment.",
  emptyReply: "I didn't have anything to add.",
  artifactLink: (link: string) => `I made something you can open in the web app: [Open it](${link})`,
  statusDefault: 'Working',
  /** Slack shows it after the bot's name: "ax is thinking…". */
  thinkingStatus: 'is thinking…',
} as const;
