/**
 * TASK-340 / audit B4, B5, B7, B8, B9 — the first-run dialog and setup wizard.
 *
 * The B4 half is the one that matters most. The first-run "name your agent"
 * dialog already refused to close, but it kept rendering a live-looking ✕, and
 * Radix still fired Escape and outside-click. All three silently did nothing —
 * on the very first interaction a new user has with this product.
 *
 * The fix is to stop OFFERING the exits rather than keep swallowing them, and
 * the test that matters is the pair: the non-dismissible case refuses, and the
 * ordinary case still works. A `hideClose` that quietly broke every other
 * dialog would be a worse bug than the one it fixed.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewAgentDialog } from '../components/onboard/NewAgentDialog';
import { SetupShell, SETUP_UNEXPECTED } from '../components/setup/SetupShell';
import { StepGate } from '../components/setup/StepGate';
import { StepAdmin } from '../components/setup/StepAdmin';

describe('NewAgentDialog — first run offers no exit it will not honour (B4)', () => {
  it('renders no close button when it cannot be dismissed', () => {
    render(
      <NewAgentDialog open dismissible={false} onOpenChange={() => {}} onCreate={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('does not ask to close on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <NewAgentDialog open dismissible={false} onOpenChange={onOpenChange} onCreate={() => {}} />,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('still dismisses normally when it is an ordinary dialog', () => {
    // The control case. `hideClose` must not quietly disarm every other dialog
    // in the product — that would be a worse bug than the one being fixed.
    const onOpenChange = vi.fn();
    render(<NewAgentDialog open onOpenChange={onOpenChange} onCreate={() => {}} />);

    const close = screen.getByRole('button', { name: /close/i });
    expect(close).toBeTruthy();
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says what an agent IS before asking for its name (B5)', () => {
    render(<NewAgentDialog open dismissible={false} onOpenChange={() => {}} onCreate={() => {}} />);
    expect(screen.getByText(/an agent is your personal assistant/i)).toBeTruthy();
    // The first-run-only reassurance: this is the last thing in the way.
    expect(screen.getByText(/the one thing we need before you can chat/i)).toBeTruthy();
  });

  it('drops the first-run line when the dialog is just "+ New agent"', () => {
    render(<NewAgentDialog open onOpenChange={() => {}} onCreate={() => {}} />);
    expect(screen.queryByText(/the one thing we need before you can chat/i)).toBeNull();
  });
});

describe('SetupShell — say how long this is (B5)', () => {
  it('numbers the step it is on', () => {
    render(
      <SetupShell step={2} title="Create your admin account">
        <div />
      </SetupShell>,
    );
    expect(screen.getByTestId('setup-step').textContent).toBe('Step 2 of 3');
  });

  it('numbers nothing on a screen that is not one of the three', () => {
    // StepDone and the first-run agent bootstrap use this shell without being
    // numbered steps; inventing a number for them is worse than showing none.
    render(
      <SetupShell title="You're all set">
        <div />
      </SetupShell>,
    );
    expect(screen.queryByTestId('setup-step')).toBeNull();
  });
});

describe('Wizard errors say something the reader can act on (B7)', () => {
  it('never shows the raw HTTP status when the server fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    render(<StepGate autoToken="ax_bs_token" onClaimed={() => {}} />);

    expect(await screen.findByText(SETUP_UNEXPECTED)).toBeTruthy();
    expect(screen.queryByText(/500/)).toBeNull();
    expect(screen.queryByText(/unexpected \(/i)).toBeNull();
    // The number is not lost — it goes where the one person who can use it looks.
    expect(warn).toHaveBeenCalledWith('[setup] claim failed', 500);

    vi.restoreAllMocks();
  });
});

describe('StepGate names the moment the link was printed (B9)', () => {
  it('points at when ax printed the link, not vaguely at "your terminal"', () => {
    render(<StepGate autoToken={null} onClaimed={() => {}} />);
    expect(screen.getByText(/we printed when you started ax/i)).toBeTruthy();
    expect(screen.getByTestId('setup-step').textContent).toBe('Step 1 of 3');
  });
});

/**
 * Found by WALKING the wizard against the kind cluster, not by reading it.
 *
 * TASK-340 dropped the raw HTTP status from these screens and explicitly left
 * the 400-body branch alone as out of scope. Driving the real server showed
 * that branch renders the error CODE verbatim: typing an address with no TLD
 * put the word "invalid-email" in front of a first-run user. Same defect as
 * B7, one layer down.
 */
describe('StepAdmin rejections read as sentences, not codes', () => {
  const submit = async (name: string, email: string) => {
    render(<StepAdmin onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  };

  const reject = (code: string) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: code }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('explains a rejected email instead of printing "invalid-email"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reject('invalid-email');

    await submit('Walk Admin', 'walk@local');

    expect(
      await screen.findByText(/that email address doesn’t look right/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('invalid-email')).toBeNull();
    // The code is not lost — it goes where a developer will look.
    expect(warn).toHaveBeenCalledWith('[setup] admin create rejected', 'invalid-email');
    vi.restoreAllMocks();
  });

  it('falls back to a sentence for a code it does not know', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reject('some-new-code-we-have-never-seen');

    await submit('Walk Admin', 'walk@example.com');

    expect(await screen.findByText(/check the details above/i)).toBeInTheDocument();
    expect(screen.queryByText(/some-new-code/)).toBeNull();
    vi.restoreAllMocks();
  });

  it('survives a rejection code that names an Object.prototype member', async () => {
    // The lookup key is server-controlled. On a plain-object table,
    // `constructor` resolves through the prototype and returns a FUNCTION,
    // which React throws on — taking out the screen whose whole job at that
    // moment is to report an error. Same class of bug the security checklist
    // caught in `lib/humanize.ts` (#520).
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reject('constructor');

    await submit('Walk Admin', 'walk@example.com');

    expect(await screen.findByText(/check the details above/i)).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('StepAdmin promises no mechanism it may not keep (B8)', () => {
  it('says what the email is for, without committing to how sign-in works', () => {
    render(<StepAdmin onCreated={() => {}} />);
    expect(screen.getByText(/you're the first person here/i)).toBeTruthy();
    // Audit open question 2 (can an email-created admin lock themselves out of
    // a Google-only sign-in?) stays open, so the copy must stay true either way.
    expect(screen.queryByText(/no password needed/i)).toBeNull();
    expect(screen.queryByText(/remember this browser/i)).toBeNull();
    expect(screen.queryByText(/other authentication methods/i)).toBeNull();
  });
});
