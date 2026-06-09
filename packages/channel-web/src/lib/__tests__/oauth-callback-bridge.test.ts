import { describe, it, expect, vi } from 'vitest';
import { handleOAuthReturn, OAUTH_MESSAGE_TYPE } from '../oauth-callback-bridge';

describe('handleOAuthReturn', () => {
  it('popup: posts the outcome to opener (origin-locked) and signals handled', () => {
    const post = vi.fn();
    const close = vi.fn();
    const handled = handleOAuthReturn({
      pathname: '/oauth/connected',
      search: '?oauth=success&connector=c',
      origin: 'https://app',
      opener: { postMessage: post } as unknown as Window,
      closeSelf: close,
    });
    expect(handled).toBe(true);
    expect(post).toHaveBeenCalledWith(
      { type: OAUTH_MESSAGE_TYPE, connector: 'c', oauth: 'success' },
      'https://app',
    );
    expect(close).toHaveBeenCalled();
  });

  it('non-oauth path returns false (app boots normally)', () => {
    expect(
      handleOAuthReturn({
        pathname: '/',
        search: '',
        origin: 'https://app',
        opener: null,
        closeSelf: vi.fn(),
      }),
    ).toBe(false);
  });

  it('return path but no opener returns false (full-page fallback handled by App)', () => {
    expect(
      handleOAuthReturn({
        pathname: '/oauth/connected',
        search: '?oauth=success&connector=c',
        origin: 'https://app',
        opener: null,
        closeSelf: vi.fn(),
      }),
    ).toBe(false);
  });

  it('ignores an unrelated oauth value', () => {
    expect(
      handleOAuthReturn({
        pathname: '/oauth/connected',
        search: '?oauth=bogus',
        origin: 'https://app',
        opener: { postMessage: vi.fn() } as unknown as Window,
        closeSelf: vi.fn(),
      }),
    ).toBe(false);
  });
});
