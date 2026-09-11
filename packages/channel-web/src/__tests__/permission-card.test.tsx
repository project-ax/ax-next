import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HTTP_SERVER_ERROR } from '../lib/http';
import { PermissionCard } from '../components/PermissionCard';
import {
  getPermissionCardSnapshot,
  permissionCardActions,
} from '../lib/permission-card-store';
import { resumeActions } from '../lib/resume-actions';

// Mock the conversation-id hook at the module level with a stable plain
// function (a mutable holder for the per-test value). Spying on the real
// `useConversationId` would swap a `useSyncExternalStore`-backed hook for a
// constant mid-lifecycle, violating the rules of hooks across re-renders.
let mockConversationId: string | null = 'cnv-1';
vi.mock('../lib/use-conversation-id', () => ({
  useConversationId: () => mockConversationId,
  setActiveConversationId: () => undefined,
}));

const linear = {
  kind: 'skill' as const,
  skillId: 'linear',
  description: 'Read your Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' as const }],
};

describe('PermissionCard', () => {
  beforeEach(() => {
    mockConversationId = 'cnv-1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    permissionCardActions.reset();
  });

  it('renders nothing when no card is pending', () => {
    const { container } = render(<PermissionCard />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the hosts + a key field, and Connect writes the key to the user-scoped store', async () => {
    vi.spyOn(resumeActions, 'continueAfterGrant').mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<PermissionCard />);
    permissionCardActions.show(linear); // re-renders the subscribed component

    expect(await screen.findByText('api.linear.app')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/settings/destinations/skill-slot/credential',
      expect.objectContaining({
        method: 'POST',
        // base64('lin_test_123') === 'bGluX3Rlc3RfMTIz'
        body: expect.stringContaining('"payloadB64":"bGluX3Rlc3RfMTIz"'),
      }),
    );
    // The credential POST routed to the USER scope (/settings, not /admin).
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/settings/destinations/skill-slot/credential',
    );
  });

  it('Connect posts the decision then triggers continue, after writing the key', async () => {
    const continueSpy = vi
      .spyOn(resumeActions, 'continueAfterGrant')
      .mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, attached: true }), { status: 200 }),
      );

    render(<PermissionCard />);
    permissionCardActions.show(linear); // one slot: api_key
    fireEvent.change(await screen.findByLabelText('API key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    // credential write (TASK-35 route) + decision POST both fired.
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/settings/destinations/skill-slot/credential');
    expect(urls).toContain('/api/chat/permission-decision');
    const decisionCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/chat/permission-decision',
    );
    expect(decisionCall?.[1]?.body).toContain('"skillId":"linear"');
    expect(decisionCall?.[1]?.body).toContain('"conversationId":"cnv-1"');
    expect(continueSpy).toHaveBeenCalledTimes(1);
  });

  it('Connect is disabled until every declared slot is filled', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    expect(
      await screen.findByRole('button', { name: /^connect$/i }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'k' } });
    expect(screen.getByRole('button', { name: /^connect$/i })).not.toBeDisabled();
  });

  it('Connect is disabled when there is no active conversation', async () => {
    mockConversationId = null;
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    fireEvent.change(await screen.findByLabelText('API key'), {
      target: { value: 'k' },
    });
    expect(
      screen.getByRole('button', { name: /^connect$/i }),
    ).toBeDisabled();
  });

  it('Not now dismisses without writing a credential, posting a decision, or continuing', async () => {
    const continueSpy = vi
      .spyOn(resumeActions, 'continueAfterGrant')
      .mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    fireEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
  });

  // TASK-39: open-mode authoring surfaces the same card with a warning banner.
  it('shows the "new skill" banner when the request is authored', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'skill',
      skillId: 'notes',
      description: 'Take notes',
      hosts: ['api.example.com'],
      slots: [{ slot: 'API_KEY', kind: 'api-key' as const }],
      authored: true,
    });
    expect(
      await screen.findByText(/wrote this skill itself/i),
    ).toBeInTheDocument();
  });

  it('shows no authored banner for a curated (catalog) request', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    // Wait for the card to render (its hosts badge), then assert no banner.
    expect(await screen.findByText('api.linear.app')).toBeInTheDocument();
    expect(
      screen.queryByText(/wrote this skill itself/i),
    ).toBeNull();
  });

  // TASK packages — authored skills declare npm/pypi packages. The card used to
  // name the registries ("reaches registry.npmjs.org"), which is true and means
  // nothing to most people; TASK-334 (audit A5) says the plain fact instead.
  // Both package kinds get the same sentence — which registry it came from is
  // the grant's business, not the reader's.
  it('shows the extra-software line for a package-using authored skill', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'skill',
      skillId: 'demo',
      description: '',
      hosts: [],
      slots: [],
      packages: { npm: ['cowsay'], pypi: [] },
      authored: true,
    });
    expect(
      await screen.findByText(/download some extra software/i),
    ).toBeInTheDocument();
  });

  it('shows the same line for a Python-package authored skill', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'skill',
      skillId: 'demo',
      description: '',
      hosts: [],
      slots: [],
      packages: { npm: [], pypi: ['requests'] },
      authored: true,
    });
    expect(
      await screen.findByText(/download some extra software/i),
    ).toBeInTheDocument();
  });

  it('shows no package line when packages are empty (both arrays present, length 0)', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'skill',
      skillId: 'demo',
      description: '',
      hosts: [],
      slots: [],
      packages: { npm: [], pypi: [] },
    });
    // Wait for the card to render (title should be visible)
    expect(await screen.findByText('Connect Demo')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-packages')).toBeNull();
  });

  // Distinct from the empty-arrays case above: `packages` is OPTIONAL on the
  // (intentionally liberal) SSE-boundary type, so a back-compat payload may omit
  // it entirely. This exercises the `request.packages != null` guard's
  // `undefined` branch, which the empty-arrays fixture never reaches.
  it('shows no package line when packages is absent entirely', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'skill',
      skillId: 'demo',
      description: '',
      hosts: [],
      slots: [],
      // packages omitted entirely (undefined)
    });
    expect(await screen.findByText('Connect Demo')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-packages')).toBeNull();
  });

  // JIT P2/P7.2 — a slot the user already has vaulted (haveExisting) shows a
  // "use your existing key" hint, renders NO input, counts as filled, and posts
  // NO credential on Connect (the key is already in the vault).
  it('skips the field and posts no credential for a slot already in the vault', async () => {
    vi.spyOn(resumeActions, 'continueAfterGrant').mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'skill',
      skillId: 'linear',
      description: 'd',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: true }],
    });

    // No password input for the vaulted slot; the "use existing" hint is shown.
    // The hint text is split across nodes (Badge + interpolated service name),
    // so match on the normalized textContent of the containing element.
    expect(
      await screen.findByText(
        (_content, el) =>
          el?.tagName === 'SPAN' &&
          el.textContent?.toLowerCase().includes('you already saved') === true,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Linear token')).toBeNull();

    // Connect is enabled with no typing (the slot counts as filled).
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());

    // Only the decision POST happened — NO credential write for the vaulted slot.
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/api/chat/permission-decision');
    expect(urls.some((u) => String(u).includes('/destinations/'))).toBe(false);
  });

  it('posts an account-tagged (not yet vaulted) slot to the account destination', async () => {
    vi.spyOn(resumeActions, 'continueAfterGrant').mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'skill',
      skillId: 'linear',
      description: 'd',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'LINEAR_TOKEN', kind: 'api-key', account: 'linear', haveExisting: false }],
    });

    fireEvent.change(await screen.findByLabelText('Linear token'), {
      target: { value: 'lin-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());

    // The credential POST routed to the ACCOUNT destination at user scope.
    expect(fetchMock).toHaveBeenCalledWith(
      '/settings/destinations/account/credential',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"kind":"account"'),
      }),
    );
  });
});

// TASK-112 — the connector approval card (kind:'connector'). The host (TASK-94)
// fires this verbatim over SSE; channel-web must render it (NO description field —
// a TypeError on the skill default branch was the blocker) and approve it with the
// connectorId subject (reusing the TASK-93 wall via the host grant).
describe('PermissionCard — connector approval (TASK-112)', () => {
  beforeEach(() => {
    mockConversationId = 'cnv-1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    permissionCardActions.reset();
  });

  const linearConnector = {
    kind: 'connector' as const,
    connectorId: 'linear',
    name: 'Linear',
    hosts: ['api.linear.app'],
    slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
    authored: true as const,
    packages: { npm: [], pypi: [] },
  };

  it('renders the connector card (name + hosts + slot) without throwing', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(linearConnector);
    // Title is the connector NAME (not connectorId), and there is no description
    // crash (the skill default branch reads request.description.length).
    expect(await screen.findByText('Connect Linear')).toBeInTheDocument();
    expect(screen.getByText('api.linear.app')).toBeInTheDocument();
    expect(screen.getByLabelText('Linear API key')).toBeInTheDocument();
  });

  it('shows the "new connector" authored banner', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(linearConnector);
    expect(
      await screen.findByText(/wrote this connector itself/i),
    ).toBeInTheDocument();
  });

  it('Connect writes the untagged slot to the connector account vault, POSTs the connectorId decision, then continues', async () => {
    const continueSpy = vi
      .spyOn(resumeActions, 'continueAfterGrant')
      .mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<PermissionCard />);
    permissionCardActions.show(linearConnector);

    fireEvent.change(await screen.findByLabelText('Linear API key'), {
      target: { value: 'lin_secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    // Untagged connector slot → account vault keyed by the connectorId
    // (account:<connectorId>) so it addresses the same row the connector
    // resolver reads.
    expect(urls).toContain('/settings/destinations/account/credential');
    const credCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/settings/destinations/account/credential',
    );
    expect(credCall?.[1]?.body).toContain('"service":"linear"');
    // Decision POST carries the connectorId subject (NOT skillId).
    expect(urls).toContain('/api/chat/permission-decision');
    const decisionCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/chat/permission-decision',
    );
    expect(decisionCall?.[1]?.body).toContain('"connectorId":"linear"');
    expect(decisionCall?.[1]?.body).not.toContain('"skillId"');
    expect(decisionCall?.[1]?.body).toContain('"conversationId":"cnv-1"');
    expect(continueSpy).toHaveBeenCalledTimes(1);
  });

  it('an account-tagged slot posts to the account destination by its service tag', async () => {
    vi.spyOn(resumeActions, 'continueAfterGrant').mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'connector',
      connectorId: 'gdrive-connector',
      name: 'Google Drive',
      hosts: ['drive.googleapis.com'],
      slots: [{ slot: 'GDRIVE', kind: 'api-key', account: 'google', haveExisting: false }],
      packages: { npm: [], pypi: [] },
    });
    fireEvent.change(await screen.findByLabelText('Google Gdrive'), {
      target: { value: 'g-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    const credCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/settings/destinations/account/credential',
    );
    expect(credCall?.[1]?.body).toContain('"service":"google"');
  });

  // TASK-124 — a multi-slot connector card carries per-slot `service`+`slotTag`
  // (set by the orchestrator producer). Each slot's Connect write must address its
  // DISTINCT `account:<service>:<slot>` row — never collapse the two onto one.
  it('a multi-slot connector writes each slot to its DISTINCT per-slot account row', async () => {
    vi.spyOn(resumeActions, 'continueAfterGrant').mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'connector',
      connectorId: 'oauthsvc',
      name: 'OAuth Service',
      hosts: [],
      slots: [
        { slot: 'CLIENT_ID', kind: 'api-key', service: 'oauthsvc', slotTag: 'CLIENT_ID', haveExisting: false },
        { slot: 'CLIENT_SECRET', kind: 'api-key', service: 'oauthsvc', slotTag: 'CLIENT_SECRET', haveExisting: false },
      ],
      packages: { npm: [], pypi: [] },
    });
    fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: 'the-id' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'the-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());

    const credBodies = fetchMock.mock.calls
      .filter((c) => c[0] === '/settings/destinations/account/credential')
      .map((c) => String(c[1]?.body ?? ''));
    expect(credBodies).toHaveLength(2);
    const idBody = credBodies.find((b) => b.includes('"slot":"CLIENT_ID"'));
    const secretBody = credBodies.find((b) => b.includes('"slot":"CLIENT_SECRET"'));
    // Both rows carry the SAME service but DISTINCT slot → distinct vault rows.
    expect(idBody).toContain('"service":"oauthsvc"');
    expect(idBody).toContain('"slot":"CLIENT_ID"');
    expect(secretBody).toContain('"service":"oauthsvc"');
    expect(secretBody).toContain('"slot":"CLIENT_SECRET"');
  });

  it('Not now dismisses a connector card without writing or posting', async () => {
    const continueSpy = vi
      .spyOn(resumeActions, 'continueAfterGrant')
      .mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<PermissionCard />);
    permissionCardActions.show(linearConnector);
    fireEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
  });

  it('Connect is disabled until every connector slot is filled', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(linearConnector);
    expect(
      await screen.findByRole('button', { name: /^connect$/i }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Linear API key'), { target: { value: 'k' } });
    expect(screen.getByRole('button', { name: /^connect$/i })).not.toBeDisabled();
  });
});

describe('PermissionCard — host grant (TASK-37)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    permissionCardActions.reset();
  });

  it('renders the host + two grant buttons; "Just this once" POSTs the grant then dismisses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ added: true }), { status: 200 }));
    render(<PermissionCard />);
    permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });

    // The host appears in both the title and a Badge — assert the title.
    expect(
      await screen.findByText(/Allow access to status\.example\.com\?/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /just this once/i }));

    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/allow-host',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"host":"status.example.com"'),
      }),
    );
    // The grant body echoes the opaque sessionId; the route re-validates owner.
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"sessionId":"s1"');
    // "Just this once" → no durable grant (TASK-37 behavior; persist absent/false).
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toContain('"persist":true');
    // CSRF posture: the user-scoped write header.
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-requested-with': 'ax-admin',
    });
  });

  it('"Always for this agent" POSTs persist:true (TASK-44 durable grant)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ added: true }), { status: 200 }));
    render(<PermissionCard />);
    permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
    fireEvent.click(await screen.findByRole('button', { name: /always for this agent/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/allow-host',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"persist":true');
  });

  it('Not now dismisses a host card without granting', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<PermissionCard />);
    permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
    fireEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a grant failure in an Alert and keeps the card open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    render(<PermissionCard />);
    permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
    fireEvent.click(await screen.findByRole('button', { name: /just this once/i }));
    /*
      TASK-288 — this used to assert the Alert read `allow-host failed: 500`.
      A route name and a status code are not a sentence, and this Alert is the
      only thing the person gets. What matters is that the failure is SAID and
      the card stays open to retry; the status goes to the console.
    */
    expect(await screen.findByText(HTTP_SERVER_ERROR)).toBeInTheDocument();
    // Still pending — the user can retry.
    expect(getPermissionCardSnapshot().request).not.toBeNull();
  });
});

/**
 * TASK-334 — the trust-moment copy (audit A1, A2, A5, A6, A11, A12).
 *
 * These assert the *words*, because on this card the words are the feature.
 * It is the one surface where we ask a non-technical person to paste a secret,
 * and the audit found it doing so behind a label reading `api_key`, under a
 * title naming a slug, beside a greyed-out button that explained none of it.
 */
describe('PermissionCard — trust copy (TASK-334)', () => {
  const withSlot = {
    kind: 'skill' as const,
    skillId: 'linear',
    description: 'Read your Linear issues',
    hosts: ['api.linear.app'],
    slots: [{ slot: 'api_key', kind: 'api-key' as const }],
  };

  afterEach(() => {
    vi.restoreAllMocks();
    permissionCardActions.reset();
  });

  it('labels the credential field in English rather than as its slot id', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(withSlot);
    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
    expect(screen.queryByText('api_key')).toBeNull();
  });

  it('says where the key goes, so handing one over is not a leap of faith', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(withSlot);
    expect(await screen.findByText(/the agent never sees it/i)).toBeInTheDocument();
  });

  it('says what the host list is for before showing it', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(withSlot);
    expect(await screen.findByText(/it needs to reach:/i)).toBeInTheDocument();
  });

  it('explains the disabled Connect button instead of leaving it inert', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(withSlot);
    expect(await screen.findByRole('button', { name: /^connect$/i })).toBeDisabled();
    expect(screen.getByText(/add the key above to continue/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'k' } });
    expect(screen.getByRole('button', { name: /^connect$/i })).not.toBeDisabled();
    expect(screen.queryByText(/add the key above to continue/i)).toBeNull();
  });

  it('says the grant is durable, not yet applied, and reversible', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(withSlot);
    expect(
      await screen.findByText(/nothing happens until you choose/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/change it later in settings/i)).toBeInTheDocument();
  });

  it('titles the card by a readable name, not the raw skill id', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({ ...withSlot, skillId: 'linear-issues' });
    expect(await screen.findByText('Connect Linear issues')).toBeInTheDocument();
  });

  it('falls back to the raw id when there is nothing readable in it', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({ ...withSlot, skillId: '___' });
    expect(await screen.findByText('Connect ___')).toBeInTheDocument();
  });

  it('renders the authored warning as an Alert with an icon, not a bare glyph', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({ ...withSlot, authored: true });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/wrote this skill itself/i);
    expect(alert.querySelector('svg')).not.toBeNull();
    expect(alert.textContent).not.toContain('⚠');
  });

  it('gives the connector card the same reassurance and the same blank-slot hint', async () => {
    render(<PermissionCard />);
    permissionCardActions.show({
      kind: 'connector',
      connectorId: 'linear',
      name: 'Linear',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
    });
    expect(
      await screen.findByText(/nothing happens until you choose/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/add the key above to continue/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Linear API key')).toBeInTheDocument();
  });
});
