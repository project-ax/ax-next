/**
 * W3d-2 — the "Updated project memory" chip under an answer.
 *
 * Closed by default, one row per file the answer wrote, and Undo is one
 * inline click: no dialog, so nothing can leave the page unclickable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProjectFileChangeError, workspaceApi } from '@/lib/workspace-api';
import type { ProjectMemoryUpdate } from '@/lib/workspace-types';
import {
  PROJECT_MEMORY_CHANGED_SINCE,
  PROJECT_MEMORY_UNDO_CHANGED_SINCE,
  PROJECT_MEMORY_UNDO_NOT_UNDOABLE,
  PROJECT_MEMORY_UNDONE,
  ProjectMemoryChip,
} from '../ProjectMemoryChip';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { undoProjectChange: vi.fn() } };
});

const undoMock = vi.mocked(workspaceApi.undoProjectChange);

function update(over: Partial<ProjectMemoryUpdate> = {}): ProjectMemoryUpdate {
  return {
    projectId: 'p1',
    canEdit: true,
    files: [
      { versionId: 'v1', path: 'memory/people.md', change: 'created', undo: 'available' },
      { versionId: 'v2', path: 'memory/notes/plan.md', change: 'edited', undo: 'changed-since' },
      { versionId: 'v3', path: 'memory/old.md', change: 'deleted', undo: 'available' },
    ],
    ...over,
  };
}

function open(): void {
  fireEvent.click(screen.getByRole('button', { name: /Updated project memory/ }));
}

const rows = () => screen.getAllByTestId('workspace-project-memory-row');

beforeEach(() => {
  undoMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectMemoryChip', () => {
  it('counts the files in its header and starts closed', () => {
    render(<ProjectMemoryChip update={update()} />);
    const trigger = screen.getByRole('button', { name: 'Updated project memory · 3 files' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('workspace-project-memory-row')).toBeNull();
  });

  it('says "1 file" for one', () => {
    const one = update();
    render(<ProjectMemoryChip update={{ ...one, files: one.files.slice(0, 1) }} />);
    screen.getByRole('button', { name: 'Updated project memory · 1 file' });
  });

  it('lists each file without memory/, with its change word', () => {
    render(<ProjectMemoryChip update={update()} />);
    open();
    const [a, b, c] = rows();
    expect(a!.textContent).toContain('people.md');
    expect(a!.textContent).not.toContain('memory/');
    expect(a!.textContent).toContain('added');
    expect(b!.textContent).toContain('notes/plan.md');
    expect(b!.textContent).toContain('edited');
    expect(c!.textContent).toContain('removed');
  });

  it('links to the project page, and opens it in place when it can', () => {
    const onOpenProject = vi.fn();
    render(<ProjectMemoryChip update={update()} onOpenProject={onOpenProject} />);
    open();
    const link = screen.getByRole('link', { name: 'Open project' });
    expect(link.getAttribute('href')).toMatch(/\/projects\/p1$/);
    fireEvent.click(link);
    expect(onOpenProject).toHaveBeenCalledWith('p1');
  });

  it('a changed-since row says so and offers no Undo', () => {
    render(<ProjectMemoryChip update={update()} />);
    open();
    const row = rows()[1]!;
    within(row).getByText(PROJECT_MEMORY_CHANGED_SINCE);
    expect(within(row).queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('a viewer sees the rows but no Undo', () => {
    render(<ProjectMemoryChip update={update({ canEdit: false })} />);
    open();
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });

  it('Undo calls the api, then the row says Undone and the button goes', async () => {
    undoMock.mockResolvedValue({});
    render(<ProjectMemoryChip update={update()} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Undo people.md' }));
    expect(undoMock).toHaveBeenCalledWith('p1', 'v1');
    const row = rows()[0]!;
    await within(row).findByText(PROJECT_MEMORY_UNDONE);
    expect(within(row).queryByRole('button', { name: /Undo/ })).toBeNull();
    // No modal layer was ever opened, so the page stays clickable.
    expect(document.body.style.pointerEvents).not.toBe('none');
    // The other row keeps its Undo.
    screen.getByRole('button', { name: 'Undo old.md' });
  });

  it('a changed-since refusal shows an alert and takes Undo away', async () => {
    undoMock.mockRejectedValue(new ProjectFileChangeError('/x', 409, 'changed-since'));
    render(<ProjectMemoryChip update={update()} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Undo people.md' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(PROJECT_MEMORY_UNDO_CHANGED_SINCE);
    expect(screen.queryByRole('button', { name: 'Undo people.md' })).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('a not-undoable refusal says so', async () => {
    undoMock.mockRejectedValue(new ProjectFileChangeError('/x', 409, 'not-undoable'));
    render(<ProjectMemoryChip update={update()} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Undo people.md' }));
    expect((await screen.findByRole('alert')).textContent).toBe(PROJECT_MEMORY_UNDO_NOT_UNDOABLE);
  });

  it('any other failure uses the restore words and keeps Undo to try again', async () => {
    undoMock.mockRejectedValue(new ProjectFileChangeError('/x', 404, 'version-not-found'));
    render(<ProjectMemoryChip update={update()} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Undo people.md' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That version isn’t here anymore.');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Undo people.md' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
