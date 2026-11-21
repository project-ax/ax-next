/**
 * The sentences about a pasted Slack configuration token and a bot's name that
 * Admin › Slack (slack-admin.ts) and an agent's Slack card
 * (agent-slack.ts) both show, so the two surfaces word a refused token and a
 * refused name the same way (TASK-1167).
 */

export const SLACK_TOKEN_COPY = Object.freeze({
  'invalid-refresh-token': "That doesn't look like a refresh token. It starts with xoxe-.",
  // Connect tried the pasted refresh token once and Slack refused it; the app we made was deleted
  // again, or (when Slack wouldn't) is listed as left over.
  // Shared by Connect and Replace: the same advice fits both, since either can be turned away on its refresh token.
  'slack-refresh-token': "Slack didn't accept the refresh token. Generate a new token and try again.",
  'slack-token': "Slack didn't accept the access token. Generate a new pair and paste both again.",
  'slack-name': "Slack didn't accept that bot name. Try another.",
  // Another bot (any agent's, or the shared one) already has this name: names are unique across them.
  'bot-name-taken': 'Another Slack bot here already uses that name. Pick another.',
  // Connect never heard back from Slack, so the app may exist with no way for us to delete it.
  'slack-unconfirmed':
    "Slack didn't give us a clear answer, so a Slack app may have been created anyway. Check api.slack.com/apps and delete it before you try again.",
});

/** `invalid-bot-name`'s reasons (@ax/channel-slack's `checkBotName`). */
export const BOT_NAME_COPY: Readonly<Record<string, string>> = Object.freeze({
  empty: 'Give the bot a name.',
  'too-long': 'Keep the name to 35 characters or fewer.',
  'bad-characters': 'Use letters, numbers, spaces, dots, dashes or underscores.',
  reserved: 'Slack keeps that name for itself. Pick another.',
});
export const BOT_NAME_FALLBACK = "Slack can't use that name. Try another.";

/**
 * The sentences about replacing a team bot's configuration token that agent
 * settings (agent-slack.ts) and Admin › Slack (slack-bots-admin.ts) both show
 * (TASK-1173). Security copy: plain, no jokes.
 */
export const BOT_TOKEN_COPY = Object.freeze({
  // The pasted token works, but its owner can't manage this bot's app: a colleague's, or another workspace's.
  'slack-not-app-manager':
    "Slack says that token can't manage this bot. Only the person who set a bot up can replace its token, with a new token of their own from this Slack workspace.",
  replaced: (botName: string): string =>
    `Token replaced. We now use it for ${botName} and every other Slack app you set up here. Don't revoke the token you just pasted: it's the one we use now.`,
});
