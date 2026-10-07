/**
 * Slice 2c — the admin "Awaiting approval" client: every person's connector
 * requests, and Dismiss. The request body is agent-written, so the list is
 * shaped defensively and never carries a secret ref out of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dismissAuthoredProposal,
  listAuthoredProposals,
  normalizeProposal,
  proposalReach,
} from '../connectors';
import {
  prefillForGeneralForm,
  prefillForRemoteForm,
} from '../connector-request-prefill';

afterEach(() => vi.restoreAllMocks());

function stubFetch(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(status === 204 ? null : JSON.stringify(body), { status }),
    );
}

describe('listAuthoredProposals', () => {
  it('reads the admin route and keeps who asked', async () => {
    const fetchMock = stubFetch({
      drafts: [
        {
          connectorId: 'linear',
          name: 'Linear',
          usageNote: 'Track issues.',
          keyMode: 'workspace',
          proposal: {
            allowedHosts: ['api.linear.app'],
            credentials: [{ slot: 'KEY', kind: 'api-key' }],
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
          updatedAt: '2026-10-07T00:00:00Z',
          proposedBy: { userId: 'u2', label: 'Alice' },
        },
      ],
    });
    const [r] = await listAuthoredProposals();
    expect(fetchMock).toHaveBeenCalledWith('/admin/connectors/authored', {
      credentials: 'include',
    });
    expect(r).toMatchObject({
      connectorId: 'linear',
      keyMode: 'workspace',
      proposedBy: { userId: 'u2', label: 'Alice' },
    });
    expect(r!.proposal.allowedHosts).toEqual(['api.linear.app']);
  });

  it('drops a client-secret ref from the request: it would point at the proposer’s vault', async () => {
    stubFetch({
      drafts: [
        {
          connectorId: 'gh',
          name: 'GitHub',
          proposal: {
            credentials: [
              {
                slot: 'TOKEN',
                kind: 'oauth',
                server: 'gh',
                clientId: 'abc',
                clientSecretRef: 'account:gh:client',
              },
            ],
          },
          proposedBy: { userId: 'u2', label: 'Alice' },
        },
      ],
    });
    const [r] = await listAuthoredProposals();
    expect(r!.proposal.credentials).toEqual([
      { slot: 'TOKEN', kind: 'oauth', server: 'gh', clientId: 'abc' },
    ]);
  });

  it('survives a malformed row instead of breaking the list', async () => {
    stubFetch({
      drafts: [
        { connectorId: 'x', proposal: 'nope', proposedBy: null },
        { name: 'no id' },
      ],
    });
    const rows = await listAuthoredProposals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectorId: 'x',
      name: 'x',
      keyMode: 'personal',
      proposal: { allowedHosts: [], credentials: [], mcpServers: [] },
    });
  });

  it('throws on a failed read (the tab hides the shelf)', async () => {
    stubFetch({}, 403);
    await expect(listAuthoredProposals()).rejects.toThrow(/403/);
  });
});

describe('dismissAuthoredProposal', () => {
  it('DELETEs the id on the admin route with the CSRF header', async () => {
    const fetchMock = stubFetch(null, 204);
    await dismissAuthoredProposal('linear issues');
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/connectors/authored/linear%20issues',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'x-requested-with': 'ax-admin' },
      }),
    );
  });
});

describe('proposalReach', () => {
  it('names server hosts and allowed hosts once each', () => {
    expect(
      proposalReach({
        allowedHosts: ['api.example.com', 'mcp.example.com'],
        credentials: [],
        mcpServers: [
          {
            name: 's',
            transport: 'http',
            url: 'https://mcp.example.com/mcp',
            allowedHosts: [],
            credentials: [],
          },
        ],
        packages: { npm: [], pypi: [] },
      }),
    ).toEqual(['mcp.example.com', 'api.example.com']);
  });
});

describe('normalizeProposal services', () => {
  it('keeps a valid service and drops a malformed one', () => {
    const good = {
      name: 'db',
      image: `postgres@sha256:${'a'.repeat(64)}`,
      ports: [5432],
      env: { POSTGRES_DB: 'app' },
      writablePaths: ['/var/lib/postgresql/data'],
    };
    const out = normalizeProposal({
      services: [good, { name: 'bad', image: 'postgres:latest' }, 'nope'],
    });
    expect(out.services).toEqual([good]);
  });
});

describe('what "Set it up" carries (one rule: only what the editor shows)', () => {
  const base = {
    connectorId: 'x',
    name: 'X',
    usageNote: '',
    keyMode: 'personal' as const,
  };
  it('the remote form keeps the leading server and its header / sign-in only', () => {
    const p = prefillForRemoteForm({
      ...base,
      capabilities: {
        allowedHosts: ['mcp.x.com', 'other.x.com'],
        credentials: [
          { slot: 'H', kind: 'api-key', headerName: 'X-H', server: 's' },
          { slot: 'T', kind: 'oauth', server: 's', authServerUrl: 'https://auth.evil' },
          { slot: 'K', kind: 'api-key' },
        ],
        mcpServers: [
          { name: 's', transport: 'http', url: 'https://mcp.x.com/mcp', allowedHosts: [], credentials: [] },
        ],
        packages: { npm: [], pypi: ['p'] },
      },
    });
    expect(p.capabilities).toEqual({
      allowedHosts: [],
      credentials: [
        { slot: 'H', kind: 'api-key', headerName: 'X-H', server: 's' },
        { slot: 'T', kind: 'oauth', server: 's' },
      ],
      mcpServers: [
        { name: 's', transport: 'http', url: 'https://mcp.x.com/mcp', allowedHosts: [], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
    });
    expect(p.leftOut).toEqual([
      'access to other.x.com',
      'a key named K',
      'the PyPI package p',
    ]);
  });
  it('the general editor keeps hosts, rows, the leading package and services', () => {
    const p = prefillForGeneralForm({
      ...base,
      capabilities: {
        allowedHosts: ['api.x.com'],
        credentials: [{ slot: 'T', kind: 'oauth', server: 'x', tokenUrl: 'https://t.evil' }],
        mcpServers: [],
        packages: { npm: ['a', 'b'], pypi: [] },
      },
    });
    expect(p.capabilities).toEqual({
      allowedHosts: ['api.x.com'],
      credentials: [{ slot: 'T', kind: 'oauth', server: 'x' }],
      mcpServers: [],
      packages: { npm: ['a'], pypi: [] },
    });
    expect(p.leftOut).toEqual(['sign-in addresses for T', 'the npm package b']);
  });
});
