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

  // N6 — oauth=error is passed through just like oauth=success: posts to
  // opener and closes the popup.
  it('(N6) popup: posts oauth=error outcome to opener and closes', () => {
    const post = vi.fn();
    const close = vi.fn();
    const handled = handleOAuthReturn({
      pathname: '/oauth/connected',
      search: '?oauth=error&connector=c',
      origin: 'https://app',
      opener: { postMessage: post } as unknown as Window,
      closeSelf: close,
    });
    expect(handled).toBe(true);
    expect(post).toHaveBeenCalledWith(
      { type: OAUTH_MESSAGE_TYPE, connector: 'c', oauth: 'error' },
      'https://app',
    );
    expect(close).toHaveBeenCalled();
  });

  // Slice 3 — the popup learns WHY an Add failed, but only as one of four
  // fixed words. Anything else in the URL never reaches the opener.
  function postedFor(search: string): unknown {
    const post = vi.fn();
    handleOAuthReturn({
      pathname: '/oauth/connected',
      search,
      origin: 'https://app',
      opener: { postMessage: post } as unknown as Window,
      closeSelf: vi.fn(),
    });
    return post.mock.calls[0]![0];
  }

  it.each(['cancelled', 'not-allowed', 'add-failed', 'sign-in-failed'])(
    'forwards the known reason %s',
    (reason) => {
      expect(postedFor(`?oauth=error&connector=c&reason=${reason}`)).toEqual({
        type: OAUTH_MESSAGE_TYPE,
        connector: 'c',
        oauth: 'error',
        reason,
      });
    },
  );

  it('drops an unknown reason (no provider text crosses to the opener)', () => {
    expect(postedFor('?oauth=error&connector=c&reason=Provider%20said%20no')).toEqual({
      type: OAUTH_MESSAGE_TYPE,
      connector: 'c',
      oauth: 'error',
    });
  });

  it('a success carries no reason even if the URL has one', () => {
    expect(postedFor('?oauth=success&connector=c&reason=cancelled')).toEqual({
      type: OAUTH_MESSAGE_TYPE,
      connector: 'c',
      oauth: 'success',
    });
  });
});
