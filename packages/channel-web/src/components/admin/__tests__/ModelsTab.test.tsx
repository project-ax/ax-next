import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toastActions } from '@/lib/toast-store';
import { ModelsTab } from '../ModelsTab';

const OPUS = 'anthropic/claude-opus-4-7';
const SONNET = 'anthropic/claude-sonnet-4-6';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const GROK = 'openrouter/x-ai/grok-4.6';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
let handler: (c: Call) => Response | Promise<Response>;
let showToast: ReturnType<typeof vi.spyOn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const policy = (over: Record<string, unknown> = {}) => ({
  source: 'admin',
  version: 2,
  allowed: [SONNET, KIMI],
  default: SONNET,
  updatedAt: 'T',
  updatedBy: 'u',
  ...over,
});
const catalog = (over: { openrouter?: Record<string, unknown>; anthropic?: Record<string, unknown> } = {}) => ({
  providers: [
    { id: 'anthropic', name: 'Anthropic', status: 'live', fetchedAt: '2026-09-30T12:00:00Z', models: [{ ref: OPUS, label: 'Claude Opus 4.7' }, { ref: SONNET, label: 'Claude Sonnet 4.6' }], ...over.anthropic },
    { id: 'openrouter', name: 'OpenRouter', status: 'live', fetchedAt: '2026-09-30T12:00:00Z', models: [{ ref: KIMI, label: 'Kimi K3' }, { ref: GROK, label: 'xAI: Grok 4.6' }], ...over.openrouter },
  ],
});

let pol = policy();
let cat = catalog();
let impact: Array<{ model: string; agentCount: number }> = [];

function defaultHandler(c: Call): Response {
  if (c.method === 'GET' && c.path.startsWith('/admin/models/policy')) return json(200, pol);
  if (c.method === 'GET' && c.path.startsWith('/admin/models/catalog')) return json(200, cat);
  if (c.method === 'POST' && c.path === '/admin/agents/models/impact') return json(200, { affected: impact });
  if (c.method === 'PUT' && c.path === '/admin/models/policy') {
    const b = c.body as { allowed: string[]; default: string; baseVersion: number };
    return json(200, policy({ version: b.baseVersion + 1, allowed: b.allowed, default: b.default }));
  }
  return json(404, {});
}
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path.startsWith(path));

beforeEach(() => {
  pol = policy();
  cat = catalog();
  impact = [];
  calls = [];
  handler = defaultHandler;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const c: Call = {
        method: init?.method ?? 'GET',
        path: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(c);
      return handler(c);
    }),
  );
  toastActions.reset();
  showToast = vi.spyOn(toastActions, 'show');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function ready() {
  render(<ModelsTab />);
  await screen.findByRole('heading', { name: 'All models' });
}
const save = () => screen.getByRole('button', { name: 'Save changes' });

describe('ModelsTab — loading', () => {
  it('shows both panes with the saved selection and Default', async () => {
    await ready();
    expect(screen.getByRole('heading', { name: 'Available to users (2)' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Make Claude Sonnet 4.6 the Default' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Kimi K3/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ })).not.toBeChecked();
  });

  it('tells the admin they are on the built-in list until they save', async () => {
    pol = policy({ source: 'builtin', version: 0 });
    await ready();
    expect(screen.getByText("You're using the built-in list. Nothing changes until you save.")).toBeInTheDocument();
  });

  it('warns when the saved list could not be read', async () => {
    pol = policy({ source: 'builtin', version: 0, warning: 'saved-policy-unreadable' });
    await ready();
    expect(screen.getByText(/We couldn't read the saved list, so we're using the built-in one for now\./)).toBeInTheDocument();
  });

  it('says what happened and recovers with Try again when the saved list will not load', async () => {
    let n = 0;
    handler = (c) => (c.path.startsWith('/admin/models/policy') && ++n === 1 ? json(500, { error: 'db' }) : defaultHandler(c));
    render(<ModelsTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load the saved list of models.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'All models' });
  });

  it('still shows the saved selection when only the catalog fails', async () => {
    handler = (c) => (c.path.startsWith('/admin/models/catalog') ? json(500, {}) : defaultHandler(c));
    render(<ModelsTab />);
    await screen.findByRole('heading', { name: 'Available to users (2)' });
    expect(screen.getByText("We couldn't load the model list. Your current selection is safe.")).toBeInTheDocument();
  });

  it('Try again on a provider asks for a refreshed catalog', async () => {
    cat = catalog({ openrouter: { status: 'fallback' } });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(callsTo('GET', '/admin/models/catalog?refresh=1')).toHaveLength(1));
  });
});

describe('ModelsTab — saving', () => {
  it('Save is off until something changes, and Cancel puts everything back', async () => {
    await ready();
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    expect(save()).toBeEnabled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(save()).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Available to users (2)' })).toBeInTheDocument();
  });

  it('Save is off when nothing is selected', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claude Sonnet 4.6' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    expect(save()).toBeDisabled();
  });

  it('adding a model saves straight away (no agents to move), with the version it loaded', async () => {
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    fireEvent.click(save());
    await waitFor(() => expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(1));
    const put = callsTo('PUT', '/admin/models/policy')[0]!;
    expect(put.body).toEqual({ baseVersion: 2, allowed: [SONNET, KIMI, OPUS], default: SONNET });
    expect(put.headers['x-requested-with']).toBe('ax-admin');
    expect(callsTo('POST', '/admin/agents/models/impact')).toHaveLength(0);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Models saved' })));
    expect(save()).toBeDisabled(); // now clean, at version 3
  });

  it('removing a model nobody uses saves without a confirmation', async () => {
    impact = [];
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    await waitFor(() => expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(1));
    expect(callsTo('POST', '/admin/agents/models/impact')[0]!.body).toEqual({ remove: [KIMI] });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('removing a model agents use asks first, names the count and the Default, and saves only on confirm', async () => {
    impact = [{ model: KIMI, agentCount: 3 }];
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    const dialog = await screen.findByRole('dialog', { name: 'Move 3 agents to Claude Sonnet 4.6?' });
    expect(within(dialog).getByText('Kimi K3: 3 agents')).toBeInTheDocument();
    expect(within(dialog).getByText(/From their next chat they'll use Claude Sonnet 4\.6 instead\./)).toBeInTheDocument();
    expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
    expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(save());
    fireEvent.click(await screen.findByRole('button', { name: 'Save and move them' }));
    await waitFor(() => expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(1));
  });

  it("uses the singular for one agent", async () => {
    impact = [{ model: KIMI, agentCount: 1 }];
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    expect(await screen.findByRole('dialog', { name: 'Move 1 agent to Claude Sonnet 4.6?' })).toBeInTheDocument();
  });

  it("still confirms, honestly, when the agent count can't be fetched", async () => {
    handler = (c) => (c.path === '/admin/agents/models/impact' ? json(500, {}) : defaultHandler(c));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    const dialog = await screen.findByRole('dialog', { name: 'Some agents may move to Claude Sonnet 4.6' });
    expect(within(dialog).getByText(/We couldn't check which agents use the models you removed\./)).toBeInTheDocument();
  });

  it('reports a conflict with a Reload that brings back the other admin’s version', async () => {
    handler = (c) => (c.method === 'PUT' ? json(409, { error: 'stale-version' }) : defaultHandler(c));
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    fireEvent.click(save());
    expect(await screen.findByText('Someone else just changed this list. Reload to see their version.')).toBeInTheDocument();
    pol = policy({ version: 3, allowed: [KIMI], default: KIMI });
    handler = defaultHandler;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await screen.findByRole('heading', { name: 'Available to users (1)' });
    expect(screen.queryByText(/Someone else just changed/)).toBeNull();
  });

  it('says plainly what went wrong, keeps the draft, and lets the admin try again', async () => {
    handler = (c) => (c.method === 'PUT' ? json(500, { error: 'boom' }) : defaultHandler(c));
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    fireEvent.click(save());
    expect(await screen.findByText("We couldn't save that. Nothing changed. Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ })).toBeChecked();
    expect(save()).toBeEnabled();
  });
});

describe('ModelsTab — unsaved changes', () => {
  it('asks the browser to confirm before leaving the page with unsaved changes', async () => {
    await ready();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('ModelsTab — the keys link', () => {
  it('passes onOpenKeys through to a provider with no key', async () => {
    cat = catalog({ openrouter: { status: 'no-key', models: [] } });
    const onOpenKeys = vi.fn();
    render(<ModelsTab onOpenKeys={onOpenKeys} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open AI model keys' }));
    expect(onOpenKeys).toHaveBeenCalledOnce();
  });
});


describe('ModelsTab — pending save', () => {
  it('keeps the checked removal and Default fixed while counting impact', async () => {
    let finish!: (response: Response) => void;
    handler = (c) => c.path === '/admin/agents/models/impact'
      ? new Promise<Response>((resolve) => { finish = resolve; }) : defaultHandler(c);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    await waitFor(() => expect(callsTo('POST', '/admin/agents/models/impact')).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish(json(200, { affected: [] }));
    await waitFor(() => expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(1));
    expect(callsTo('PUT', '/admin/models/policy')[0]!.body).toMatchObject({ allowed: [SONNET], default: SONNET });
  });
});
