/**
 * The workspace grant row (TASK-350).
 *
 * Three kinds, and — the thing the card body got wrong — TWO different POST
 * targets. A `skill` or `connector` grant goes to `/api/chat/permission-decision`;
 * a `host` grant goes to `/api/chat/allow-host`, because
 * `PermissionDecisionRequest` refines that exactly one of skillId/connectorId is
 * present and has no host arm at all. A row that posted all three to the same
 * place would 400 on a third of the work.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GrantRow } from '../GrantRow';
import { grantKey } from '@/lib/workspace-grant-store';
import { HTTP_SERVER_ERROR } from '@/lib/http';
import { GRANT_REASSURANCE, KEY_SAFETY, SLOT_HINT } from '@/lib/grant-copy';
import type { PermissionRequest } from '@/server/types';

function row(request: PermissionRequest, conversationId: string | null = 'cnv-1') {
  const onResolved = vi.fn();
  render(
    <GrantRow
      grant={{ key: grantKey(request), request, conversationId }}
      onResolved={onResolved}
    />,
  );
  return { onResolved };
}

function okFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

const skillReq: PermissionRequest = {
  kind: 'skill',
  skillId: 'linear-issues',
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' }],
};

const connectorReq: PermissionRequest = {
  kind: 'connector',
  connectorId: 'linear',
  name: 'Linear',
  hosts: ['api.linear.app'],
  slots: [],
};

const hostReq: PermissionRequest = {
  kind: 'host',
  host: 'example.org',
  sessionId: 'sess-9',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a skill grant', () => {
  test('asks in English, and says where the key goes before asking for it', async () => {
    row(skillReq);

    // The id is humanized — `linear-issues` is what the producer calls it, not
    // what a person would.
    expect(screen.getByText('Connect Linear issues')).toBeInTheDocument();
    expect(screen.getByText('File and read Linear issues')).toBeInTheDocument();
    expect(screen.getByText(/it needs to reach:/i)).toBeInTheDocument();
    expect(screen.getByText('api.linear.app')).toBeInTheDocument();
    expect(screen.getByText(KEY_SAFETY)).toBeInTheDocument();
    expect(screen.getByText(GRANT_REASSURANCE)).toBeInTheDocument();
  });

  test('cannot be connected until the key is there, and says why', () => {
    row(skillReq);

    expect(screen.getByRole('button', { name: /^connect$/i })).toBeDisabled();
    expect(screen.getByText(SLOT_HINT)).toBeInTheDocument();
  });

  test('writes the key, then posts the decision, then drops the row', async () => {
    const fetchMock = okFetch();
    const { onResolved } = row(skillReq);

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('skill:linear-issues'));

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/settings/destinations/skill-slot/credential');
    expect(urls).toContain('/api/chat/permission-decision');

    // base64('lin_test_123') === 'bGluX3Rlc3RfMTIz' — the key is never sent raw.
    const cred = fetchMock.mock.calls.find(
      (c) => c[0] === '/settings/destinations/skill-slot/credential',
    );
    expect(cred?.[1]?.body).toContain('"payloadB64":"bGluX3Rlc3RfMTIz"');

    const decision = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/chat/permission-decision',
    );
    expect(decision?.[1]?.body).toContain('"skillId":"linear-issues"');
    expect(decision?.[1]?.body).toContain('"conversationId":"cnv-1"');
    expect(decision?.[1]?.body).not.toContain('"connectorId"');
    // CSRF: the route is gated on this header, not on a token.
    expect(decision?.[1]?.headers).toMatchObject({ 'x-requested-with': 'ax-admin' });
  });
});

describe('a connector grant', () => {
  test('is titled by its display name, and posts connectorId, never skillId', async () => {
    const fetchMock = okFetch();
    const { onResolved } = row(connectorReq);

    expect(screen.getByText('Connect Linear')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('connector:linear'));
    const decision = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/chat/permission-decision',
    );
    expect(decision?.[1]?.body).toContain('"connectorId":"linear"');
    expect(decision?.[1]?.body).not.toContain('"skillId"');
  });
});

describe('a host grant', () => {
  test('posts to allow-host — NOT to the decision route, which has no host arm', async () => {
    const fetchMock = okFetch();
    const { onResolved } = row(hostReq);

    expect(screen.getByText('Allow access to example.org?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /just this once/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('host:example.org'));
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/api/chat/allow-host');
    expect(urls).not.toContain('/api/chat/permission-decision');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"persist":false');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"sessionId":"sess-9"');
  });

  test('"Always for this agent" is the durable answer — it persists', async () => {
    const fetchMock = okFetch();
    row(hostReq);

    fireEvent.click(screen.getByRole('button', { name: /always for this agent/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"persist":true'),
    );
  });

  test('offers all three answers — once, always, and no', () => {
    row(hostReq);

    expect(screen.getByRole('button', { name: /just this once/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /always for this agent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /not now/i })).toBeInTheDocument();
  });
});

describe('turning a grant down', () => {
  test('is purely local — it drops the row and calls nothing', () => {
    const fetchMock = okFetch();
    const { onResolved } = row(skillReq);

    fireEvent.click(screen.getByRole('button', { name: /not now/i }));

    expect(onResolved).toHaveBeenCalledWith('skill:linear-issues');
    // Nothing to tell the server: the wall already holds, and a grant that was
    // never given needs no revoking.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('when the POST fails', () => {
  test('the row stays, says a sentence, and never shows the status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    const { onResolved } = row(hostReq);

    fireEvent.click(screen.getByRole('button', { name: /just this once/i }));

    expect(await screen.findByText(HTTP_SERVER_ERROR)).toBeInTheDocument();
    // Not cleared: a silent clear would read as "granted" for something that
    // was not.
    expect(onResolved).not.toHaveBeenCalled();
    // The row is still answerable — the button came back.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /just this once/i })).toBeEnabled(),
    );
    // No status code, no route name, no reason code on screen.
    expect(screen.queryByText(/500/)).not.toBeInTheDocument();
    expect(screen.queryByText(/allow-host/)).not.toBeInTheDocument();
  });

  test('a failed credential write does not go on to grant the capability', async () => {
    // The key write is first. If it fails, the decision POST must not run —
    // otherwise the grant lands with no key behind it and the agent fails later
    // for a reason nobody can trace back to here.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }));
    const { onResolved } = row(skillReq);

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await screen.findByText(HTTP_SERVER_ERROR);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain('/api/chat/permission-decision');
    expect(onResolved).not.toHaveBeenCalled();
  });
});

describe('without a conversation', () => {
  test('the connect button is disabled rather than failing on click', () => {
    // The decision route requires a conversationId. A button that posts a
    // request the server must reject is worse than one that is plainly off.
    row(skillReq, null);

    expect(screen.getByRole('button', { name: /^connect$/i })).toBeDisabled();
  });
});
