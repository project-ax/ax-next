import { describe, expect, it } from 'vitest';
import {
  SLACK_INSTALL_RETURN_MESSAGES,
  readSlackInstallReturn,
  withoutSlackInstallReturn,
} from '../slack-install-return';

/*
  @ax/channel-slack's OAuth callback sends the admin's browser to
  `/?slack=connected|cancelled|failed` (TASK-1093). Only those three exact
  words mean anything; every other spelling is not a return at all, so it
  shows no toast and opens nothing.
*/

describe('readSlackInstallReturn', () => {
  it.each([
    ['?slack=connected', 'connected'],
    ['?slack=cancelled', 'cancelled'],
    ['?slack=failed', 'failed'],
    ['slack=connected', 'connected'],
    ['?a=1&slack=failed&b=2', 'failed'],
    // The first value wins, the same as URLSearchParams.get.
    ['?slack=cancelled&slack=connected', 'cancelled'],
  ] as const)('%s → %s', (search, outcome) => {
    expect(readSlackInstallReturn(search)).toBe(outcome);
  });

  it.each([
    '',
    '?',
    '?slack=',
    '?slack',
    '?slack=Connected',
    '?slack=CONNECTED',
    '?slack=connected%20',
    '?slack=%20connected',
    '?slack=success',
    '?slack=error',
    '?slack=connected.',
    '?Slack=connected',
    '?oauth=success',
    '?slack=<script>',
  ])('%j → null', (search) => {
    expect(readSlackInstallReturn(search)).toBeNull();
  });
});

describe('withoutSlackInstallReturn', () => {
  it.each([
    ['?slack=connected', ''],
    ['', ''],
    ['?a=1&slack=failed&b=2', '?a=1&b=2'],
    ['?slack=failed&slack=connected', ''],
    ['?a=1', '?a=1'],
    // Even a value we don't read comes out: it's ours to clean.
    ['?slack=bogus&a=1', '?a=1'],
  ])('%j → %j', (search, cleaned) => {
    expect(withoutSlackInstallReturn(search)).toBe(cleaned);
  });
});

describe('SLACK_INSTALL_RETURN_MESSAGES', () => {
  it('says each outcome in a fixed sentence', () => {
    expect(SLACK_INSTALL_RETURN_MESSAGES).toEqual({
      connected: 'Slack is connected.',
      cancelled: 'Slack install was cancelled.',
      failed: "We couldn't finish connecting Slack. Try again.",
    });
  });
});
