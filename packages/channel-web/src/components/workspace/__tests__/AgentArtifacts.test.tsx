import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import type { ArtifactSummary } from '@/lib/workspace-types';
import { AgentArtifacts } from '../AgentArtifacts';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      artifacts: vi.fn(),
      artifactsDownloadAllUrl: (id: string) => `/api/workspace/agents/${id}/artifacts/download-all`,
    },
  };
});

const listMock = vi.mocked(workspaceApi.artifacts);

function art(over: Partial<ArtifactSummary>): ArtifactSummary {
  return {
    artifactId: 'art-1',
    agentId: 'a-quill',
    title: 'Q3 report',
    mediaType: 'application/pdf',
    kind: 'document',
    preview: 'none',
    extension: 'PDF',
    currentVersion: 1,
    sizeBytes: 10,
    linkOn: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => listMock.mockReset());

function renderPanel(onOpen = vi.fn()) {
  render(<AgentArtifacts agentId="a-quill" agentName="Quill" onOpen={onOpen} />);
  return onOpen;
}

describe('AgentArtifacts', () => {
  it('rows show title and "Document · PDF", newest first', async () => {
    listMock.mockResolvedValue([
      art({ artifactId: 'old', title: 'Old one', updatedAt: '2026-10-01T00:00:00Z' }),
      art({ artifactId: 'new', title: 'New one', kind: 'spreadsheet', extension: 'XLSX', updatedAt: '2026-11-03T00:00:00Z' }),
    ]);
    renderPanel();
    const rows = await screen.findAllByRole('button', { name: /one/ });
    expect(rows.map((r) => r.getAttribute('title'))).toEqual(['New one', 'Old one']);
    expect(within(rows[0]!).getByText('Spreadsheet · XLSX')).toBeTruthy();
    expect(within(rows[1]!).getByText('Document · PDF')).toBeTruthy();
  });

  it('the empty state speaks plainly, and Download all is hidden', async () => {
    listMock.mockResolvedValue([]);
    renderPanel();
    expect(
      await screen.findByText('Ask your agent to make you a report, page or spreadsheet — it’ll show up here.'),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Download all/ })).toBeNull();
  });

  it('Download all points at the agent’s download-all route', async () => {
    listMock.mockResolvedValue([art({})]);
    renderPanel();
    const link = await screen.findByRole('link', { name: /Download all/ });
    expect(link.getAttribute('href')).toBe('/api/workspace/agents/a-quill/artifacts/download-all');
  });

  it('a refused Download all shows the server’s sentence instead of crashing', async () => {
    listMock.mockResolvedValue([art({})]);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'busy', message: 'One download at a time, please — try again in a moment.' }), { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    fireEvent.click(await screen.findByRole('link', { name: /Download all/ }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'One download at a time, please — try again in a moment.');
    vi.unstubAllGlobals();
  });

  it('a failed load shows an alert with Try again, which reloads', async () => {
    listMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([art({})]);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Q3 report')).toBeTruthy();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('clicking a row calls onOpen with its artifactId', async () => {
    listMock.mockResolvedValue([art({ artifactId: 'art-42' })]);
    const onOpen = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Q3 report/ }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('art-42'));
  });
});
