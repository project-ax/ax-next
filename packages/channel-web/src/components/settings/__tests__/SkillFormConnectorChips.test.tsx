/**
 * The connector chips in the skill editor: the Remove button must stay a
 * sibling of the badge. `StatusBadge` truncates its children, so a button
 * inside it would be pushed out of view by a long connector id (at 390px).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkillForm, type SkillEditorApi } from '../SkillForm';

vi.mock('@/lib/connectors', () => ({ listConnectors: vi.fn(async () => []) }));

const LONG = 'a-very-long-connector-identifier-that-would-push-the-remove-button-out-of-view';

const api: SkillEditorApi = {
  getSkill: vi.fn(async () => ({
    manifestYaml: `name: demo\ndescription: Demo skill.\nversion: 1\nconnectors:\n  - ${LONG}\n  - brave\n`,
    bodyMd: 'Body.',
    files: [],
    defaultAttached: false,
  })) as unknown as SkillEditorApi['getSkill'],
  upsertSkill: vi.fn(),
  updateSkill: vi.fn(),
};

describe('SkillForm connector chips', () => {
  it('keeps each Remove button outside its badge, with its accessible name', async () => {
    render(<SkillForm skillId="demo" api={api} onSaved={vi.fn()} onCancel={vi.fn()} />);
    for (const id of [LONG, 'brave']) {
      const remove = await screen.findByRole('button', { name: `Remove connector ${id}` });
      const badgeText = screen.getByText(id);
      const badge = badgeText.parentElement!;
      expect(badge).not.toContainElement(remove);
      expect(remove.parentElement).toContainElement(badge);
    }
  });
});
