import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ConnectorsTab } from '../ConnectorsTab';
import * as connectorsLib from '@/lib/connectors';
import * as directoryLib from '@/lib/connector-directory';
import { directoryPage } from '@/lib/__tests__/directory-fixtures';
import type { ConnectorSummary } from '@/lib/connectors';

const EXISTING: ConnectorSummary = {
  id: 'my-notion', name: 'My Notion', description: '', usageNote: '', keyMode: 'personal',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};
const SERVICES = 'Services, APIs or command-line tools';
// Two groups ("profiles"), every service in one, tag-only images (so the editor
// pins them). postgres is declared before redis but depends on it, so the start
// order (redis, postgres) is not the file order.
const COMPOSE = [
  'services:',
  '  postgres:', '    image: postgres:16', '    profiles: [e2e]', '    depends_on: [redis]',
  '  redis:', '    image: redis:7', '    profiles: [e2e]',
  '  nginx:', '    image: nginx:1.27', '    profiles: [dev]',
  '',
].join('\n');
const PINNED: Record<string, string> = {
  'redis:7': `docker.io/library/redis@sha256:${'a'.repeat(64)}`,
  'postgres:16': `docker.io/library/postgres@sha256:${'b'.repeat(64)}`,
};

// The chooser opens the editor one task after it closes (see NewConnectorChooser).
// Wait out that task before asserting that nothing opened, or a late open slips past.
const flushTask = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('New connector asks what kind (TASK-1239)', () => {
  beforeEach(() => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([EXISTING]);
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([]);
    vi.spyOn(directoryLib, 'searchDirectory').mockResolvedValue(directoryPage());
  });
  afterEach(() => vi.restoreAllMocks());

  it('an admin adds a services connector from a compose file: picks a group, pins, turns on on-demand, saves', async () => {
    const pin = vi.spyOn(connectorsLib, 'pinImages').mockImplementation(async (images) =>
      images.map((image) => {
        const ref = PINNED[image];
        return ref ? { image, pinned: ref } : { image, error: 'not found' };
      }),
    );
    const create = vi.spyOn(connectorsLib, 'createConnector').mockResolvedValue({
      ...EXISTING, id: 'dev-stack', name: 'Dev stack', capabilities: connectorsLib.emptyCapabilities(),
    });
    render(<ConnectorsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'New connector' }));
    const chooser = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(chooser).getByRole('radio', { name: SERVICES }));
    fireEvent.click(within(chooser).getByRole('button', { name: 'Continue' }));

    const name = await screen.findByLabelText(/service name/i);
    const editor = name.closest('[role="dialog"]') as HTMLElement;
    fireEvent.change(name, { target: { value: 'Dev stack' } });
    fireEvent.change(within(editor).getByLabelText(/paste a docker-compose/i), { target: { value: COMPOSE } });
    fireEvent.click(within(editor).getByRole('button', { name: /add services from this file/i }));
    await within(editor).findByText(/pick a group to bring in services/i);
    fireEvent.click(document.getElementById('connector-compose-profile')!);
    fireEvent.click(await screen.findByRole('option', { name: 'e2e' }));
    await within(editor).findByText(/we locked these to exact versions/i);
    expect([...pin.mock.calls.at(-1)![0]].sort()).toEqual(['postgres:16', 'redis:7']);
    fireEvent.click(within(editor).getByRole('switch', { name: /start only when needed/i }));
    fireEvent.click(within(editor).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [body, base] = create.mock.calls[0]!;
    expect(base).toBe('/admin/connectors');
    expect(body).toMatchObject({ connectorId: 'dev-stack', name: 'Dev stack' });
    expect(body.capabilities.mcpServers).toEqual([]);
    expect(body.capabilities.servicesMode).toBe('on-demand');
    // Only the e2e group (no nginx), pinned, in start order (redis first, though declared second).
    expect(body.capabilities.services?.map((s) => [s.name, s.image])).toEqual([
      ['redis', PINNED['redis:7']],
      ['postgres', PINNED['postgres:16']],
    ]);
    // Saved: the editor closes and the list is read again.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(connectorsLib.listConnectors).toHaveBeenCalledTimes(2));
  });

  it('focus returns to New connector whether the admin cancels the question or the editor after it', async () => {
    render(<ConnectorsTab />);
    const opener = await screen.findByRole('button', { name: 'New connector' });
    // Arrive the way a keyboard user does, then activate.
    opener.focus();
    fireEvent.click(opener);
    const first = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await flushTask();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(opener);
    const chooser = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(chooser).getByRole('radio', { name: SERVICES }));
    fireEvent.click(within(chooser).getByRole('button', { name: 'Continue' }));
    const editor = (await screen.findByLabelText(/service name/i)).closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('the directory’s New connector asks the same question, and Cancel leaves the directory as it was', async () => {
    vi.spyOn(directoryLib, 'searchDirectory').mockResolvedValue(directoryPage({ syncedAt: null }));
    render(<ConnectorsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Find in directory' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New connector' }));
    const chooser = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(chooser).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await flushTask();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('The directory isn’t available yet')).toBeInTheDocument();
  });

  it('Escape closes the question without opening an editor, even with services picked', async () => {
    render(<ConnectorsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'New connector' }));
    const chooser = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(chooser).getByRole('radio', { name: SERVICES }));
    fireEvent.keyDown(chooser, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await flushTask();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText(/service name/i)).toBeNull();
  });

  // The ~200 ms exit animation after Continue. Radix's Presence keeps the chooser
  // mounted until `animationend`, and by then the chooser's controlled `open` is
  // already false, so Radix no longer calls onOpenChange for Escape or an outside
  // click. jsdom has no animations, so we fake the one thing Presence reads: the
  // computed `animationName`, "exit" once the dialog is closed.
  describe('while the chooser is still animating out after Continue', () => {
    let realGetComputedStyle: typeof window.getComputedStyle;
    let hadCssEscape = true;

    beforeEach(() => {
      realGetComputedStyle = window.getComputedStyle;
      window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
        const real = realGetComputedStyle.call(window, el, pseudo);
        const exiting = el.matches('[role=dialog][data-state=closed]');
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'animationName') return exiting ? 'exit' : 'enter';
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }) as typeof window.getComputedStyle;
      // Presence calls CSS.escape on animationend.
      const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
      hadCssEscape = typeof css?.escape === 'function';
      if (!hadCssEscape) {
        (globalThis as { CSS?: unknown }).CSS = { ...(css ?? {}), escape: (s: string) => s };
      }
    });
    afterEach(() => {
      window.getComputedStyle = realGetComputedStyle;
      if (!hadCssEscape) delete (globalThis as { CSS?: { escape?: unknown } }).CSS!.escape;
    });

    async function continueWithServices() {
      render(<ConnectorsTab />);
      fireEvent.click(await screen.findByRole('button', { name: 'New connector' }));
      const chooser = await screen.findByRole('dialog', { name: 'New connector' });
      fireEvent.click(within(chooser).getByRole('radio', { name: SERVICES }));
      fireEvent.click(within(chooser).getByRole('button', { name: 'Continue' }));
      // Still in the document, mid-exit: this is the window the review found.
      await waitFor(() => expect(chooser).toHaveAttribute('data-state', 'closed'));
      expect(chooser.isConnected).toBe(true);
      return chooser;
    }

    async function finishExitAndExpectNoEditor(chooser: HTMLElement) {
      const ended = new Event('animationend', { bubbles: true });
      Object.defineProperty(ended, 'animationName', { value: 'exit' });
      act(() => { chooser.dispatchEvent(ended); });
      await flushTask();
      await flushTask();
      expect(screen.queryByLabelText(/service name/i)).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      // The header button still works: the tab is not stuck "choosing".
      fireEvent.click(screen.getByRole('button', { name: 'New connector' }));
      expect(await screen.findByRole('dialog', { name: 'New connector' })).toBeInTheDocument();
    }

    it('Escape during the exit drops the pending choice, and New connector still works', async () => {
      const chooser = await continueWithServices();
      fireEvent.keyDown(document, { key: 'Escape' });
      await finishExitAndExpectNoEditor(chooser);
    });

    it('a click outside during the exit drops the pending choice, and New connector still works', async () => {
      const chooser = await continueWithServices();
      // Radix arms its outside-click listener one task after the layer mounts.
      await flushTask();
      fireEvent.pointerDown(document.body);
      await finishExitAndExpectNoEditor(chooser);
    });

    it('with no Escape, the exit finishes and the services editor opens', async () => {
      const chooser = await continueWithServices();
      const ended = new Event('animationend', { bubbles: true });
      Object.defineProperty(ended, 'animationName', { value: 'exit' });
      act(() => { chooser.dispatchEvent(ended); });
      expect(await screen.findByLabelText(/service name/i)).toBeInTheDocument();
    });
  });
});
