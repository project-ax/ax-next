import { afterEach, describe, expect, it } from 'vitest';
import { slackCardText, slackCardWordsFound } from '../slack-card-words';

describe('slack card words matcher', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('finds every plumbing word and the product name', () => {
    for (const s of [
      'the approver',
      'its requester',
      'Claim bot',
      'claimed',
      'needs rebuilding',
      'Rebuild',
      'rebuilt',
      'the shared app',
      'its own Slack bot',
      'its own bot',
      'configuration token',
      'Your App Configuration Tokens',
      'Ask an AX admin',
    ]) {
      expect(slackCardWordsFound(s), s).not.toEqual([]);
    }
  });

  it('leaves ordinary words alone', () => {
    for (const s of [
      'Waiting for an admin to approve Quill Bot',
      'anything it needs approved',
      'Remember this channel',
      'Take over',
      'Set up again',
      'relax',
      'max',
    ]) {
      expect(slackCardWordsFound(s), s).toEqual([]);
    }
  });

  it('slackCardText reads aria-labels too', () => {
    document.body.innerHTML = '<button aria-label="Rebuild it">x</button><p>hello</p>';
    const text = slackCardText();
    expect(text).toContain('hello');
    expect(slackCardWordsFound(text)).toEqual(['Rebuild']);
  });
});
