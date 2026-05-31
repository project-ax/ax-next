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
  scope: 'global',
  capabilities: {
    allowedHosts: ['api.github.com'],
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', description: 'Personal access token' }],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  },
  connectors: [],
  defaultAttached: false,
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
  files: [],
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
      expect(mockUpsertSkill).toHaveBeenCalledWith(VALID_MD, {
        defaultAttached: false,
        files: [],
      });
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
        { defaultAttached: false, files: [] },
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

  it('default-attached checkbox saves the flag through upsertSkill', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const textarea = await screen.findByRole('textbox');
    const VALID_INSTRUCTION_ONLY = [
      '---',
      'name: greeter',
      'description: A skill.',
      '---',
      '# Body',
    ].join('\n');
    fireEvent.change(textarea, { target: { value: VALID_INSTRUCTION_ONLY } });

    const checkbox = await screen.findByLabelText(/default-attached/i);
    expect(checkbox).not.toBeDisabled();
    fireEvent.click(checkbox);

    const save = screen.getByRole('button', { name: /install/i });
    fireEvent.click(save);

    await waitFor(() => {
      expect(mockUpsertSkill).toHaveBeenCalledWith(
        VALID_INSTRUCTION_ONLY,
        { defaultAttached: true, files: [] },
      );
    });
  });

  it('default-attached checkbox is disabled when the parsed manifest declares credentials', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: VALID_MD } });
    // VALID_MD already declares a MY_TOKEN credential slot — lock-out should engage.

    const checkbox = await screen.findByLabelText(/default-attached/i);
    expect(checkbox).toBeDisabled();
  });

  it('loads existing defaultAttached state on edit', async () => {
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      // Override to instruction-only + default-attached.
      capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      manifestYaml: 'name: github-api\ndescription: Interacts with the GitHub REST API.\nversion: 1\n',
      defaultAttached: true,
    });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    const checkbox = await screen.findByLabelText(/default-attached/i);
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  it('preserves checked state across a transient parse error', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const textarea = await screen.findByRole('textbox');
    const VALID_INSTRUCTION_ONLY = [
      '---',
      'name: greeter',
      'description: A skill.',
      '---',
      '# Body',
    ].join('\n');
    fireEvent.change(textarea, { target: { value: VALID_INSTRUCTION_ONLY } });

    const checkbox = await screen.findByLabelText(/default-attached/i);
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Mid-typing: break the YAML so parseSkillManifest fails.
    const BROKEN_YAML = '---\nname: greeter\ndescription: : bad colon\n---\n# Body\n';
    fireEvent.change(textarea, { target: { value: BROKEN_YAML } });

    // The box is disabled while the parse is broken, but its checked
    // state must survive — we do NOT auto-clear on transient errors.
    await waitFor(() => expect(checkbox).toBeDisabled());
    expect(checkbox).toBeChecked();

    // Fix the YAML to a valid instruction-only manifest. The flag should
    // still be checked.
    fireEvent.change(textarea, { target: { value: VALID_INSTRUCTION_ONLY } });
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(checkbox).toBeChecked();
  });

  it('auto-clears the flag when the user adds credential slots', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const textarea = await screen.findByRole('textbox');
    const VALID_INSTRUCTION_ONLY = [
      '---',
      'name: greeter',
      'description: A skill.',
      '---',
      '# Body',
    ].join('\n');
    fireEvent.change(textarea, { target: { value: VALID_INSTRUCTION_ONLY } });

    const checkbox = await screen.findByLabelText(/default-attached/i);
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Add a credential slot — the flag must be auto-cleared.
    fireEvent.change(textarea, { target: { value: VALID_MD } });

    await waitFor(() => expect(checkbox).toBeDisabled());
    expect(checkbox).not.toBeChecked();
  });

  // ── Bundle multi-file authoring (TASK-59) ────────────────────────────────

  it('loads an existing skill\'s bundle files into the editor', async () => {
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      files: [
        { path: 'scripts/run.py', contents: 'print("hi")\n' },
        { path: 'reference.md', contents: '# Ref\n' },
      ],
    });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    const pathInput = await screen.findByLabelText('Bundle file path 1');
    expect((pathInput as HTMLInputElement).value).toBe('scripts/run.py');
    const contents1 = screen.getByLabelText('Bundle file contents 1') as HTMLTextAreaElement;
    expect(contents1.value).toBe('print("hi")\n');
    expect((screen.getByLabelText('Bundle file path 2') as HTMLInputElement).value).toBe(
      'reference.md',
    );
  });

  it('adds a bundle file and forwards it through upsertSkill', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    // The SKILL.md textarea is the first textbox.
    const skillMdArea = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(skillMdArea, { target: { value: VALID_MD } });

    fireEvent.click(screen.getByRole('button', { name: /add file/i }));

    const pathInput = await screen.findByLabelText('Bundle file path 1');
    fireEvent.change(pathInput, { target: { value: 'scripts/run.py' } });
    const contentsArea = screen.getByLabelText('Bundle file contents 1');
    fireEvent.change(contentsArea, { target: { value: 'print(1)\n' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(
        false,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(mockUpsertSkill).toHaveBeenCalledWith(VALID_MD, {
        defaultAttached: false,
        files: [{ path: 'scripts/run.py', contents: 'print(1)\n' }],
      });
    });
  });

  it('round-trips loaded bundle files on a SKILL.md-only edit', async () => {
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      files: [{ path: 'helper.md', contents: 'help\n' }],
    });
    const onSaved = vi.fn();
    render(<SkillEditor skillId="github-api" onSaved={onSaved} onCancel={vi.fn()} />);

    // Wait for the loaded file to appear, then save without touching it.
    await screen.findByLabelText('Bundle file path 1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Update' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(mockUpdateSkill).toHaveBeenCalledWith(
        'github-api',
        expect.stringContaining('name: github-api'),
        { defaultAttached: false, files: [{ path: 'helper.md', contents: 'help\n' }] },
      );
    });
  });

  it('removes a bundle file so it is no longer sent', async () => {
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      files: [
        { path: 'a.md', contents: 'a\n' },
        { path: 'b.md', contents: 'b\n' },
      ],
    });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    const removeFirst = await screen.findByLabelText(/remove bundle file a\.md/i);
    fireEvent.click(removeFirst);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Update' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(mockUpdateSkill).toHaveBeenCalledWith(
        'github-api',
        expect.any(String),
        { defaultAttached: false, files: [{ path: 'b.md', contents: 'b\n' }] },
      );
    });
  });

  it('disables Save when a bundle file path is invalid', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const skillMdArea = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(skillMdArea, { target: { value: VALID_MD } });

    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    const pathInput = await screen.findByLabelText('Bundle file path 1');
    // A path-traversal — the client hint must engage and block Save.
    fireEvent.change(pathInput, { target: { value: '../escape.md' } });

    await waitFor(() => {
      expect(screen.getByText(/may not contain ".."/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(
        true,
      );
    });
  });

  it('accepts a lowercase skill.md bundle file (only the exact SKILL.md is reserved)', async () => {
    // The server reserves the EXACT `SKILL.md` (the generated manifest file);
    // a lowercase `skill.md` is a legitimate distinct extra file. The client
    // hint must mirror the server case-sensitively and NOT block it.
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const skillMdArea = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(skillMdArea, { target: { value: VALID_MD } });

    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    fireEvent.change(await screen.findByLabelText('Bundle file path 1'), {
      target: { value: 'skill.md' },
    });

    await waitFor(() => {
      expect(screen.queryByText(/reserved path/i)).toBeNull();
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(
        false,
      );
    });
  });

  it('flags the reserved .mcp.json bundle file path', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const skillMdArea = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(skillMdArea, { target: { value: VALID_MD } });

    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    fireEvent.change(await screen.findByLabelText('Bundle file path 1'), {
      target: { value: '.mcp.json' },
    });

    await waitFor(() => {
      expect(screen.getByText(/reserved path/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(
        true,
      );
    });
  });

  it('disables Save and flags a duplicate bundle file path', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    const skillMdArea = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(skillMdArea, { target: { value: VALID_MD } });

    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    fireEvent.change(await screen.findByLabelText('Bundle file path 1'), {
      target: { value: 'dup.md' },
    });
    fireEvent.change(screen.getByLabelText('Bundle file path 2'), {
      target: { value: 'dup.md' },
    });

    await waitFor(() => {
      expect(screen.getByText(/duplicate path/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(
        true,
      );
    });
  });
});
