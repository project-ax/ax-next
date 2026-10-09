import { describe, it, expect } from 'vitest';
import { consumeOAuthFullPageReturn, oauthFullPageErrorMessage } from '../oauth-full-page-return';

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

  it.each(['success', 'error'] as const)('returns to the originating agent connectors after %s', (oauth) => {
    expect(consumeOAuthFullPageReturn({
      pathname: '/oauth/connected',
      search: `?oauth=${oauth}&agentId=agent-1`,
      hasOpener: false,
    })).toEqual({ toast: oauth, returnPath: '/workspace/agents/agent-1/settings/connectors' });
  });

  it('encodes the agent as one route segment and preserves known failure reasons', () => {
    expect(consumeOAuthFullPageReturn({
      pathname: '/oauth/connected',
      search: '?oauth=error&reason=cancelled&agentId=agent%2Fname%20%23%3F',
      hasOpener: false,
    })).toEqual({
      toast: 'error',
      reason: 'cancelled',
      returnPath: '/workspace/agents/agent%2Fname%20%23%3F/settings/connectors',
    });
  });

  it.each(['', '.', '..'])('rejects an unusable agent id %j', (agentId) => {
    expect(consumeOAuthFullPageReturn({
      pathname: '/oauth/connected',
      search: `?oauth=success&agentId=${encodeURIComponent(agentId)}`,
      hasOpener: false,
    })).toEqual({ toast: 'success' });
  });

  it('ignores arbitrary return targets and keeps malicious-looking ids in one segment', () => {
    expect(consumeOAuthFullPageReturn({
      pathname: '/oauth/connected',
      search: '?oauth=success&returnUrl=https%3A%2F%2Fevil.example%2F&returnPath=%2Fadmin',
      hasOpener: false,
    })).toEqual({ toast: 'success' });
    expect(consumeOAuthFullPageReturn({
      pathname: '/oauth/connected',
      search: '?oauth=success&agentId=..%2F..%2Fadmin',
      hasOpener: false,
    })).toEqual({ toast: 'success', returnPath: '/workspace/agents/..%2F..%2Fadmin/settings/connectors' });
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

  it('forwards a known failure reason, and only a known one', () => {
    expect(
      consumeOAuthFullPageReturn({
        pathname: '/oauth/connected',
        search: '?oauth=error&connector=c&reason=add-failed',
        hasOpener: false,
      }),
    ).toEqual({ toast: 'error', reason: 'add-failed' });
    expect(
      consumeOAuthFullPageReturn({
        pathname: '/oauth/connected',
        search: '?oauth=error&connector=c&reason=%3Cb%3Ehi%3C%2Fb%3E',
        hasOpener: false,
      }),
    ).toEqual({ toast: 'error' });
  });
});

describe('oauthFullPageErrorMessage', () => {
  it('a known reason gets its fixed sentence; none (or sign-in-failed) the generic one', () => {
    expect(oauthFullPageErrorMessage('add-failed')).toBe(
      "You signed in, but we couldn't add it to this agent. Nothing was saved; try again.",
    );
    expect(oauthFullPageErrorMessage('cancelled')).toBe('Sign-in was cancelled, so nothing was added.');
    expect(oauthFullPageErrorMessage('sign-in-failed')).toBe("Couldn't connect. Please try again.");
    expect(oauthFullPageErrorMessage(undefined)).toBe("Couldn't connect. Please try again.");
  });
});
