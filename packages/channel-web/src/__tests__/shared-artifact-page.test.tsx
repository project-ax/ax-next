/**
 * The share page (/a/<code>, spec §6.1): one artifact, full page, for a
 * signed-in teammate holding its link. The name, who made it and when, the
 * same preview the owner sees, Download — and nothing else: no version
 * picker, no chat, no list. A dead link says so in one plain sentence (§6.6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SharedArtifactPage } from '../components/SharedArtifactPage';

const CODE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123_-';

interface Reply {
  status: number;
  body: unknown;
}
const ok = (body: unknown): Reply => ({ status: 200, body });

function artifact(over: Record<string, unknown> = {}) {
  return {
    artifact: {
      title: 'Q3 pipeline',
      kind: 'web',
      preview: 'html',
      extension: 'html',
      mediaType: 'text/html',
      sizeBytes: 1200,
      updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      agentName: 'Deal Desk',
      ...over,
    },
  };
}

let routes: { view: Reply; text: Reply; token: (purpose: string) => Reply };
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  let r: Reply;
  if (url === `/api/shared/${CODE}`) r = routes.view;
  else if (url === `/api/shared/${CODE}/text`) r = routes.text;
  else if (url === `/api/shared/${CODE}/token`) {
    r = routes.token((JSON.parse(String(init?.body)) as { purpose: string }).purpose);
  } else r = { status: 404, body: { error: 'not-found' } };
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
});

let originalFetch: typeof fetch;
beforeEach(() => {
  routes = {
    view: ok(artifact()),
    text: ok({ text: '# Plan\n\nhello', truncated: false }),
    token: (purpose) =>
      ok({ url: `http://127.0.0.1:9091/${purpose === 'view' ? 'v' : 'd'}/tok`, expiresAt: '2026-11-06T00:05:00Z' }),
  };
  fetchMock.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('SharedArtifactPage', () => {
  it('shows the name, "Made by Deal Desk · updated …", "Made with AI by a teammate", the preview and Download, and no version picker', async () => {
    render(<SharedArtifactPage code={CODE} />);
    expect(await screen.findByRole('heading', { name: 'Q3 pipeline' })).toBeTruthy();
    expect(screen.getByText('Made by Deal Desk · updated 2 hr ago')).toBeTruthy();
    expect(screen.getByText('Made with AI by a teammate')).toBeTruthy();
    const frame = await screen.findByTitle('Q3 pipeline');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('http://127.0.0.1:9091/v/tok');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.getByRole('button', { name: /Download/ })).toBeTruthy();
    // No version picker, no chat, no list, no owner controls.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText(/Copy link|Restore|Rename|Delete/)).toBeNull();
    // The view token is minted through the link, for viewing.
    const tokenCall = fetchMock.mock.calls.find((c) => String(c[0]) === `/api/shared/${CODE}/token`);
    expect(JSON.parse(String(tokenCall?.[1]?.body))).toEqual({ purpose: 'view' });
    expect(tokenCall?.[1]?.method).toBe('POST');
  });

  it('with no agent name, says "an agent"', async () => {
    routes.view = ok(artifact({ agentName: null }));
    render(<SharedArtifactPage code={CODE} />);
    expect(await screen.findByText(/^Made by an agent · updated /)).toBeTruthy();
  });

  it('markdown reads through the link\'s text route', async () => {
    routes.view = ok(artifact({ kind: 'document', preview: 'markdown', extension: 'md', mediaType: 'text/markdown' }));
    render(<SharedArtifactPage code={CODE} />);
    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeTruthy();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(`/api/shared/${CODE}/text`);
  });

  it('Download mints a download token through the link and hands it to the browser', async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.href);
    });
    render(<SharedArtifactPage code={CODE} />);
    fireEvent.click(await screen.findByRole('button', { name: /Download/ }));
    await waitFor(() => expect(clicked).toEqual(['http://127.0.0.1:9091/d/tok']));
    const purposes = fetchMock.mock.calls
      .filter((c) => String(c[0]) === `/api/shared/${CODE}/token`)
      .map((c) => (JSON.parse(String(c[1]?.body)) as { purpose: string }).purpose);
    expect(purposes).toContain('download');
  });

  it('a 404 shows the dead-link sentence; a 429 shows the wait sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    routes.view = { status: 404, body: { error: 'link-not-found' } };
    const r = render(<SharedArtifactPage code={CODE} />);
    expect(
      await screen.findByText("This link doesn't work anymore — ask whoever sent it for a fresh one."),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    r.unmount();

    routes.view = { status: 429, body: { error: 'rate-limited', message: 'slow down' } };
    render(<SharedArtifactPage code={CODE} />);
    expect(await screen.findByText('Too many tries — wait a minute and try again.')).toBeTruthy();

    // The code is a capability: no console line carries it, whole or in part.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain(CODE.slice(0, 8));
  });

  it('a body it cannot read is a failure with Try again, not a crash', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    routes.view = ok({ nope: true });
    render(<SharedArtifactPage code={CODE} />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    routes.view = ok(artifact());
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'Q3 pipeline' })).toBeTruthy();
  });
});
