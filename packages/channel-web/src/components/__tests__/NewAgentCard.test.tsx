/**
 * TASK-689 — `NewAgentCard`: the name step of both "make an agent" flows.
 *
 * It replaced `NewAgentDialog`. The old component was a modal, and on first run
 * it was a modal over an empty page: no product name, no welcome, and a card
 * that looked nothing like the login card before it or the "Setting up your
 * agent…" card after it. It is a `SetupShell` card now — which is also honest,
 * because `App.tsx`'s gate REPLACES the workspace while it is up (TASK-510), so
 * there was never an app behind it for a dialog to sit on top of.
 *
 * Each test says what it does against the OLD component, because a test that
 * passes either way is not a guard.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewAgentCard } from '../onboard/NewAgentCard';

const nameField = () => screen.getByLabelText(/agent name/i);
const createButton = () => screen.getByRole('button', { name: /create agent/i });

describe('NewAgentCard — first run', () => {
  it('welcomes the person and names the product', () => {
    // OLD: title was "Name your agent" and no product name appeared at all.
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} />);
    expect(screen.getByText('Welcome to ax')).toBeTruthy();
    expect(
      screen.getByText("First, let's create your personal AI assistant."),
    ).toBeTruthy();
  });

  it('keeps a real page heading now that the dialog title is gone', () => {
    // OLD: `DialogTitle` was an <h2> and named the dialog. A card whose title is
    // a bare <div> would have been an accessibility regression on the first
    // screen anyone sees.
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Welcome to ax' })).toBeTruthy();
  });

  it('is not a dialog — there is no app behind it to be a dialog over', () => {
    // OLD: rendered `role="dialog"` (Radix).
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers no way out: no Cancel, no close button', () => {
    // OLD: no Cancel either, but only because the ✕ was hidden by `hideClose`.
    // Pinned as the pair with the add-mode test below, which DOES have one.
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('does not react to Escape', () => {
    // OLD: passed (Radix's Escape went to a no-op onOpenChange). The point is
    // that the card must not GROW an Escape handler in first-run mode: the
    // only exit from first run is making an agent.
    const onCancel = vi.fn();
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('NewAgentCard — adding another agent', () => {
  it('says this is a new agent, not a first one', () => {
    // OLD: same "Name your agent" + "An agent is your personal assistant in ax"
    // for someone who already has agents.
    render(<NewAgentCard mode="add" onCreate={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('New agent')).toBeTruthy();
    expect(
      screen.getByText("Give it a name. It'll introduce itself in a moment."),
    ).toBeTruthy();
    expect(screen.queryByText(/welcome to ax/i)).toBeNull();
    expect(screen.queryByText(/first,? let's create/i)).toBeNull();
  });

  it('has a Cancel that calls onCancel', () => {
    // OLD: a ✕ (Radix close) instead of a labelled Cancel.
    const onCancel = vi.fn();
    render(<NewAgentCard mode="add" onCreate={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape, wherever focus is', () => {
    // OLD: Radix handled Escape. The card is not a Radix dialog any more, so
    // this is a listener of its own — parity with what people already do.
    const onCancel = vi.fn();
    render(<NewAgentCard mode="add" onCreate={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(nameField(), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('stops listening for Escape once it unmounts', () => {
    // OLD: n/a. A leaked document listener would cancel a flow that is gone.
    const onCancel = vi.fn();
    const { unmount } = render(
      <NewAgentCard mode="add" onCreate={vi.fn()} onCancel={onCancel} />,
    );
    unmount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('NewAgentCard — the name field', () => {
  it('labels the field, hints at a name rather than a job, and says it can change', () => {
    // OLD: placeholder "e.g. Research assistant" (a job title) and no promise
    // that the name is not forever.
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} />);
    const input = nameField() as HTMLInputElement;
    expect(input.placeholder).toBe('e.g. Juniper');
    expect(screen.getByText('You can change it later.')).toBeTruthy();
  });

  it('focuses the field on open', () => {
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} />);
    expect(document.activeElement).toBe(nameField());
  });

  it('starts with Create disabled, and stays disabled for whitespace', () => {
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} />);
    expect(createButton()).toBeDisabled();
    fireEvent.change(nameField(), { target: { value: '    ' } });
    expect(createButton()).toBeDisabled();
  });

  it('enables Create once there is a name', () => {
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} />);
    fireEvent.change(nameField(), { target: { value: 'Juniper' } });
    expect(createButton()).not.toBeDisabled();
  });

  it('creates with the TRIMMED name on click', () => {
    const onCreate = vi.fn();
    render(<NewAgentCard mode="first-run" onCreate={onCreate} />);
    fireEvent.change(nameField(), { target: { value: '  Juniper  ' } });
    fireEvent.click(createButton());
    expect(onCreate).toHaveBeenCalledExactlyOnceWith('Juniper');
  });

  it('submits on Enter through the form, once', () => {
    // OLD: a keydown handler on the input, which never fired for an IME
    // composition-commit Enter and duplicated what a <form> does natively.
    const onCreate = vi.fn();
    render(<NewAgentCard mode="first-run" onCreate={onCreate} />);
    fireEvent.change(nameField(), { target: { value: 'Juniper' } });
    fireEvent.submit(nameField().closest('form') as HTMLFormElement);
    expect(onCreate).toHaveBeenCalledExactlyOnceWith('Juniper');
  });

  it('does not submit a blank name, even by submitting the form directly', () => {
    const onCreate = vi.fn();
    render(<NewAgentCard mode="first-run" onCreate={onCreate} />);
    fireEvent.submit(nameField().closest('form') as HTMLFormElement);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('caps the name at 128 characters', () => {
    // The route's contract (routes-agent-bootstrap.ts: 1-128). The input stops
    // typing there, and a longer value that got in some other way (paste in a
    // browser that ignores maxLength, an initialName) is still refused.
    const onCreate = vi.fn();
    render(<NewAgentCard mode="first-run" onCreate={onCreate} />);
    expect((nameField() as HTMLInputElement).maxLength).toBe(128);
    fireEvent.change(nameField(), { target: { value: 'x'.repeat(129) } });
    expect(createButton()).toBeDisabled();
    fireEvent.submit(nameField().closest('form') as HTMLFormElement);
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(nameField(), { target: { value: 'x'.repeat(128) } });
    expect(createButton()).not.toBeDisabled();
  });

  it('is prefilled from initialName, so "Change name" does not lose what was typed', () => {
    // OLD: no such prop; the field always opened empty.
    render(<NewAgentCard mode="first-run" onCreate={vi.fn()} initialName="Juniper" />);
    expect((nameField() as HTMLInputElement).value).toBe('Juniper');
    expect(createButton()).not.toBeDisabled();
  });
});
