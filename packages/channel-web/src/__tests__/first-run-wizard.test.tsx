/**
 * TASK-340 / audit B4, B5, B7, B8, B9 — the first-run name step and setup wizard.
 *
 * The B4 half is the one that matters most. The first-run "name your agent"
 * step already refused to close, but it was a dialog that kept rendering a
 * live-looking ✕, and Radix still fired Escape and outside-click. All three
 * silently did nothing — on the very first interaction a new user has with this
 * product.
 *
 * The fix was to stop OFFERING the exits rather than keep swallowing them, and
 * the test that matters is the pair: first run refuses, and the ordinary
 * ("+ New agent") case still works. TASK-689 turned the dialog into a
 * `SetupShell` card (`NewAgentCard`), so the pair is now "no Cancel, no Escape
 * listener" against "a real Cancel and a real Escape" — same principle, and a
 * card that quietly lost the add-mode exit would be as bad as a ✕ that lied.
 * (The card's own behaviour is pinned in `components/__tests__/NewAgentCard`.)
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewAgentCard } from '../components/onboard/NewAgentCard';
import { SetupShell, SETUP_UNEXPECTED } from '../components/setup/SetupShell';
import { StepGate } from '../components/setup/StepGate';
import { StepAdmin } from '../components/setup/StepAdmin';
import { StepDone } from '../components/setup/StepDone';

describe('NewAgentCard — first run offers no exit it will not honour (B4)', () => {
  it('renders no Cancel and no close button', () => {
    render(<NewAgentCard mode="first-run" onCreate={() => {}} />);
    expect(screen.queryByRole('button', { name: /cancel|close/i })).toBeNull();
  });

  it('does not ask to go back on Escape', () => {
    const onCancel = vi.fn();
    render(<NewAgentCard mode="first-run" onCancel={onCancel} onCreate={() => {}} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('still lets you go back when it is just "+ New agent"', () => {
    // The control case. Removing the first-run exit must not quietly remove
    // the add-mode one — that would trap someone who only wanted to look.
    const onCancel = vi.fn();
    render(<NewAgentCard mode="add" onCancel={onCancel} onCreate={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('says what this step is for before asking for a name (B5)', () => {
    // B5 was "Name your agent" assuming the reader knows what an agent is.
    // The answer used to be a definition plus a reassurance; the welcome card
    // says it in one line and leads with the product name.
    render(<NewAgentCard mode="first-run" onCreate={() => {}} />);
    expect(screen.getByText('Welcome to ax')).toBeTruthy();
    expect(
      screen.getByText("First, let's create your personal AI assistant."),
    ).toBeTruthy();
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

  it('names the page with a real heading (TASK-689)', () => {
    // `CardTitle` is a plain <div>, so this screen had no heading at all — a
    // screen-reader user landed on a page with nothing to say what it was. It
    // mattered more once the first-run name step moved here from a dialog,
    // whose title was an <h2> and named the dialog.
    render(
      <SetupShell title="Create your admin account">
        <div />
      </SetupShell>,
    );
    expect(
      screen.getByRole('heading', { name: 'Create your admin account', level: 1 }),
    ).toBeTruthy();
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

describe('StepDone sends the new admin to the workspace (TASK-360)', () => {
  it('links straight to /, not to the retired /chat redirect', () => {
    render(<StepDone />);
    const link = screen.getByRole('link', { name: /open your workspace/i });
    // Exactly `/`: `/chat` still works, but only as a redirect, and a link
    // that points at a redirect is a link nobody updated.
    expect(link.getAttribute('href')).toBe('/');
    expect(screen.getByText(/your workspace is ready/i)).toBeTruthy();
    expect(screen.queryByText(/chat/i)).toBeNull();
  });
});
