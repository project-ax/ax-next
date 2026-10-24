/**
 * A get-done task's steps on its page (TASK-948): read-only, drawn as text.
 *
 * The copy is asserted verbatim (decisions row 16). Its apostrophes are U+2019.
 * Words are matched on text nodes, not accessible names: jsdom reads an
 * `sr-only` span as a word of its own.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { TaskStep } from '@/lib/workspace-types';
import { STEP_CANT_SHOW, TaskSteps } from '../TaskSteps';

const HOSTILE = '**bold** <img src=x onerror=alert(1)>';

const STEPS: TaskStep[] = [
  { id: 's1', text: 'Export every article', done: true, byAgent: true },
  { id: 's2', text: HOSTILE, done: false, byAgent: false },
  { id: 's3', text: null, done: false, byAgent: true },
];

describe('TaskSteps (TASK-948)', () => {
  it('counts the done steps in its heading and lists every step in order', () => {
    render(<TaskSteps agentName="Quill" steps={STEPS} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Steps · 1 of 3 done' })).toBeInTheDocument();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    expect(items[0]!.querySelector('svg.lucide-square-check[aria-hidden="true"]')).not.toBeNull();
    expect(within(items[0]!).getByText('Done:')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Export every article')).toBeInTheDocument();
    expect(within(items[0]!).getByText('added by Quill')).toBeInTheDocument();

    expect(items[1]!.querySelector('svg.lucide-square[aria-hidden="true"]')).not.toBeNull();
    expect(items[1]!.querySelector('svg.lucide-square-check')).toBeNull();
    expect(within(items[1]!).getByText('Not done:')).toBeInTheDocument();
    expect(within(items[1]!).getByText(HOSTILE)).toBeInTheDocument();
    expect(items[1]!.textContent).not.toContain('added by');

    expect(within(items[2]!).getByText(STEP_CANT_SHOW)).toBeInTheDocument();
    expect(within(items[2]!).getByText('added by Quill')).toBeInTheDocument();
  });

  it('draws a step’s text as text: no markup, no markdown', () => {
    render(<TaskSteps agentName="Quill" steps={STEPS} />);
    const list = screen.getByRole('list');
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('strong')).toBeNull();
    expect(list.querySelector('em')).toBeNull();
  });

  it('says there are none yet, and which agent drafts them', () => {
    render(<TaskSteps agentName="Quill" steps={[]} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Steps' })).toBeInTheDocument();
    expect(screen.getByText('No steps yet. Quill drafts them at its next check-in.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('the can’t-show line uses the decided apostrophe', () => {
    expect(STEP_CANT_SHOW).toBe('We can’t show this step’s text.');
  });
});
