import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillEditor } from '../SkillEditor';
import type { SkillDetail } from '@ax/skills';

// Mock the wire clients
vi.mock('@/lib/skills', () => ({
  getSkill: vi.fn(),
  upsertSkill: vi.fn(),
  updateSkill: vi.fn(),
}));

import { getSkill, upsertSkill, updateSkill } from '@/lib/skills';

const mockGetSkill = vi.mocked(getSkill);
const mockUpsertSkill = vi.mocked(upsertSkill);
const mockUpdateSkill = vi.mocked(updateSkill);

const DETAIL: SkillDetail = {
  id: 'github-api',
  description: 'Interacts with the GitHub REST API.',
  version: 1,
  capabilities: {
    allowedHosts: ['api.github.com'],
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'Personal access token' }],
  },
  updatedAt: '2026-05-18T10:00:00.000Z',
  bodyMd: '# GitHub API\n\nUsage details here.\n',
  manifestYaml: [
    'name: github-api',
    'description: Interacts with the GitHub REST API.',
    'version: 1',
    'capabilities:',
    '  allowedHosts:',
    '    - api.github.com',
    '  credentials:',
    '    - slot: GITHUB_TOKEN',
    '      kind: api-key',
    '      description: Personal access token',
  ].join('\n'),
};

const VALID_MD = [
  '---',
  'name: my-skill',
  'description: Does something useful.',
  'capabilities:',
  '  allowedHosts:',
  '    - api.example.com',
  '  credentials:',
  '    - slot: MY_TOKEN',
  '      kind: api-key',
  '---',
  '# Body',
  '',
  'Instructions here.',
  '',
].join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  mockUpsertSkill.mockResolvedValue({ skillId: 'my-skill', created: true });
  mockUpdateSkill.mockResolvedValue({ skillId: 'github-api', created: false });
});

describe('SkillEditor', () => {
  it('renders the empty template when no skillId is provided', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toContain('name: example');
      expect(textarea.value).toContain('---');
    });
  });

  it('loads existing skill content when skillId is given', async () => {
    mockGetSkill.mockResolvedValueOnce(DETAIL);
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    // Shows loading initially
    expect(screen.getByText('Loading…')).toBeTruthy();

    await waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toContain('name: github-api');
    });

    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('shows a parse error when content has no frontmatter fence', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    // Clear the textarea to remove the template
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByText(/no-fence.*Missing frontmatter fence/)).toBeTruthy();
    });
  });

  it('disables Save button when content is invalid', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'no frontmatter here' } });

    await waitFor(() => {
      const saveBtn = screen.getByRole('button', { name: 'Install' });
      expect(saveBtn.hasAttribute('disabled')).toBe(true);
    });
  });

  it('shows host badges and slot list in preview when content parses correctly', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: VALID_MD } });

    await waitFor(() => {
      expect(screen.getByText('api.example.com')).toBeTruthy();
      expect(screen.getByText('MY_TOKEN')).toBeTruthy();
      expect(screen.getByText('my-skill')).toBeTruthy();
      expect(screen.getByText('Does something useful.')).toBeTruthy();
    });
  });

  it('calls upsertSkill and invokes onSaved on success (no skillId)', async () => {
    const onSaved = vi.fn();
    render(<SkillEditor onSaved={onSaved} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: VALID_MD } });

    await waitFor(() => {
      const saveBtn = screen.getByRole('button', { name: 'Install' });
      expect(saveBtn.hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(mockUpsertSkill).toHaveBeenCalledWith(VALID_MD);
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('calls updateSkill when skillId is provided', async () => {
    mockGetSkill.mockResolvedValueOnce(DETAIL);
    const onSaved = vi.fn();
    render(<SkillEditor skillId="github-api" onSaved={onSaved} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    // Confirm textarea has valid content (loaded from DETAIL)
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Update' });
      expect(btn.hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(mockUpdateSkill).toHaveBeenCalledWith(
        'github-api',
        expect.stringContaining('name: github-api'),
      );
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces server-side error in the alert', async () => {
    mockUpsertSkill.mockRejectedValueOnce(new Error('name mismatch'));
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: VALID_MD } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(screen.getByText('name mismatch')).toBeTruthy();
    });
  });
});
