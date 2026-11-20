/**
 * TASK-1167 — the address Slack's Allow page sends a person back to for an
 * agent's own Slack bot: `/?slack-bot=<outcome>[&agentId=<id>]`. Only three
 * words are read, and the agent id only ever becomes a workspace route.
 */
import { describe, expect, it } from 'vitest';
import { SLACK_BOT_RETURN_MESSAGES, readSlackBotReturn, withoutSlackBotReturn } from '../slack-bot-return';

describe('readSlackBotReturn', () => {
  it.each(['connected', 'cancelled', 'failed'] as const)('reads %s, and goes to the agent\'s Slack settings', (outcome) => {
    expect(readSlackBotReturn(`?slack-bot=${outcome}&agentId=a1`)).toEqual({
      outcome,
      returnPath: '/workspace/agents/a1/settings/slack',
    });
  });

  it('any other word, or none, is not a return', () => {
    expect(readSlackBotReturn('?slack-bot=hacked&agentId=a1')).toBeNull();
    expect(readSlackBotReturn('?slack-bot=&agentId=a1')).toBeNull();
    expect(readSlackBotReturn('?slack-bot=CONNECTED')).toBeNull();
    expect(readSlackBotReturn('?agentId=a1')).toBeNull();
    expect(readSlackBotReturn('')).toBeNull();
  });

  it('is not the admin install return: ?slack= alone reads as nothing here', () => {
    expect(readSlackBotReturn('?slack=connected')).toBeNull();
  });

  it('an outcome with no usable agent id still reads, with no route', () => {
    for (const search of [
      '?slack-bot=connected',
      '?slack-bot=connected&agentId=',
      '?slack-bot=connected&agentId=.',
      '?slack-bot=connected&agentId=..',
      '?slack-bot=connected&agentId=%E0%A4%A',
    ]) {
      expect(readSlackBotReturn(search)).toEqual({ outcome: 'connected', returnPath: null });
    }
  });

  it('an id with a slash or other awkward characters is encoded into one path segment, never a second', () => {
    const read = readSlackBotReturn('?slack-bot=failed&agentId=a%2Fb%20c');
    expect(read).toEqual({ outcome: 'failed', returnPath: '/workspace/agents/a%2Fb%20c/settings/slack' });
  });
});

describe('withoutSlackBotReturn', () => {
  it('takes out both parameters and keeps the rest', () => {
    expect(withoutSlackBotReturn('?slack-bot=connected&agentId=a1')).toBe('');
    expect(withoutSlackBotReturn('?x=1&slack-bot=failed&agentId=a1&y=2')).toBe('?x=1&y=2');
    expect(withoutSlackBotReturn('?slack=connected&slack-bot=failed')).toBe('?slack=connected');
    expect(withoutSlackBotReturn('')).toBe('');
  });
});

describe('the toast copy', () => {
  it('says one fixed sentence per outcome, never writing the product name', () => {
    expect(SLACK_BOT_RETURN_MESSAGES).toEqual({
      connected: 'The Slack bot is live. Invite it to a channel with /invite.',
      cancelled: "Slack install was cancelled. You can continue it from the agent's Slack settings.",
      failed: "We couldn't finish adding the Slack bot. Try again from the agent's Slack settings.",
    });
    for (const line of Object.values(SLACK_BOT_RETURN_MESSAGES)) expect(line).not.toMatch(/\bAX\b/);
  });
});
