import { describe, it, expect } from 'vitest';
import { consumeOAuthFullPageReturn } from '../oauth-full-page-return';

describe('consumeOAuthFullPageReturn', () => {
  it('returns null for non-oauth paths', () => {
    expect(
      consumeOAuthFullPageReturn({ pathname: '/', search: '', hasOpener: false }),
    ).toBeNull();
    expect(
      consumeOAuthFullPageReturn({
        pathname: '/settings',
        search: '',
        hasOpener: false,
      }),
    ).toBeNull();
  });

  it('returns null when there IS an opener (popup bridge already handled it)', () => {
    expect(
      consumeOAuthFullPageReturn({
        pathname: '/oauth/connected',
        search: '?oauth=success',
        hasOpener: true,
      }),
    ).toBeNull();
  });

  it('returns { toast: "success" } for a successful full-page return', () => {
    expect(
      consumeOAuthFullPageReturn({
        pathname: '/oauth/connected',
        search: '?oauth=success&connector=my-svc',
        hasOpener: false,
      }),
    ).toEqual({ toast: 'success' });
  });

  it('returns { toast: "error" } for an error full-page return', () => {
    expect(
      consumeOAuthFullPageReturn({
        pathname: '/oauth/connected',
        search: '?oauth=error',
        hasOpener: false,
      }),
    ).toEqual({ toast: 'error' });
  });

  it('returns null for an unrecognized oauth param value', () => {
    expect(
      consumeOAuthFullPageReturn({
        pathname: '/oauth/connected',
        search: '?oauth=pending',
        hasOpener: false,
      }),
    ).toBeNull();
  });

  it('returns null when oauth param is missing', () => {
    expect(
      consumeOAuthFullPageReturn({
        pathname: '/oauth/connected',
        search: '',
        hasOpener: false,
      }),
    ).toBeNull();
  });
});
