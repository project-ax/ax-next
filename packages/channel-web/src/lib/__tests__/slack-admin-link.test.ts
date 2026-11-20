import { describe, expect, it } from 'vitest';
import { readSlackAdminLink, withoutSlackAdminLink } from '../slack-admin-link';

describe('readSlackAdminLink (TASK-1170)', () => {
  it('reads the exact pair', () => {
    expect(readSlackAdminLink('?admin=slack')).toBe(true);
    expect(readSlackAdminLink('?x=1&admin=slack')).toBe(true);
  });
  it.each(['', '?', '?admin=Slack', '?admin=', '?admin=slack-x', '?admin=slackx', '?admin', '?other=slack'])(
    'is false for %j',
    (search) => {
      expect(readSlackAdminLink(search)).toBe(false);
    },
  );
});

describe('withoutSlackAdminLink', () => {
  it('removes the pair and keeps the rest', () => {
    expect(withoutSlackAdminLink('?admin=slack')).toBe('');
    expect(withoutSlackAdminLink('?a=1&admin=slack&b=2')).toBe('?a=1&b=2');
  });
  it('leaves admin= with another value alone', () => {
    expect(withoutSlackAdminLink('?admin=other')).toBe('?admin=other');
    expect(withoutSlackAdminLink('?admin=Slack&a=1')).toBe('?admin=Slack&a=1');
  });
});
