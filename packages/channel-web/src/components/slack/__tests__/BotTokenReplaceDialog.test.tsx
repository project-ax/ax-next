/**
 * The shared "Replace your Slack token" dialog (TASK-1173). Agent settings and
 * Admin › Slack open it for a team bot's approver. These tests drive it through
 * its props alone: a stand-in request and stand-in error words. So they pin what
 * the dialog itself promises. The pasted token is write-only: out of the field
 * before the request goes, and never on the page or in the console. The dialog
 * closes itself before it calls back. The real words for each refusal are
 * pinned where each surface wires them (`AgentSlackBotChanges.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { BotTokenReplaceDialog } from '../BotTokenReplaceDialog';
import { fakeConfigRefreshToken } from '@/test-utils/fake-slack-tokens';

const TOKEN = fakeConfigRefreshToken('BOTREPLACESECRET');
const FIELD_ERROR = 'The token field turned it away.';
const FORM_ERROR = 'The form turned it away.';
const TITLE = 'Replace your Slack token';

/** A stand-in refusal. Its kind decides what the stand-in error words say. */
class Refusal extends Error {
  readonly kind: 'field' | 'form' | 'stale';

  constructor(kind: 'field' | 'form' | 'stale') {
    super(`refused: ${kind}`);
    this.kind = kind;
  }
}

const errorCopy = (err: unknown): { field: 'refreshToken' | null; message: string } =>
  err instanceof Refusal && err.kind === 'field'
    ? { field: 'refreshToken', message: FIELD_ERROR }
    : { field: null, message: FORM_ERROR };
const isStale = (err: unknown): boolean => err instanceof Refusal && err.kind === 'stale';

const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const;

beforeEach(() => {
  // Spies that still print: the tests read what the page said, and a real warning stays visible.
  for (const method of CONSOLE) vi.spyOn(console, method);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything the page said to the console, as one string. */
function consoleText(): string {
  const said = (a: unknown): string => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      return String(a);
    }
  };
  return CONSOLE.flatMap((method) => vi.mocked(console[method]).mock.calls)
    .map((args) => args.map(said).join(' '))
    .join('\n');
}

/** The token is nowhere a person, a page script or a log reader could find it. */
function expectTokenNowhere() {
  expect(document.body.innerHTML).not.toContain(TOKEN);
  expect(document.body.textContent).not.toContain(TOKEN);
  expect(consoleText()).not.toContain(TOKEN);
}

/**
 * The dialog under a parent that holds `open`, as both surfaces do. `events`
 * records what the dialog told the parent, in order.
 */
function renderDialog() {
  const replace = vi.fn<(refreshToken: string) => Promise<void>>();
  const events: string[] = [];
  const onReplaced = vi.fn(() => events.push('replaced'));
  const onStale = vi.fn(() => events.push('stale'));
  function Parent() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open it
        </button>
        <BotTokenReplaceDialog
          open={open}
          onOpenChange={(next) => {
            events.push(next ? 'opened' : 'closed');
            setOpen(next);
          }}
          botName="Quill Bot"
          replace={replace}
          errorCopy={errorCopy}
          isStale={isStale}
          onReplaced={onReplaced}
          onStale={onStale}
        />
      </>
    );
  }
  render(<Parent />);
  return { replace, events, onReplaced, onStale };
}

function openDialog(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
  return screen.getByRole('dialog', { name: TITLE });
}

function tokenInput(dialog: HTMLElement): HTMLInputElement {
  return within(dialog).getByLabelText('Refresh token') as HTMLInputElement;
}

function pasteAndSubmit(dialog: HTMLElement, value = TOKEN) {
  fireEvent.change(tokenInput(dialog), { target: { value } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
}

describe('BotTokenReplaceDialog', () => {
  it('asks for one refresh token for the bot it names, in words that never name the product', () => {
    renderDialog();
    const dialog = openDialog();
    expect(within(dialog).getByRole('heading', { name: TITLE })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(
      'Do this when the configuration token we have for you stops working. Quill Bot stays in its channels, and nobody has to invite it again.',
    );
    const steps = within(dialog).getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(
      "Open Slack's app settings. Under Your App Configuration Tokens, find this workspace. Slack allows one token per person there, so if one is listed, revoke it, then click Generate Token.",
    );
    expect(within(steps[0]!).getByRole('link', { name: "Slack's app settings" })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps',
    );
    expect(within(steps[0]!).getByText('Your App Configuration Tokens').tagName).toBe('STRONG');
    expect(within(steps[0]!).getByText('Generate Token').tagName).toBe('STRONG');
    expect(steps[1]).toHaveTextContent('Paste its refresh token below. We keep it encrypted, and nobody can read it back.');
    const field = tokenInput(dialog);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('id', 'slack-bot-replace-refresh-token');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).not.toHaveAttribute('value');
    expect(field).toHaveAccessibleDescription('Starts with xoxe-');
    expect(within(dialog).getAllByLabelText(/token/i)).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Replace token' })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
  });

  it('sends the pasted token once, trimmed, after taking it out of the field; then it closes before it says so', async () => {
    const { replace, events, onStale } = renderDialog();
    const dialog = openDialog();
    fireEvent.change(tokenInput(dialog), { target: { value: `  ${TOKEN}  ` } });
    // In the field, but not in the markup: an uncontrolled input has no value attribute to give it away.
    expectTokenNowhere();
    let finish!: () => void;
    let atCall: { field: string; html: string } | null = null;
    replace.mockImplementationOnce(() => {
      atCall = { field: tokenInput(dialog).value, html: document.body.innerHTML };
      return new Promise<void>((resolve) => (finish = resolve));
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(TOKEN);
    expect(atCall).toEqual({ field: '', html: expect.not.stringContaining(TOKEN) });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Replace token' })).toHaveAttribute('aria-busy', 'true'));
    expectTokenNowhere();
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(events).toEqual(['closed', 'replaced']);
    expect(onStale).not.toHaveBeenCalled();
    expectTokenNowhere();
  });

  it('a refusal about the token sits under the field, which is empty and has focus again', async () => {
    const { replace, events } = renderDialog();
    replace.mockRejectedValueOnce(new Refusal('field'));
    const dialog = openDialog();
    within(dialog).getByRole('button', { name: 'Cancel' }).focus();
    pasteAndSubmit(dialog);
    const error = await within(dialog).findByText(FIELD_ERROR);
    expect(error.closest('[data-slot="field-error"]')).not.toBeNull();
    const field = tokenInput(dialog);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(expect.stringContaining(FIELD_ERROR));
    expect(field.value).toBe('');
    await waitFor(() => expect(field).toHaveFocus());
    // The field's own error is the dialog's only alert: no form-level one beside it.
    const alerts = within(dialog).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBe(error);
    expect(within(dialog).queryByText(FORM_ERROR)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Replace token' })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: TITLE })).toBeInTheDocument();
    expect(events).toEqual([]);
    expectTokenNowhere();
  });

  it.each([
    ['a refusal the form answers', new Refusal('form')],
    ['a request that never got an answer', new TypeError('Failed to fetch')],
  ])("%s is the dialog's alert, in errorCopy's words only; the field is empty and has focus again", async (_, err) => {
    const { replace, events } = renderDialog();
    replace.mockRejectedValueOnce(err);
    const dialog = openDialog();
    within(dialog).getByRole('button', { name: 'Cancel' }).focus();
    pasteAndSubmit(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(FORM_ERROR);
    expect(document.body.textContent).not.toContain(err.message);
    const field = tokenInput(dialog);
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(field.value).toBe('');
    await waitFor(() => expect(field).toHaveFocus());
    expect(events).toEqual([]);
    expectTokenNowhere();
  });

  it('a refusal that says the page is out of date closes the dialog, then says so, and shows no error', async () => {
    const { replace, events, onReplaced } = renderDialog();
    replace.mockRejectedValueOnce(new Refusal('stale'));
    pasteAndSubmit(openDialog());
    await waitFor(() => expect(events).toEqual(['closed', 'stale']));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain(FORM_ERROR);
    expect(onReplaced).not.toHaveBeenCalled();
    expectTokenNowhere();
  });

  it("is one request at a time: while Slack answers, the buttons wait, and Escape and the close button don't close it", async () => {
    const { replace, events } = renderDialog();
    let finish!: () => void;
    replace.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const dialog = openDialog();
    pasteAndSubmit(dialog);
    const busy = within(dialog).getByRole('button', { name: 'Replace token' });
    await waitFor(() => expect(busy).toHaveAttribute('aria-busy', 'true'));
    fireEvent.click(busy);
    fireEvent.submit(busy.closest('form')!);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(tokenInput(dialog)).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('dialog', { name: TITLE })).toBeInTheDocument();
    expect(events).toEqual([]);
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(events).toEqual(['closed', 'replaced']);
  });

  it('Cancel sends nothing, and opening it again shows an empty field and no old error', async () => {
    const { replace, events } = renderDialog();
    replace.mockRejectedValueOnce(new Refusal('field'));
    let dialog = openDialog();
    pasteAndSubmit(dialog);
    await within(dialog).findByText(FIELD_ERROR);
    fireEvent.change(tokenInput(dialog), { target: { value: 'half-pasted' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(events).toEqual(['closed']);
    expect(replace).toHaveBeenCalledTimes(1);
    dialog = openDialog();
    expect(tokenInput(dialog).value).toBe('');
    expect(tokenInput(dialog)).not.toHaveAttribute('aria-invalid');
    expect(within(dialog).queryByText(FIELD_ERROR)).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Replace token' })).toBeEnabled();
  });
});
