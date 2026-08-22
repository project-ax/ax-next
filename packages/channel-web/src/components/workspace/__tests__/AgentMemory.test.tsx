/**
 * The Memory tab's whole job is telling the truth about who owns what
 * (AW-13 / TASK-234). These tests pin the two sentences that make it true:
 *
 *   - the human's rules are kept word for word, and they are editable here;
 *   - the agent's own notes are folded and dropped over time, and the UI SAYS
 *     so — a later copy edit that quietly removes that fails this file.
 *
 * The second one is the deliverable. The storage keeps the promise; this is
 * where the user finds out the promise exists.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MemoryDoc } from '@/lib/workspace-api';
import { AgentMemory, COMPACTION_NOTICE } from '../AgentMemory';

const rulesDoc = (body = ''): MemoryDoc => ({
  name: 'Your rules',
  scope: 'rules',
  body,
});

const learnedDoc = (name: string, body: string): MemoryDoc => ({
  name,
  scope: 'learned',
  body,
});

describe('AgentMemory', () => {
  it('labels both halves and says what happens to the agent\'s half', () => {
    render(
      <AgentMemory
        agentName="Quill"
        docs={[rulesDoc('- Always cc Priya'), learnedDoc('What it knows about you', '# User')]}
        onSaveRules={vi.fn()}
      />,
    );

    expect(screen.getByText('Rules you gave me')).toBeInTheDocument();
    expect(screen.getByText('What it worked out')).toBeInTheDocument();

    // THE deliverable. Asserted against the exported constant so a copy edit
    // has to come to the component and read why the sentence is there.
    expect(screen.getByText(new RegExp(escapeRe(COMPACTION_NOTICE)))).toBeInTheDocument();
    expect(COMPACTION_NOTICE).toMatch(/drop the ones that stop being useful/u);
    expect(COMPACTION_NOTICE).toMatch(/move it up to your rules/u);
  });

  it('promises the rules are kept verbatim and never rewritten', () => {
    render(<AgentMemory agentName="Quill" docs={[rulesDoc()]} onSaveRules={vi.fn()} />);
    expect(
      screen.getByText(/Kept word for word\. Quill reads them before every run/u),
    ).toBeInTheDocument();
  });

  it('shows the editor even when nothing has been written yet', () => {
    render(<AgentMemory agentName="Quill" docs={[rulesDoc()]} onSaveRules={vi.fn()} />);
    const box = screen.getByLabelText('Rules you gave me');
    expect(box).toHaveValue('');
    // Save is off until there is something to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves what the user typed, through the caller\'s write path', async () => {
    const onSaveRules = vi.fn().mockResolvedValue(undefined);
    render(<AgentMemory agentName="Quill" docs={[rulesDoc()]} onSaveRules={onSaveRules} />);

    fireEvent.change(screen.getByLabelText('Rules you gave me'), {
      target: { value: '- cc Priya' },
    });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(onSaveRules).toHaveBeenCalledWith('- cc Priya');
    });
  });

  it('says so when the save fails instead of implying it stuck', async () => {
    const onSaveRules = vi.fn().mockRejectedValue(new Error('workspace /rules → 503'));
    render(<AgentMemory agentName="Quill" docs={[rulesDoc()]} onSaveRules={onSaveRules} />);

    fireEvent.change(screen.getByLabelText('Rules you gave me'), {
      target: { value: '- cc Priya' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(
        screen.getByText(/We could not save that, so nothing changed/u),
      ).toBeInTheDocument();
    });
    // And what the user typed is still in the box — losing it would be the
    // second betrayal in a row.
    expect(screen.getByLabelText('Rules you gave me')).toHaveValue('- cc Priya');
  });

  it('renders the agent\'s notes as text, and never as markup', () => {
    render(
      <AgentMemory
        agentName="Quill"
        docs={[
          rulesDoc(),
          learnedDoc('What it knows about you', '<img src=x onerror=alert(1)>'),
        ]}
        onSaveRules={vi.fn()}
      />,
    );
    // Untrusted model output. It shows up as characters, not as an element.
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('keeps the agent\'s section labelled and honest when it has written nothing', () => {
    render(<AgentMemory agentName="Quill" docs={[rulesDoc()]} onSaveRules={vi.fn()} />);
    expect(screen.getByText('What it worked out')).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing yet — Quill writes this down as it works/u),
    ).toBeInTheDocument();
    // The compaction sentence stays: it explains the rules of the section,
    // not the contents of it.
    expect(screen.getByText(new RegExp(escapeRe(COMPACTION_NOTICE)))).toBeInTheDocument();
  });

  it('refuses to show an empty editor when no rules row came back', () => {
    // The destructive case: an unreadable rules file must NOT render as a
    // blank box, or the next Save overwrites rules the user still has.
    render(<AgentMemory agentName="Quill" docs={[]} onSaveRules={vi.fn()} />);
    expect(screen.getByText('Rules you gave me')).toBeInTheDocument();
    expect(screen.queryByLabelText('Rules you gave me')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(
      screen.getByText(/We could not read your rules just now/u),
    ).toBeInTheDocument();
  });

  it('renders read-only when the caller has no write path', () => {
    render(<AgentMemory agentName="Quill" docs={[rulesDoc('- cc Priya')]} />);
    expect(screen.getByLabelText('Rules you gave me')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
