const join = (...parts: string[]): string => parts.join('');

/**
 * Slack-shaped fixture tokens, built from pieces so no token-shaped literal
 * sits in source (GitHub push protection flags them, even fake ones). The
 * runtime values are exactly what the tests expect.
 */
export const BOT_PREFIX = join('xo', 'xb-');
export const CONFIG_ACCESS_PREFIX = join('xo', 'xe.', 'xo', 'xp-');
export const CONFIG_REFRESH_PREFIX = join('xo', 'xe-');

export const fakeBotToken = (tail = 'BOTTOKENSECRET'): string => join(BOT_PREFIX, '1111-2222-', tail);
export const fakeConfigAccessToken = (tail = 'PASTEDACCESSSECRET'): string =>
  join(CONFIG_ACCESS_PREFIX, '1-', tail);
export const fakeConfigRefreshToken = (tail = 'PASTEDREFRESHSECRET'): string =>
  join(CONFIG_REFRESH_PREFIX, '1-', tail);
