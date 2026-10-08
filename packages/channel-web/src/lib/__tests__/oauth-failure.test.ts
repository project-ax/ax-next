import { describe, expect, it } from 'vitest';
import { beginRefusalMessage, oauthFailureMessage, parseOAuthFailureReason } from '../oauth-failure';

describe('parseOAuthFailureReason', () => {
  it('accepts exactly the four reasons', () => {
    for (const r of ['cancelled', 'not-allowed', 'add-failed', 'sign-in-failed']) {
      expect(parseOAuthFailureReason(r)).toBe(r);
    }
    for (const r of [undefined, null, '', 'CANCELLED', 'access_denied', 42, {}]) {
      expect(parseOAuthFailureReason(r)).toBeUndefined();
    }
  });
});

describe('oauthFailureMessage', () => {
  it('an Add says what happened, in fixed words', () => {
    expect(oauthFailureMessage('cancelled', 'add', 'Notion')).toBe(
      'Sign-in was cancelled, so nothing was added.',
    );
    expect(oauthFailureMessage('not-allowed', 'add', 'Notion')).toBe(
      "You can't add connectors to this agent any more.",
    );
    expect(oauthFailureMessage('add-failed', 'add', 'Notion')).toBe(
      "You signed in, but we couldn't add it to this agent. Nothing was saved; try again.",
    );
  });

  it('sign-in-failed or no reason is the generic sentence', () => {
    const generic =
      "Sign-in didn't finish, so Notion isn't connected. You can try again whenever you're ready.";
    expect(oauthFailureMessage('sign-in-failed', 'add', 'Notion')).toBe(generic);
    expect(oauthFailureMessage(undefined, 'add', 'Notion')).toBe(generic);
    expect(oauthFailureMessage(undefined, 'sign-in-again', 'Notion')).toBe(generic);
  });

  it('a Sign in again never claims something was or was not added', () => {
    expect(oauthFailureMessage('cancelled', 'sign-in-again', 'Notion')).toBe(
      'Sign-in was cancelled, so nothing changed.',
    );
    expect(oauthFailureMessage('not-allowed', 'sign-in-again', 'Notion')).toBe(
      "You can't sign in on this agent any more.",
    );
  });
});

describe('beginRefusalMessage', () => {
  it('each refusal before the popup opens has its own fixed sentence', () => {
    // SIGNINS-7 — the refusal a private connector meets: say the cause and
    // who can fix it.
    expect(beginRefusalMessage('agent-store-refused')).toBe(
      "This connector can't be used by agents yet. Ask a workspace admin to make it Shared.",
    );
    // SIGNINS-7 — a custom OAuth client whose secret is gone (a person-level
    // copy removed at boot): trying again won't help, an admin will.
    expect(beginRefusalMessage('client-secret-missing')).toBe(
      "This connector's client secret is missing. Ask a workspace admin to enter it again.",
    );
    expect(beginRefusalMessage('not-on-agent')).toBe("This connector isn't on this agent any more.");
    expect(beginRefusalMessage('already-attached')).toBe("It's already on this agent.");
  });
});
