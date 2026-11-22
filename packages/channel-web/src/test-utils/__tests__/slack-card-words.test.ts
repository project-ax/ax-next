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
      'Remember this channel',
      "Don't remember this channel",
      'Not remembered',
    ]) {
      expect(slackCardWordsFound(s), s).not.toEqual([]);
    }
  });

  it('leaves ordinary words alone', () => {
    for (const s of [
      'Waiting for an admin to approve Quill Bot',
      'anything it needs approved',
      "Private channels aren't remembered.",
      'It remembers what team members say in public channels, never in private ones.',
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

  it('slackCardText sees words at element edges (no glued text)', () => {
    document.body.innerHTML = '<h3>Waiting for the approver</h3><p>Asked on</p>';
    expect(slackCardWordsFound(slackCardText())).toEqual(['approver']);
    document.body.innerHTML = '<div>Claim</div><div>Rename</div>';
    expect(slackCardWordsFound(slackCardText())).toEqual(['Claim']);
    document.body.innerHTML = '<button>Rebuild</button><button>Rename</button>';
    expect(slackCardWordsFound(slackCardText())).toEqual(['Rebuild']);
  });

  it('slackCardText sees a phrase split across text nodes', () => {
    // JSX interpolation (`its own {kind} bot`) splits one sentence into several text nodes.
    document.body.innerHTML = '<p>its own <b>Slack</b> bot</p>';
    expect(slackCardWordsFound(slackCardText())).toContain('own Slack bot');
    document.body.innerHTML = '';
    const p = document.createElement('p');
    p.append('the shared ', 'app');
    document.body.append(p);
    expect(slackCardWordsFound(slackCardText())).toContain('shared app');
  });
});
