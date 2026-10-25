/**
 * A get-done task's steps on its page: drawn as text (TASK-948), and changed
 * by the task's owner, one press at a time (TASK-949).
 *
 * Driven through the real component with only `setTaskSteps` mocked, inside a
 * stand-in for the page that shows each answer's steps (as `TaskPage` does
 * through `useTask().replaceSteps`), so each case is what the person would
 * see. The copy is asserted verbatim because it is decided (TASK-949 plan,
 * Task 6): its apostrophes are U+2019 and the heading's separator is U+00B7.
 * Invisible characters are built with `String.fromCodePoint`, never typed.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { WorkspaceApiError, WorkspaceShapeError, workspaceApi } from '@/lib/workspace-api';
import type { TaskStep, TaskStepsResponse } from '@/lib/workspace-types';
import { STEP_CANT_SHOW, TaskSteps } from '../TaskSteps';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { setTaskSteps: vi.fn() } };
});

const setStepsMock = vi.mocked(workspaceApi.setTaskSteps);

const UNCONFIRMED = 'We couldn’t confirm that change. Try again, and it won’t happen twice.';
const NOT_FOUND = 'We couldn’t find this task any more. It may have been deleted.';
const AS_WRITTEN = 'We couldn’t save that step as written. Change it and try again.';
const SKIPPED = 'That step was changed or removed meanwhile, so we’ve loaded the latest.';
const DUPLICATE = 'That step is already on the list.';
const ALREADY_LISTED = `That step is already on the list, so we${String.fromCodePoint(0x2019)}ve loaded the latest.`;
const CAP_REACHED = `The list reached 50 steps meanwhile, so we${String.fromCodePoint(0x2019)}ve loaded the latest.`;
const AT_CAP = 'A task can have up to 50 steps.';
const EDIT_NOTE = 'Once you save it, Quill reads this as your words.';

const HOSTILE = '**bold** <img src=x onerror=alert(1)>';

/** TASK-948's case: the agent's step, the person's holding markup, and one the server couldn't read. */
const STEPS: TaskStep[] = [
  { id: 's1', text: 'Export every article', done: true, byAgent: true },
  { id: 's2', text: HOSTILE, done: false, byAgent: false },
  { id: 's3', text: null, done: false, byAgent: true },
];

/** A list to change: the agent's step, the person's, and the agent's again. */
const PLAN: TaskStep[] = [
  { id: 's1', text: 'Export every article', done: true, byAgent: true },
  { id: 's2', text: 'Check the redirects', done: false, byAgent: false },
  { id: 's3', text: 'Tell the team', done: false, byAgent: true },
];

const answer = (steps: TaskStep[], skipped = 0): TaskStepsResponse => ({ steps, skipped });

const withStep = (steps: TaskStep[], id: string, over: Partial<TaskStep>): TaskStep[] =>
  steps.map((step) => (step.id === id ? { ...step, ...over } : step));

const many = (n: number): TaskStep[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, text: `Step ${i + 1}`, done: false, byAgent: true }));

/** The page, as far as its steps can tell: it shows each answer's steps. */
function Page({ initial, onChanged }: { initial: TaskStep[]; onChanged: (steps: TaskStep[]) => void }) {
  const [steps, setSteps] = useState(initial);
  return (
    <>
      <button type="button">Elsewhere</button>
      <TaskSteps
        agentId="a1"
        routineId="t1"
        agentName="Quill"
        steps={steps}
        onChanged={(next) => {
          onChanged(next);
          setSteps(next);
        }}
      />
    </>
  );
}

function renderSteps(initial: TaskStep[] = PLAN) {
  const onChanged = vi.fn<(steps: TaskStep[]) => void>();
  render(<Page initial={initial} onChanged={onChanged} />);
  return { onChanged };
}

const box = (name: string) => screen.getByRole('checkbox', { name });
const options = (stepText: string) =>
  screen.getByRole('button', { name: 'Step options', description: stepText });
const addStep = () => screen.getByRole('button', { name: 'Add a step' });
const editInput = () => screen.getByRole('textbox', { name: 'Edit step' }) as HTMLInputElement;
const newInput = () => screen.getByRole('textbox', { name: 'New step' }) as HTMLInputElement;
const sentOps = (call: number) => setStepsMock.mock.calls[call]![2].ops;
const sentId = (call: number) => setStepsMock.mock.calls[call]![2].requestId;

/** Enter in a one-line form submits it (implicit submission), which jsdom leaves to the test. */
function pressEnter(input: HTMLElement) {
  fireEvent.submit(input.closest('form')!);
}

/** Opens a step's options menu from the keyboard (`FactsMemory.test.tsx`'s way) and chooses an item. */
async function choose(stepText: string, item: 'Edit' | 'Delete') {
  const trigger = options(stepText);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

/** Chooses Edit on a step and waits for its editor, in its own row (another may still be open). */
async function edit(stepText: string): Promise<HTMLInputElement> {
  const row = box(stepText).closest('li')!;
  await choose(stepText, 'Edit');
  return (await within(row).findByRole('textbox', { name: 'Edit step' })) as HTMLInputElement;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Where a real browser leaves focus once the control just used goes disabled:
 * `<body>`. jsdom keeps focus on a disabled button, so the drop is made by
 * hand (`TaskPage.test.tsx`'s way): a decoy takes focus and leaves the
 * document, and jsdom hands focus to `<body>` as a browser does.
 */
function dropFocusOnBody() {
  const decoy = document.createElement('button');
  document.body.append(decoy);
  act(() => decoy.focus());
  act(() => decoy.remove());
  expect(document.activeElement).toBe(document.body);
}

let warn: MockInstance;

beforeEach(() => {
  setStepsMock.mockReset();
  // Failed changes are logged, and several cases fail on purpose.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('TaskSteps: what it shows (TASK-948)', () => {
  it('counts the done steps in its heading and lists every step in order, each a box named by its text', () => {
    renderSteps(STEPS);
    expect(screen.getByRole('heading', { level: 2, name: 'Steps · 1 of 3 done' })).toBeInTheDocument();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    expect(
      within(items[0]!).getByRole('checkbox', { name: 'Export every article', description: 'added by Quill' }),
    ).toBeChecked();
    const markup = within(items[1]!).getByRole('checkbox', { name: HOSTILE });
    expect(markup).not.toBeChecked();
    expect(markup).not.toHaveAccessibleDescription();
    expect(items[1]!.textContent).not.toContain('added by');
    expect(
      within(items[2]!).getByRole('checkbox', { name: STEP_CANT_SHOW, description: 'added by Quill' }),
    ).not.toBeChecked();

    // Every step has its options, the agent's included, each saying which step it opens.
    for (const [i, text] of ['Export every article', HOSTILE, STEP_CANT_SHOW].entries()) {
      expect(
        within(items[i]!).getByRole('button', { name: 'Step options', description: text }),
      ).toBeInTheDocument();
    }
  });

  it('draws a step’s text as text: no markup, no markdown, and no attribute built from it', () => {
    renderSteps(STEPS);
    const section = screen.getByRole('region', { name: /^Steps/ });
    expect(within(section).getByText(HOSTILE)).toBeInTheDocument();
    expect(section.querySelector('img')).toBeNull();
    expect(section.querySelector('strong')).toBeNull();
    expect(section.querySelector('em')).toBeNull();
    for (const el of Array.from(section.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) expect(attr.value).not.toContain('onerror');
    }
  });

  it('says there are none yet, how to add one, and which agent drafts them', () => {
    renderSteps([]);
    expect(screen.getByRole('heading', { level: 2, name: 'Steps' })).toBeInTheDocument();
    expect(
      screen.getByText('No steps yet. Add one, or Quill drafts them at its next check-in.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(addStep()).toBeEnabled();
  });

  it('the can’t-show line uses the decided apostrophe', () => {
    expect(STEP_CANT_SHOW).toBe('We can’t show this step’s text.');
  });
});

describe('TaskSteps: ticking (TASK-949)', () => {
  it('ticks and unticks a step with its checkbox, which is named by the step’s text', async () => {
    const d = deferred<TaskStepsResponse>();
    setStepsMock.mockReturnValueOnce(d.promise);
    const { onChanged } = renderSteps();
    const redirects = box('Check the redirects');
    redirects.focus();
    fireEvent.click(redirects);
    expect(setStepsMock).toHaveBeenCalledTimes(1);
    expect(setStepsMock).toHaveBeenCalledWith('a1', 't1', {
      requestId: expect.any(String),
      ops: [{ op: 'tick', id: 's2' }],
    });
    // The box shows what the host says, not what was asked for.
    expect(redirects).not.toBeChecked();
    dropFocusOnBody();

    const ticked = withStep(PLAN, 's2', { done: true });
    await act(async () => d.resolve(answer(ticked)));
    expect(onChanged).toHaveBeenCalledWith(ticked);
    expect(box('Check the redirects')).toBeChecked();
    expect(screen.getByRole('heading', { level: 2, name: 'Steps · 2 of 3 done' })).toBeInTheDocument();
    expect(document.activeElement).toBe(box('Check the redirects'));

    setStepsMock.mockResolvedValueOnce(answer(withStep(ticked, 's1', { done: false })));
    fireEvent.click(box('Export every article'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'untick', id: 's1' }]);
    expect(box('Export every article')).not.toBeChecked();
  });

  it('focus someone moved elsewhere meanwhile stays there', async () => {
    const d = deferred<TaskStepsResponse>();
    setStepsMock.mockReturnValueOnce(d.promise);
    renderSteps();
    fireEvent.click(box('Check the redirects'));
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(async () => d.resolve(answer(withStep(PLAN, 's2', { done: true }))));
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('TaskSteps: rewording (TASK-949)', () => {
  it('Edit and Save sends one edit; Enter saves too; focus lands on the step’s options button', async () => {
    const { onChanged } = renderSteps();
    const input = await edit('Export every article');
    expect(input).toHaveValue('Export every article');
    expect(input.maxLength).toBe(200);
    expect(document.activeElement).toBe(input);
    // Its box keeps its name, and its options give way to the editor.
    expect(box('Export every article')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Step options', description: 'Export every article' }),
    ).toBeNull();

    const reworded = withStep(PLAN, 's1', { text: 'Export every article as CSV', byAgent: false });
    setStepsMock.mockResolvedValueOnce(answer(reworded));
    fireEvent.change(input, { target: { value: 'Export every article as CSV' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(reworded));
    expect(setStepsMock).toHaveBeenCalledTimes(1);
    expect(sentOps(0)).toEqual([{ op: 'edit', id: 's1', text: 'Export every article as CSV' }]);
    expect(screen.queryByRole('textbox', { name: 'Edit step' })).toBeNull();
    expect(document.activeElement).toBe(options('Export every article as CSV'));

    const second = await edit('Check the redirects');
    setStepsMock.mockResolvedValueOnce(answer(withStep(reworded, 's2', { text: 'Check every redirect' })));
    fireEvent.change(second, { target: { value: 'Check every redirect' } });
    pressEnter(second);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'edit', id: 's2', text: 'Check every redirect' }]);
    expect(document.activeElement).toBe(options('Check every redirect'));
  });

  it('Save with the text unchanged closes the editor and sends nothing', async () => {
    renderSteps();
    const input = await edit('Export every article');
    // Spaces the page wouldn't show are no change either: a reword makes the agent's step the person's.
    fireEvent.change(input, { target: { value: ' Export  every article ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('textbox', { name: 'Edit step' })).toBeNull();
    expect(setStepsMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(options('Export every article'));
  });

  it.each(['Escape', 'Cancel'] as const)(
    '%s cancels an edit and focus goes back to the options button',
    async (how) => {
      renderSteps();
      const input = await edit('Check the redirects');
      fireEvent.change(input, { target: { value: 'Something else' } });
      if (how === 'Escape') fireEvent.keyDown(input, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('textbox', { name: 'Edit step' })).toBeNull();
      expect(box('Check the redirects')).toBeInTheDocument();
      expect(setStepsMock).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(options('Check the redirects'));
    },
  );

  it('editing the agent’s step says it becomes the person’s words; editing the person’s step doesn’t', async () => {
    renderSteps();
    const agents = await edit('Export every article');
    expect(agents).toHaveAccessibleDescription(EDIT_NOTE);
    fireEvent.keyDown(agents, { key: 'Escape' });

    const persons = await edit('Check the redirects');
    expect(persons).not.toHaveAccessibleDescription();
    expect(screen.queryByText(EDIT_NOTE)).toBeNull();
  });

  it('a step we can’t show opens its editor empty', async () => {
    renderSteps(STEPS);
    expect(await edit(STEP_CANT_SHOW)).toHaveValue('');
  });

  it('an editor whose step leaves the list closes', async () => {
    const props = { agentId: 'a1', routineId: 't1', agentName: 'Quill', onChanged: vi.fn() };
    const { rerender } = render(<TaskSteps {...props} steps={PLAN} />);
    await edit('Check the redirects');
    rerender(<TaskSteps {...props} steps={[PLAN[0]!, PLAN[2]!]} />);
    expect(screen.queryByRole('textbox', { name: 'Edit step' })).toBeNull();
    expect(addStep()).toBeEnabled();
  });
});

describe('TaskSteps: deleting (TASK-949)', () => {
  it('Delete sends one remove, asks nothing, and focus moves to the next step, else the previous one, else Add a step', async () => {
    const { onChanged } = renderSteps();
    setStepsMock.mockResolvedValueOnce(answer(PLAN.slice(1)));
    await choose('Export every article', 'Delete');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(sentOps(0)).toEqual([{ op: 'remove', id: 's1' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByText('Export every article')).toBeNull();
    expect(document.activeElement).toBe(box('Check the redirects'));

    setStepsMock.mockResolvedValueOnce(answer([PLAN[1]!]));
    await choose('Tell the team', 'Delete');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'remove', id: 's3' }]);
    expect(document.activeElement).toBe(box('Check the redirects'));

    setStepsMock.mockResolvedValueOnce(answer([]));
    await choose('Check the redirects', 'Delete');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
    expect(sentOps(2)).toEqual([{ op: 'remove', id: 's2' }]);
    expect(document.activeElement).toBe(addStep());
  });
});

describe('TaskSteps: adding (TASK-949)', () => {
  it('Add sends one add, empties the input and keeps it open with focus', async () => {
    const { onChanged } = renderSteps();
    fireEvent.click(addStep());
    const input = newInput();
    expect(document.activeElement).toBe(input);
    expect(input.maxLength).toBe(200);

    const d = deferred<TaskStepsResponse>();
    setStepsMock.mockReturnValueOnce(d.promise);
    fireEvent.change(input, { target: { value: 'Update the sitemap' } });
    const add = screen.getByRole('button', { name: 'Add' });
    add.focus();
    fireEvent.click(add);
    dropFocusOnBody();
    const added = [...PLAN, { id: 's4', text: 'Update the sitemap', done: false, byAgent: false }];
    await act(async () => d.resolve(answer(added)));
    expect(onChanged).toHaveBeenCalledWith(added);
    expect(sentOps(0)).toStrictEqual([{ op: 'add', text: 'Update the sitemap' }]);
    expect(newInput()).toHaveValue('');
    expect(document.activeElement).toBe(newInput());
    expect(box('Update the sitemap')).not.toHaveAccessibleDescription();

    setStepsMock.mockResolvedValueOnce(
      answer([...added, { id: 's5', text: 'Tell the editors', done: false, byAgent: false }]),
    );
    fireEvent.change(newInput(), { target: { value: 'Tell the editors' } });
    pressEnter(newInput());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toStrictEqual([{ op: 'add', text: 'Tell the editors' }]);
    expect(newInput()).toHaveValue('');
  });

  it('sends a step’s text as the page will show it, with spaces folded and trimmed', async () => {
    // The route's fence draws text that way, and the host dedupes on the stored text.
    const { onChanged } = renderSteps();
    const added = [...PLAN, { id: 's4', text: 'Update the sitemap', done: false, byAgent: false }];
    setStepsMock.mockResolvedValueOnce(answer(added));
    fireEvent.click(addStep());
    fireEvent.change(newInput(), { target: { value: '  Update   the sitemap ' } });
    pressEnter(newInput());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(sentOps(0)).toStrictEqual([{ op: 'add', text: 'Update the sitemap' }]);
    fireEvent.keyDown(newInput(), { key: 'Escape' });

    setStepsMock.mockResolvedValueOnce(answer(withStep(added, 's2', { text: 'Check every redirect' })));
    const input = await edit('Check the redirects');
    fireEvent.change(input, { target: { value: ' Check every   redirect ' } });
    pressEnter(input);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'edit', id: 's2', text: 'Check every redirect' }]);
  });

  it.each(['Escape', 'Cancel'] as const)(
    '%s on the add input closes it and focus returns to Add a step',
    (how) => {
      renderSteps();
      fireEvent.click(addStep());
      fireEvent.change(newInput(), { target: { value: 'Half a thought' } });
      if (how === 'Escape') fireEvent.keyDown(newInput(), { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('textbox', { name: 'New step' })).toBeNull();
      expect(document.activeElement).toBe(addStep());
      expect(setStepsMock).not.toHaveBeenCalled();
      fireEvent.click(addStep());
      expect(newInput()).toHaveValue('');
    },
  );

  it('opening another editor drops the open one', async () => {
    renderSteps();
    fireEvent.change(await edit('Export every article'), { target: { value: 'Unsaved words' } });
    fireEvent.click(addStep());
    expect(screen.queryByRole('textbox', { name: 'Edit step' })).toBeNull();
    expect(options('Export every article')).toBeInTheDocument();

    fireEvent.change(newInput(), { target: { value: 'Also unsaved' } });
    expect(await edit('Check the redirects')).toHaveValue('Check the redirects');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    // Edit on the first step again starts from its own words.
    expect(await edit('Export every article')).toHaveValue('Export every article');
    expect(setStepsMock).not.toHaveBeenCalled();
  });

  it('at 50 steps Add a step is disabled and says why, and an add editor left open can’t send', async () => {
    const { onChanged } = renderSteps(many(49));
    fireEvent.click(addStep());
    setStepsMock.mockResolvedValueOnce(answer(many(50)));
    fireEvent.change(newInput(), { target: { value: 'Step 50' } });
    pressEnter(newInput());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(newInput()).toHaveValue('');
    expect(newInput()).toHaveAccessibleDescription(AT_CAP);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    fireEvent.change(newInput(), { target: { value: 'Step 51' } });
    pressEnter(newInput());
    expect(setStepsMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.keyDown(newInput(), { key: 'Escape' });
    expect(addStep()).toBeDisabled();
    expect(addStep()).toHaveAccessibleDescription(AT_CAP);
    // Add a step can't take focus, so the last step's box does.
    expect(document.activeElement).toBe(box('Step 50'));
  });

  it('a text the contract refuses shows the contract’s message and sends nothing', async () => {
    renderSteps();
    fireEvent.click(addStep());
    const input = newInput();
    // Checked as typed, so the character it names is where the person typed it.
    fireEvent.change(input, { target: { value: `  ab${String.fromCodePoint(0x200b)}cd` } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'A step can’t contain invisible characters (U+200B at character 5).',
    );
    expect(input).toHaveAttribute('aria-invalid', 'true');

    // Typing clears it.
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toBe('Write the step first.');

    // A Save runs the same rule.
    const editing = await edit('Check the redirects');
    fireEvent.change(editing, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('Write the step first.');
    expect(editing).toHaveAttribute('aria-invalid', 'true');
    expect(setStepsMock).not.toHaveBeenCalled();
  });

  it('an add already on the list says so and sends nothing', () => {
    renderSteps();
    fireEvent.click(addStep());
    fireEvent.change(newInput(), { target: { value: '  Export   every article ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toBe(DUPLICATE);
    expect(newInput()).toHaveValue('  Export   every article ');
    expect(setStepsMock).not.toHaveBeenCalled();
  });
});

describe('TaskSteps: one change at a time (TASK-949)', () => {
  it('while a change is out every control is disabled, the input is read-only, Escape does nothing, and a second press sends nothing', async () => {
    const d = deferred<TaskStepsResponse>();
    setStepsMock.mockReturnValueOnce(d.promise);
    renderSteps();
    fireEvent.click(addStep());
    const input = newInput();
    fireEvent.change(input, { target: { value: 'Update the sitemap' } });
    pressEnter(input);

    const add = screen.getByRole('button', { name: 'Add' });
    expect(input.readOnly).toBe(true);
    expect(add).toBeDisabled();
    expect(within(add).getByRole('status', { hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    for (const control of screen.getAllByRole('checkbox')) expect(control).toBeDisabled();
    for (const control of screen.getAllByRole('button', { name: 'Step options' })) {
      expect(control).toBeDisabled();
    }

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(newInput()).toBe(input);
    pressEnter(input);
    fireEvent.click(box('Check the redirects'));
    expect(setStepsMock).toHaveBeenCalledTimes(1);

    await act(async () =>
      d.resolve(answer([...PLAN, { id: 's4', text: 'Update the sitemap', done: false, byAgent: false }])),
    );
    expect(input.readOnly).toBe(false);
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('while a tick is out, Add a step waits too', async () => {
    const d = deferred<TaskStepsResponse>();
    setStepsMock.mockReturnValueOnce(d.promise);
    renderSteps();
    fireEvent.click(box('Check the redirects'));
    expect(addStep()).toBeDisabled();
    fireEvent.click(box('Tell the team'));
    expect(setStepsMock).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(answer(withStep(PLAN, 's2', { done: true }))));
    expect(addStep()).toBeEnabled();
  });

  it('a skipped change says the list was reloaded, and shows the answer’s steps; a skipped add keeps its text', async () => {
    const { onChanged } = renderSteps();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');

    // The redirects step was removed elsewhere before the tick reached the host.
    const meanwhile = [PLAN[0]!, PLAN[2]!];
    setStepsMock.mockResolvedValueOnce(answer(meanwhile, 1));
    fireEvent.click(box('Check the redirects'));
    await waitFor(() => expect(status.textContent).toBe(SKIPPED));
    expect(onChanged).toHaveBeenCalledWith(meanwhile);
    expect(screen.queryByRole('checkbox', { name: 'Check the redirects' })).toBeNull();
    // Its step is gone, so focus goes to the one now in its place.
    expect(document.activeElement).toBe(box('Tell the team'));

    setStepsMock.mockResolvedValueOnce(answer(meanwhile, 1));
    fireEvent.click(addStep());
    fireEvent.change(newInput(), { target: { value: 'Update the sitemap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(status.textContent).toBe('');
    await waitFor(() => expect(status.textContent).toBe(SKIPPED));
    expect(newInput()).toHaveValue('Update the sitemap');

    setStepsMock.mockResolvedValueOnce(answer(withStep(meanwhile, 's3', { done: true })));
    fireEvent.click(box('Tell the team'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
    expect(status.textContent).toBe('');
  });

  it('a skipped add whose text is now listed says it is already on the list', async () => {
    // Another tab, or the agent, added the same step first; the answer's copy has its spaces folded.
    const meanwhile = [...PLAN, { id: 's4', text: 'Update the sitemap', done: false, byAgent: true }];
    setStepsMock.mockResolvedValueOnce(answer(meanwhile, 1));
    const { onChanged } = renderSteps();
    const status = screen.getByRole('status');
    fireEvent.click(addStep());
    fireEvent.change(newInput(), { target: { value: '  Update   the sitemap ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(status.textContent).toBe(ALREADY_LISTED));
    expect(onChanged).toHaveBeenCalledWith(meanwhile);
  });

  it('a skipped add whose answer holds 50 steps says the list filled meanwhile; the cap itself is the editor’s note', async () => {
    // The agent filled the list before the add reached the host.
    setStepsMock.mockResolvedValueOnce(answer(many(50), 1));
    renderSteps(many(49));
    const status = screen.getByRole('status');
    fireEvent.click(addStep());
    fireEvent.change(newInput(), { target: { value: 'Update the sitemap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(status.textContent).toBe(CAP_REACHED));
    expect(newInput()).toHaveAccessibleDescription(AT_CAP);
    expect(screen.getAllByText(AT_CAP)).toHaveLength(1);
    expect(newInput()).toHaveValue('Update the sitemap');
  });

  it('a skipped change that isn’t an add keeps the changed-or-removed line, even at 50 steps', async () => {
    setStepsMock.mockResolvedValueOnce(answer(many(50), 1));
    renderSteps(many(50));
    const status = screen.getByRole('status');
    fireEvent.click(box('Step 1'));
    await waitFor(() => expect(status.textContent).toBe(SKIPPED));
  });
});

describe('TaskSteps: the request id (TaskReplyBox’s rule)', () => {
  it('is kept for the same change across an unconfirmed failure, so a retry can’t apply it twice', async () => {
    setStepsMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 503))
      .mockResolvedValueOnce(answer(withStep(PLAN, 's2', { done: true })));
    renderSteps();
    fireEvent.click(box('Check the redirects'));
    await screen.findByRole('alert');
    fireEvent.click(box('Check the redirects'));
    await waitFor(() => expect(setStepsMock).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'tick', id: 's2' }]);
    expect(sentId(1)).toBe(sentId(0));
  });

  it('is dropped after a refusal', async () => {
    setStepsMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 400))
      .mockResolvedValueOnce(answer(withStep(PLAN, 's2', { done: true })));
    renderSteps();
    fireEvent.click(box('Check the redirects'));
    await screen.findByRole('alert');
    fireEvent.click(box('Check the redirects'));
    await waitFor(() => expect(setStepsMock).toHaveBeenCalledTimes(2));
    expect(sentId(1)).not.toBe(sentId(0));
  });

  it('is new for a different change after an unconfirmed failure', async () => {
    setStepsMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 503))
      .mockResolvedValueOnce(answer(withStep(PLAN, 's3', { done: true })));
    renderSteps();
    fireEvent.click(box('Check the redirects'));
    await screen.findByRole('alert');
    fireEvent.click(box('Tell the team'));
    await waitFor(() => expect(setStepsMock).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'tick', id: 's3' }]);
    expect(sentId(1)).not.toBe(sentId(0));
  });

  // The id is keyed on the whole change, its text included: an add or an edit
  // whose text changed after an unconfirmed failure is a different change, so
  // reusing the id would have the host refuse it as a reused request.
  it('is new for an add whose text changed after an unconfirmed failure', async () => {
    setStepsMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 503))
      .mockResolvedValueOnce(answer([...PLAN, { id: 's4', text: 'Update the robots file', done: false, byAgent: false }]));
    renderSteps();
    fireEvent.click(addStep());
    fireEvent.change(newInput(), { target: { value: 'Update the sitemap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await within(newInput().closest('form')!).findByRole('alert');
    fireEvent.change(newInput(), { target: { value: 'Update the robots file' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(setStepsMock).toHaveBeenCalledTimes(2));
    expect(sentOps(0)).toStrictEqual([{ op: 'add', text: 'Update the sitemap' }]);
    expect(sentOps(1)).toStrictEqual([{ op: 'add', text: 'Update the robots file' }]);
    expect(sentId(1)).not.toBe(sentId(0));
  });

  it('is new for an edit whose text changed after an unconfirmed failure', async () => {
    setStepsMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 503))
      .mockResolvedValueOnce(answer(withStep(PLAN, 's2', { text: 'Check all redirects' })));
    renderSteps();
    const input = await edit('Check the redirects');
    fireEvent.change(input, { target: { value: 'Check every redirect' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await within(input.closest('form')!).findByRole('alert');
    fireEvent.change(editInput(), { target: { value: 'Check all redirects' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setStepsMock).toHaveBeenCalledTimes(2));
    expect(sentOps(0)).toStrictEqual([{ op: 'edit', id: 's2', text: 'Check every redirect' }]);
    expect(sentOps(1)).toStrictEqual([{ op: 'edit', id: 's2', text: 'Check all redirects' }]);
    expect(sentId(1)).not.toBe(sentId(0));
  });

  it('is dropped after an answer, so the same change again is a new one', async () => {
    // The host still has it unticked (another tab unticked it), so the same tick can be pressed again.
    setStepsMock.mockResolvedValue(answer(PLAN));
    const { onChanged } = renderSteps();
    fireEvent.click(box('Check the redirects'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(box('Check the redirects')).toBeEnabled());
    fireEvent.click(box('Check the redirects'));
    await waitFor(() => expect(setStepsMock).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'tick', id: 's2' }]);
    expect(sentId(1)).not.toBe(sentId(0));
  });
});

const FAILURES: Array<[string, () => unknown, string]> = [
  ['a network failure', () => new TypeError('Failed to fetch'), UNCONFIRMED],
  ['no status', () => new WorkspaceApiError('/x', 0), UNCONFIRMED],
  ['a 500', () => new WorkspaceApiError('/x', 500), UNCONFIRMED],
  ['a 408', () => new WorkspaceApiError('/x', 408), UNCONFIRMED],
  ['a 429', () => new WorkspaceApiError('/x', 429), UNCONFIRMED],
  ['an answer it couldn’t read', () => new WorkspaceShapeError('/x'), UNCONFIRMED],
  ['a 404', () => new WorkspaceApiError('/x', 404), NOT_FOUND],
  ['a 403', () => new WorkspaceApiError('/x', 403), NOT_FOUND],
  ['a 400', () => new WorkspaceApiError('/x', 400), AS_WRITTEN],
  ['a 401', () => new WorkspaceApiError('/x', 401), HTTP_SESSION_ENDED],
];

describe('TaskSteps: when a change fails (TASK-949)', () => {
  it.each(FAILURES)(
    'a failed tick (%s) says so under the list, and the box stays as it was',
    async (_label, fail, line) => {
      setStepsMock.mockRejectedValueOnce(fail());
      const { onChanged } = renderSteps();
      fireEvent.click(box('Check the redirects'));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(line);
      expect(screen.getByRole('list').compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(box('Check the redirects')).not.toBeChecked();
      expect(onChanged).not.toHaveBeenCalled();
      // The operator's half goes to the console, tagged.
      expect(warn.mock.calls.some(([first]) => String(first).startsWith('[task-steps] '))).toBe(true);
    },
  );

  it.each(FAILURES)('a failed add (%s) says so in its editor and keeps the text', async (_label, fail, line) => {
    setStepsMock.mockRejectedValueOnce(fail());
    renderSteps();
    fireEvent.click(addStep());
    fireEvent.change(newInput(), { target: { value: 'Update the sitemap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const form = newInput().closest('form')!;
    expect((await within(form).findByRole('alert')).textContent).toBe(line);
    expect(newInput()).toHaveValue('Update the sitemap');
    expect(newInput()).not.toHaveAttribute('aria-invalid');
  });

  it('a failed edit says so in its editor and keeps the text, with focus back in it', async () => {
    const d = deferred<TaskStepsResponse>();
    setStepsMock.mockReturnValueOnce(d.promise);
    renderSteps();
    const input = await edit('Check the redirects');
    fireEvent.change(input, { target: { value: 'Check every redirect' } });
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.click(save);
    dropFocusOnBody();
    await act(async () => d.reject(new WorkspaceApiError('/x', 503)));
    expect(within(input.closest('form')!).getByRole('alert').textContent).toBe(UNCONFIRMED);
    expect(editInput()).toHaveValue('Check every redirect');
    expect(document.activeElement).toBe(editInput());
  });

  it('a failed delete says so under the list, and focus goes back to that step’s options', async () => {
    const d = deferred<TaskStepsResponse>();
    setStepsMock.mockReturnValueOnce(d.promise);
    renderSteps();
    await choose('Tell the team', 'Delete');
    await waitFor(() => expect(setStepsMock).toHaveBeenCalledTimes(1));
    dropFocusOnBody();
    await act(async () => d.reject(new WorkspaceApiError('/x', 503)));
    expect(screen.getByRole('alert').textContent).toBe(UNCONFIRMED);
    expect(box('Tell the team')).toBeInTheDocument();
    expect(document.activeElement).toBe(options('Tell the team'));
  });

  it('an ended session is drawn neutral under the list; any other failure is destructive', async () => {
    setStepsMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 401))
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 404));
    renderSteps();
    fireEvent.click(box('Check the redirects'));
    expect((await screen.findByRole('alert')).className).not.toContain('text-destructive');
    fireEvent.click(box('Check the redirects'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_FOUND));
    expect(screen.getByRole('alert').className).toContain('text-destructive');
  });
});
