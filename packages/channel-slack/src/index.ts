export {
  PLUGIN_NAME,
  createChannelSlackPlugin,
  type ChannelSlackConfig,
} from './plugin.js';
export {
  RESERVED_BOT_NAMES,
  checkBotName,
  defaultBotName,
  type BotNameCheck,
  type BotNameRefusal,
} from './bot-name.js';
export {
  BOT_EVENTS,
  BOT_SCOPES,
  buildAppManifest,
  buildInstallUrl,
  slackUrls,
  type SlackUrls,
} from './manifest.js';
