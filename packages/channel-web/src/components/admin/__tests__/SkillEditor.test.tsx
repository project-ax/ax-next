import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillEditor } from '../SkillEditor';
import type { SkillDetail } from '@ax/skills';

// Mock the wire clients.
vi.mock('@/lib/skills', () => ({
  getSkill: vi.fn(),
  upsertSkill: vi.fn(),
  updateSkill: vi.fn(),
}));
// The connectors multi-select pulls owned-connector suggestions. Default to a
// small fixed set; individual tests override as needed.
vi.mock('@/lib/connectors', () => ({
  listConnectors: vi.fn(),
}));

import { getSkill, upsertSkill, updateSkill } from '@/lib/skills';
import { listConnectors } from '@/lib/connectors';

const mockGetSkill = vi.mocked(getSkill);
const mockUpsertSkill = vi.mocked(upsertSkill);
const mockUpdateSkill = vi.mocked(updateSkill);
const mockListConnectors = vi.mocked(listConnectors);

const DETAIL: SkillDetail = {
  id: 'github-api',
  description: 'Interacts with the GitHub REST API.',
  version: 1,
  scope: 'global',
  connectors: ['github'],
  defaultAttached: false,
  updatedAt: '2026-05-18T10:00:00.000Z',
  bodyMd: '# GitHub API\n\nUsage details here.\n',
  manifestYaml: [
    'name: github-api',
    'description: Interacts with the GitHub REST API.',
    'version: 1',
    'connectors:',
    '  - github',
  ].join('\n'),
  files: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mockUpsertSkill.mockResolvedValue({ skillId: 'my-skill', created: true });
  mockUpdateSkill.mockResolvedValue({ skillId: 'github-api', created: false });
  // A connector summary only needs `id` for the suggestions; cast through unknown
  // so the test fixture stays terse.
  mockListConnectors.mockResolvedValue([
    { id: 'github' },
    { id: 'salesforce' },
  ] as unknown as Awaited<ReturnType<typeof listConnectors>>);
});

/** Fill the form's required fields with a valid skill. */
async function fillValidForm(name = 'my-skill', description = 'Does something useful.') {
  const nameInput = await screen.findByLabelText('Name');
  fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: description },
  });
}

describe('SkillEditor (form-first)', () => {
  it('renders the form surface (not raw) by default, with empty fields on create', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    const nameInput = await screen.findByLabelText('Name');
    expect((nameInput as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Description')).toBeTruthy();
    expect(screen.getByLabelText('Instructions')).toBeTruthy();
    // Raw editor is NOT shown by default.
    expect(screen.queryByLabelText('Raw SKILL.md')).toBeNull();
  });

  it('loads an existing skill into the form fields', async () => {
    mockGetSkill.mockResolvedValueOnce(DETAIL);
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText('Loading…')).toBeTruthy();

    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('github-api');
    });
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe(
      'Interacts with the GitHub REST API.',
    );
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toContain(
      'Usage details here.',
    );
    // The connector reference loads as a removable chip.
    expect(screen.getByLabelText('Remove connector github')).toBeTruthy();
  });

  it('disables Save when the name is empty (manifest does not parse)', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText('Name');
    // No name → invalid-name → Save disabled.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(
        true,
      );
    });
  });

  it('assembles a SKILL.md from the form and calls upsertSkill', async () => {
    const onSaved = vi.fn();
    render(<SkillEditor onSaved={onSaved} onCancel={vi.fn()} />);
    await fillValidForm();
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: '# Body\n\nDo the thing.\n' },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(mockUpsertSkill).toHaveBeenCalledTimes(1);
    });
    const [skillMd, opts] = mockUpsertSkill.mock.calls[0]!;
    expect(skillMd).toContain('name: my-skill');
    expect(skillMd).toContain('description: Does something useful.');
    expect(skillMd).toContain('Do the thing.');
    expect(opts).toEqual({ defaultAttached: false, files: [] });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('adds a connector via the multi-select and writes it into connectors: []', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm();

    fireEvent.click(screen.getByRole('combobox', { name: 'Add a connector' }));
    // Pick the suggested "salesforce" connector.
    const option = await screen.findByText('salesforce');
    fireEvent.click(option);

    expect(await screen.findByLabelText('Remove connector salesforce')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(mockUpsertSkill).toHaveBeenCalled());
    const [skillMd] = mockUpsertSkill.mock.calls[0]!;
    expect(skillMd).toContain('connectors:');
    expect(skillMd).toContain('salesforce');
  });

  it('allows free-entry of a connector id not in the owned list', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm();

    fireEvent.click(screen.getByRole('combobox', { name: 'Add a connector' }));
    const input = await screen.findByPlaceholderText('Search or type a connector id…');
    fireEvent.change(input, { target: { value: 'my-custom-connector' } });
    // The "Custom" affordance offers to add the typed id.
    const addCustom = await screen.findByText('Add “my-custom-connector”');
    fireEvent.click(addCustom);

    expect(await screen.findByLabelText('Remove connector my-custom-connector')).toBeTruthy();
  });

  it('removes a connector chip', async () => {
    mockGetSkill.mockResolvedValueOnce(DETAIL);
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);
    const removeBtn = await screen.findByLabelText('Remove connector github');
    fireEvent.click(removeBtn);
    expect(screen.queryByLabelText('Remove connector github')).toBeNull();
  });

  // ── Advanced raw toggle ──────────────────────────────────────────────────

  it('toggles to the raw SKILL.md editor seeded from the form, and back', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm('greeter', 'A friendly skill.');

    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    const raw = (await screen.findByLabelText('Raw SKILL.md')) as HTMLTextAreaElement;
    expect(raw.value).toContain('name: greeter');
    expect(raw.value).toContain('description: A friendly skill.');

    // Toggle back to the form — fields are reconstructed from the raw text.
    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('greeter');
    });
  });

  it('syncs raw → form: an edit in raw is reflected in the form on toggle-back', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm('greeter', 'A friendly skill.');

    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    const raw = await screen.findByLabelText('Raw SKILL.md');
    fireEvent.change(raw, {
      target: {
        value: '---\nname: renamed\ndescription: Edited in raw.\n---\n# New body\n',
      },
    });

    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('renamed');
    });
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe(
      'Edited in raw.',
    );
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toContain(
      'New body',
    );
  });

  it('stays in raw mode (and shows the error) when the raw text does not parse', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm();

    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    const raw = await screen.findByLabelText('Raw SKILL.md');
    fireEvent.change(raw, { target: { value: 'no frontmatter at all' } });

    // Attempt to toggle back — it must refuse and stay in raw.
    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    await waitFor(() => {
      expect(screen.getByLabelText('Raw SKILL.md')).toBeTruthy();
    });
    expect(screen.getByText(/no-fence.*Missing frontmatter fence/)).toBeTruthy();
    // Save is disabled while the raw manifest is invalid.
    expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(true);
  });

  it('round-trips UNKNOWN frontmatter keys through the form (TASK-133)', async () => {
    // A stored skill with a custom `license:` key the form does not surface.
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      manifestYaml: [
        'name: github-api',
        'description: Interacts with the GitHub REST API.',
        'version: 1',
        'connectors:',
        '  - github',
        'license: MIT',
      ].join('\n'),
    });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    // Load into the FORM (license is not a form field — it lives in `extra`).
    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('github-api');
    });

    // Edit a form field, then save. The unknown key must survive.
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Updated description.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mockUpdateSkill).toHaveBeenCalled());
    const [, skillMd] = mockUpdateSkill.mock.calls[0]!;
    expect(skillMd).toContain('description: Updated description.');
    // The unknown key was preserved by the form's structured round-trip.
    expect(skillMd).toContain('license: MIT');
  });

  it('surfaces a server-side error in the alert', async () => {
    mockUpsertSkill.mockRejectedValueOnce(new Error('name mismatch'));
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(screen.getByText('name mismatch')).toBeTruthy());
  });

  // ── default-attached checkbox (preserved behaviour) ──────────────────────

  it('saves the default-attached flag through upsertSkill', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm('greeter', 'A skill.');

    const checkbox = await screen.findByLabelText(/Available to all my agents by default/i);
    expect(checkbox).not.toBeDisabled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /install/i }));

    await waitFor(() => expect(mockUpsertSkill).toHaveBeenCalled());
    const [, opts] = mockUpsertSkill.mock.calls[0]!;
    expect(opts).toEqual({ defaultAttached: true, files: [] });
  });

  it('loads existing defaultAttached state on edit', async () => {
    mockGetSkill.mockResolvedValueOnce({ ...DETAIL, defaultAttached: true });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);
    const checkbox = await screen.findByLabelText(/Available to all my agents by default/i);
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  // ── Additional files (preserved behaviour) ───────────────────────────────

  it('loads an existing skill\'s additional files into the editor', async () => {
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
    expect((screen.getByLabelText('Bundle file contents 1') as HTMLTextAreaElement).value).toBe(
      'print("hi")\n',
    );
    expect((screen.getByLabelText('Bundle file path 2') as HTMLInputElement).value).toBe(
      'reference.md',
    );
  });

  it('adds an additional file and forwards it through upsertSkill', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm();

    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    fireEvent.change(await screen.findByLabelText('Bundle file path 1'), {
      target: { value: 'scripts/run.py' },
    });
    fireEvent.change(screen.getByLabelText('Bundle file contents 1'), {
      target: { value: 'print(1)\n' },
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(mockUpsertSkill).toHaveBeenCalled());
    const [, opts] = mockUpsertSkill.mock.calls[0]!;
    expect(opts).toEqual({
      defaultAttached: false,
      files: [{ path: 'scripts/run.py', contents: 'print(1)\n' }],
    });
  });

  it('round-trips loaded additional files on a body-only edit', async () => {
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      files: [{ path: 'helper.md', contents: 'help\n' }],
    });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    await screen.findByLabelText('Bundle file path 1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Update' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mockUpdateSkill).toHaveBeenCalled());
    const [, , opts] = mockUpdateSkill.mock.calls[0]!;
    expect(opts).toEqual({
      defaultAttached: false,
      files: [{ path: 'helper.md', contents: 'help\n' }],
    });
  });

  it('disables Save when an additional-file path is a traversal', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm();

    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    fireEvent.change(await screen.findByLabelText('Bundle file path 1'), {
      target: { value: '../escape.md' },
    });

    await waitFor(() => {
      expect(screen.getByText(/may not contain ".."/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(true);
    });
  });

  it('flags the reserved .mcp.json additional-file path', async () => {
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm();

    fireEvent.click(screen.getByRole('button', { name: /add file/i }));
    fireEvent.change(await screen.findByLabelText('Bundle file path 1'), {
      target: { value: '.mcp.json' },
    });

    await waitFor(() => {
      expect(screen.getByText(/reserved path/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(true);
    });
  });

  it('removes an additional file so it is no longer sent', async () => {
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      files: [
        { path: 'a.md', contents: 'a\n' },
        { path: 'b.md', contents: 'b\n' },
      ],
    });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(await screen.findByLabelText(/remove bundle file a\.md/i));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Update' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mockUpdateSkill).toHaveBeenCalled());
    const [, , opts] = mockUpdateSkill.mock.calls[0]!;
    expect(opts).toEqual({ defaultAttached: false, files: [{ path: 'b.md', contents: 'b\n' }] });
  });

  it('falls back to raw mode when the stored manifest does not parse', async () => {
    mockGetSkill.mockResolvedValueOnce({
      ...DETAIL,
      // A manifest the parser rejects (capabilities block is forbidden).
      manifestYaml: 'name: broken\ndescription: x\ncapabilities:\n  allowedHosts:\n    - api.x.com\n',
    });
    render(<SkillEditor skillId="github-api" onSaved={vi.fn()} onCancel={vi.fn()} />);

    // Opens straight into the raw editor so the author can fix it.
    const raw = (await screen.findByLabelText('Raw SKILL.md')) as HTMLTextAreaElement;
    expect(raw.value).toContain('name: broken');
    // The Advanced toggle reflects raw mode.
    expect(screen.getByLabelText(/Advanced — edit raw/i)).toBeChecked();
  });

  it('keeps working when the connector list fails to load (free-entry still works)', async () => {
    mockListConnectors.mockRejectedValueOnce(new Error('offline'));
    render(<SkillEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidForm();

    fireEvent.click(screen.getByRole('combobox', { name: 'Add a connector' }));
    const input = await screen.findByPlaceholderText('Search or type a connector id…');
    fireEvent.change(input, { target: { value: 'lonely-connector' } });
    fireEvent.click(await screen.findByText('Add “lonely-connector”'));
    expect(await screen.findByLabelText('Remove connector lonely-connector')).toBeTruthy();
  });
});
