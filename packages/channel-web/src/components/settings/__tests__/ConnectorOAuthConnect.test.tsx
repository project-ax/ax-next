import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorOAuthConnect } from '../ConnectorOAuthConnect';
import * as oauthLib from '@/lib/connectors-oauth';
import { OAUTH_MESSAGE_TYPE } from '@/lib/oauth-callback-bridge';
import { connectorAccessCopy } from '@/lib/connector-access-copy';

beforeEach(() => {
  vi.spyOn(oauthLib, 'getOAuthStatus').mockResolvedValue('not-connected');
  vi.spyOn(oauthLib, 'beginOAuth').mockResolvedValue({
    authorizationUrl: 'https://provider.example/auth?state=abc',
  });
  // Stub window.open to return a controllable fake popup handle.
  vi.spyOn(window, 'open').mockReturnValue({ closed: false } as Window);
});

afterEach(() => vi.restoreAllMocks());

// ── (a) Status badge rendering ────────────────────────────────────────────────

describe('status badge', () => {
  it('renders "Connected" badge when status is connected', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('connected');
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="TestService" />,
    );
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('renders "Reconnect needed" badge when status is needs-reconnect', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('needs-reconnect');
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="TestService" />,
    );
    expect(await screen.findByText('Reconnect needed')).toBeInTheDocument();
  });

  it('shows "Checking…" while status is in flight, then resolves', async () => {
    let resolve!: (v: oauthLib.OAuthStatus) => void;
    vi.mocked(oauthLib.getOAuthStatus).mockReturnValue(
      new Promise<oauthLib.OAuthStatus>((res) => {
        resolve = res;
      }),
    );
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="TestService" />,
    );
    expect(screen.getByText(/Checking/i)).toBeInTheDocument();
    resolve('not-connected');
    // After resolving, "Checking" is gone — not-connected renders outline badge or nothing visible.
    await waitFor(() =>
      expect(screen.queryByText(/Checking/i)).not.toBeInTheDocument(),
    );
  });

  it('shows "Not connected" badge when status is not-connected', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('not-connected');
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="TestService" />,
    );
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
  });

  it('calls getOAuthStatus with connectorId and agentId when provided', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('connected');
    render(
      <ConnectorOAuthConnect mode="sign-in-again"
        connectorId="svc-2"
        serviceName="TestService"
        agentId="agent-99"
      />,
    );
    await screen.findByText('Connected');
    expect(oauthLib.getOAuthStatus).toHaveBeenCalledWith({
      connectorId: 'svc-2',
      agentId: 'agent-99',
    });
  });
});

// ── (b) Consent gate (requiresConsent=true) ───────────────────────────────────

describe('consent gate', () => {
  it('shows the consent copy and blocks the Connect button until "Continue" is clicked', async () => {
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        requiresConsent
      />,
    );
    // Consent copy must be present with exact wording.
    expect(
      await screen.findByText(
        'Authorizing lets anyone who uses this shared agent act as you on MyService. Only people already on this agent are affected.',
      ),
    ).toBeInTheDocument();
    // Connect button is NOT reachable before consent.
    expect(
      screen.queryByRole('button', { name: /Connect with MyService/i }),
    ).toBeNull();
    // Accept consent → Connect button appears.
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    expect(
      await screen.findByRole('button', { name: /Connect with MyService/i }),
    ).toBeInTheDocument();
  });

  it('consent Alert disappears after "Continue" is clicked', async () => {
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        requiresConsent
      />,
    );
    await screen.findByText(
      'Authorizing lets anyone who uses this shared agent act as you on MyService. Only people already on this agent are affected.',
    );
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Authorizing lets anyone who uses this shared agent act as you on MyService. Only people already on this agent are affected.',
        ),
      ).toBeNull(),
    );
  });
});

// ── (c) No consent step when requiresConsent is false/omitted ─────────────────

describe('no consent step', () => {
  it('shows Connect button immediately when requiresConsent is false', async () => {
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        requiresConsent={false}
      />,
    );
    expect(
      await screen.findByRole('button', { name: /Connect with MyService/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Authorizing lets anyone who uses/i)).toBeNull();
  });

  it('shows Connect button immediately when requiresConsent is omitted', async () => {
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />,
    );
    expect(
      await screen.findByRole('button', { name: /Connect with MyService/i }),
    ).toBeInTheDocument();
  });
});

// ── (d) Clicking Connect calls beginOAuth and opens a popup ──────────────────

describe('connect button click', () => {
  it('calls beginOAuth with connectorId+agentId and opens the popup', async () => {
    render(
      <ConnectorOAuthConnect mode="sign-in-again"
        connectorId="svc-3"
        serviceName="MyService"
        agentId="a-42"
      />,
    );
    const btn = await screen.findByRole('button', { name: /Connect with MyService/i });
    fireEvent.click(btn);
    await waitFor(() => expect(oauthLib.beginOAuth).toHaveBeenCalledWith({
      connectorId: 'svc-3',
      agentId: 'a-42',
      mode: 'sign-in-again',
    }));
    expect(window.open).toHaveBeenCalledWith(
      'https://provider.example/auth?state=abc',
      'ax-oauth-connect',
      'width=600,height=720',
    );
  });

  it('passes the mode it was given (an Add)', async () => {
    render(
      <ConnectorOAuthConnect connectorId="svc-4" serviceName="MyService" agentId="a-7" mode="add" />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await waitFor(() =>
      expect(oauthLib.beginOAuth).toHaveBeenCalledWith({ connectorId: 'svc-4', agentId: 'a-7', mode: 'add' }),
    );
  });

  it('every sign-in belongs to an agent: agentId and mode are required props', () => {
    // Compile-time pins (channel-web's tsc includes tests). Never rendered.
    const noAgent = (
      // @ts-expect-error — agentId is required
      <ConnectorOAuthConnect connectorId="svc-4" serviceName="MyService" mode="add" />
    );
    const noMode = (
      // @ts-expect-error — mode is required
      <ConnectorOAuthConnect connectorId="svc-4" serviceName="MyService" agentId="a-7" />
    );
    expect(noAgent).toBeTruthy();
    expect(noMode).toBeTruthy();
  });

  it('labels the button "Reconnect" when status is needs-reconnect', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('needs-reconnect');
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />,
    );
    expect(
      await screen.findByRole('button', { name: /^Reconnect$/i }),
    ).toBeInTheDocument();
  });
});

// ── (e) Successful OAuth message triggers refetch + onConnected ───────────────

describe('OAuth message handling', () => {
  it('refetches status and calls onConnected on a valid success message', async () => {
    vi.mocked(oauthLib.getOAuthStatus)
      .mockResolvedValueOnce('not-connected')  // initial fetch
      .mockResolvedValue('connected');          // post-callback refetch

    const onConnected = vi.fn();
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        onConnected={onConnected}
      />,
    );

    // Open the popup.
    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());

    // Simulate the popup posting back a success message.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_MESSAGE_TYPE, connector: 'svc-1', oauth: 'success' },
      }),
    );

    await waitFor(() => expect(oauthLib.getOAuthStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());

    // After refetch the "Connected" badge should appear.
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  // I1 — provider error/denial must surface a friendly message and must NOT call onConnected.
  it('(I1) shows friendly sign-in-not-finished message on oauth=error and does NOT call onConnected', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('not-connected');
    const onConnected = vi.fn();
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        onConnected={onConnected}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_MESSAGE_TYPE, connector: 'svc-1', oauth: 'error' },
      }),
    );

    expect(await screen.findByText(/Sign-in didn't finish, so MyService isn't connected/)).toBeInTheDocument();
    // onConnected must NOT be called on failure.
    expect(onConnected).not.toHaveBeenCalled();
    // busy must clear (Connect button re-enabled).
    expect(
      await screen.findByRole('button', { name: /Connect with MyService/i }),
    ).not.toBeDisabled();
  });

  // Slice 3 — a known failure reason picks fixed copy; a Sign in again
  // never says anything was or wasn't "added".
  it('a cancelled Sign in again says nothing changed', async () => {
    render(<ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_MESSAGE_TYPE, connector: 'svc-1', oauth: 'error', reason: 'cancelled' },
      }),
    );
    expect(await screen.findByText('Sign-in was cancelled, so nothing changed.')).toBeInTheDocument();
  });

  // M2 — a message with connector: undefined must NOT match any mounted instance
  // (strict connector match; the old "!== undefined" escape hatch is gone).
  it('(M2) ignores a message with connector: undefined (strict match)', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('not-connected');
    const onConnected = vi.fn();
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        onConnected={onConnected}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());

    // Connector field absent (undefined) — must be silently ignored.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_MESSAGE_TYPE, oauth: 'success' },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(onConnected).not.toHaveBeenCalled();
  });

  // M2 — a message for a different connector must not affect this instance.
  it('(M2) ignores a message with a different connector id', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('not-connected');
    const onConnected = vi.fn();
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        onConnected={onConnected}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_MESSAGE_TYPE, connector: 'svc-OTHER', oauth: 'success' },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(onConnected).not.toHaveBeenCalled();
  });
});

// ── (C1) Popup-blocked guard ──────────────────────────────────────────────────

describe('popup-blocked guard (C1)', () => {
  it('shows an error and re-enables the button when window.open returns null', async () => {
    // beginOAuth resolves normally; it's window.open that is blocked.
    vi.spyOn(window, 'open').mockReturnValue(null);

    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));

    // Error message must appear.
    expect(
      await screen.findByText(
        /couldn't open the sign-in window/i,
      ),
    ).toBeInTheDocument();

    // busy must have cleared — the Connect button is re-enabled.
    expect(
      await screen.findByRole('button', { name: /Connect with MyService/i }),
    ).not.toBeDisabled();

    // beginOAuth was still called (we got as far as opening the popup).
    expect(oauthLib.beginOAuth).toHaveBeenCalled();

    // No listener registered (no error happens if we dispatch a spurious
    // message — the handler was never added, so the flow stays clean).
  });
});

// ── (M4) Status-fetch error renders actionable message ───────────────────────

describe('status fetch error (M4)', () => {
  it('renders "Couldn\'t check the connection" when getOAuthStatus rejects', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockRejectedValue(new Error('network error'));
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />,
    );
    expect(await screen.findByText("Couldn't check the connection — refresh to try again.")).toBeInTheDocument();
    // Must NOT show "Not connected".
    expect(screen.queryByText('Not connected')).toBeNull();
  });
});

// ── (f) Wrong-origin messages are IGNORED ────────────────────────────────────

describe('origin filter (security)', () => {
  it('ignores a message from a foreign origin', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('not-connected');
    const onConnected = vi.fn();
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        onConnected={onConnected}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());

    // Message from evil origin — must be silently dropped.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: OAUTH_MESSAGE_TYPE, connector: 'svc-1', oauth: 'success' },
      }),
    );

    // Give a tick to confirm nothing happened.
    await new Promise((r) => setTimeout(r, 50));
    expect(onConnected).not.toHaveBeenCalled();
    // Status refetch count stays at 1 (just the initial mount fetch).
    expect(oauthLib.getOAuthStatus).toHaveBeenCalledTimes(1);
  });

  it('ignores a message with the wrong OAUTH_MESSAGE_TYPE', async () => {
    const onConnected = vi.fn();
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again"
        connectorId="svc-1"
        serviceName="MyService"
        onConnected={onConnected}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'some:other:type', connector: 'svc-1', oauth: 'success' },
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(onConnected).not.toHaveBeenCalled();
  });
});

// ── (g) beginOAuth error handling ────────────────────────────────────────────

describe('beginOAuth error', () => {
  it('renders the friendly error message and does NOT open a popup', async () => {
    vi.mocked(oauthLib.beginOAuth).mockRejectedValue(
      new Error('Provider unavailable'),
    );
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    expect(await screen.findByText(/couldn't start the sign-in/i)).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('does NOT claim connected after a beginOAuth error', async () => {
    vi.mocked(oauthLib.beginOAuth).mockRejectedValue(new Error('boom'));
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await screen.findByText(/couldn't start the sign-in/i);
    // Must not show a "Connected" badge.
    expect(screen.queryByText('Connected')).toBeNull();
  });
});

// ── (TASK-700) access disclosure ──────────────────────────────────────────────
//
// The launch disclosure for TASK-328: signing in gives the assistant the access
// the sign-in allows, with no per-call approval. It sits with the action it is
// about — above the Connect button — and follows the button into every state the
// button can be in.

describe('access disclosure (TASK-700)', () => {
  const NOTICE = 'connector-access-notice';

  it('shows the sign-in notice above the Connect button', async () => {
    render(<ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />);
    const button = await screen.findByRole('button', { name: /Connect with MyService/i });
    const notice = screen.getByTestId(NOTICE);
    expect(notice).toHaveTextContent(connectorAccessCopy('sign-in').headline);
    expect(notice).toHaveTextContent(connectorAccessCopy('sign-in').details);
    expect(notice.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is still there on Reconnect (re-granting is granting)', async () => {
    vi.mocked(oauthLib.getOAuthStatus).mockResolvedValue('needs-reconnect');
    render(<ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />);
    await screen.findByRole('button', { name: 'Reconnect' });
    expect(screen.getAllByTestId(NOTICE)).toHaveLength(1);
  });

  it('shows alongside the shared-agent consent gate, once, before either button', async () => {
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" requiresConsent />,
    );
    const continueBtn = await screen.findByRole('button', { name: /^Continue$/i });
    const notices = screen.getAllByTestId(NOTICE);
    expect(notices).toHaveLength(1);
    expect(
      notices[0]!.compareDocumentPosition(continueBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // After Continue the notice is still exactly one, not re-stacked.
    fireEvent.click(continueBtn);
    await screen.findByRole('button', { name: /Connect with MyService/i });
    expect(screen.getAllByTestId(NOTICE)).toHaveLength(1);
  });

  it('a host that already shows a wider notice can turn it off', async () => {
    render(
      <ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" showAccessNotice={false} />,
    );
    await screen.findByRole('button', { name: /Connect with MyService/i });
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('is not an alert, so a sign-in error is still the only alert on screen', async () => {
    vi.mocked(oauthLib.beginOAuth).mockRejectedValue(new Error('boom'));
    render(<ConnectorOAuthConnect agentId="a-1" mode="sign-in-again" connectorId="svc-1" serviceName="MyService" />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect with MyService/i }));
    await screen.findByText(/couldn't start the sign-in/i);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
