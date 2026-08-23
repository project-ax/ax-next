/**
 * TASK-288 — a 401 after boot ends the session, and nothing renders a status.
 *
 * Before this, `getSession()` was called exactly once, ever, and no interceptor
 * existed anywhere: a session that expired while the tab was open stayed open,
 * and the expiry surfaced as `chat-flow POST failed: 401 Unauthorized` on the
 * banner above the composer, `workspace /board → 401` on the workspace, and
 * `list agents: 401` in the sidebar.
 *
 * NOTE ON WHAT THIS FILE DOES *NOT* TEST. Boot is unchanged and stays that way:
 * `auth-gate.test.tsx` pins it, including the deliberate rule that ANY thrown
 * boot failure — even being offline — lands on `<LoginPage />`. The asymmetry
 * is the design (see `lib/http.ts`), so the one boot-adjacent thing asserted
 * here is the other half of it: post-boot, a NON-401 failure must not sign
 * anybody out.
 *
 * NOTE ON WHAT IS NEVER ASSERTED HERE. No test in this file may assert the
 * literal string `401 Unauthorized`. `statusText` is the HTTP/1.1
 * reason-phrase and HTTP/2 does not have one, so on the real cluster the same
 * code path produces `401 ` with a trailing space. A test pinning the jsdom
 * spelling would pass forever and mean nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { FirstRunAutoCreate } from '../components/onboard/FirstRunAutoCreate';
import { autoCreateBareAgent } from '../lib/auto-create-agent';
import { LoginPage, SIGN_IN_FAILED } from '../components/LoginPage';
import {
  HTTP_FAILED,
  HTTP_SERVER_ERROR,
  HTTP_SESSION_ENDED,
  HttpError,
  httpErrorMessage,
  httpFetch,
} from '../lib/http';
import {
  getSessionExpired,
  sessionExpiredActions,
  useSessionExpired,
} from '../lib/session-expired-store';

vi.mock('../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth')>();
  return { ...actual, signInWithGoogle: vi.fn() };
});
const { signInWithGoogle } = await import('../lib/auth');
const signInMock = vi.mocked(signInWithGoogle);

function res(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let originalLocation: Location;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalLocation = window.location;
  sessionExpiredActions.reset();
  signInMock.mockReset();
  signInMock.mockResolvedValue(undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
  sessionExpiredActions.reset();
  warn.mockRestore();
  vi.restoreAllMocks();
});

describe('lib/http — the 401 latch', () => {
  it('latches on a 401 response', async () => {
    expect(getSessionExpired()).toBe(false);
    await httpFetch('/api/chat/agents', undefined, async () => res(401));
    expect(getSessionExpired()).toBe(true);
  });

  /*
    The counterpart to the boot rule, and the reason this is a 401-only rule
    rather than "any failure". A 500 or a 503 says nothing about whether this
    person is signed in, and signing someone out over a blip loses their draft
    for no reason.
  */
  it.each([403, 404, 500, 502, 503])(
    'does not latch on a %i',
    async (status) => {
      await httpFetch('/api/chat/agents', undefined, async () => res(status));
      expect(getSessionExpired()).toBe(false);
    },
  );

  /*
    The undo poll re-reads a row once per second while an undo window is open,
    so on a dead session this fires ~60 times a minute. It must be free after
    the first one, or a background timer re-renders the whole app on a tick.
  */
  it('notifies subscribers only on the first 401', async () => {
    const seen = vi.fn();
    render(<Latch onRender={seen} />);
    const before = seen.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      await httpFetch('/api/workspace/decisions/d1', undefined, async () =>
        res(401),
      );
    }
    await waitFor(() => expect(getSessionExpired()).toBe(true));
    // One re-render for the transition, and no more for the repeats.
    expect(seen.mock.calls.length).toBe(before + 1);
  });

  it('sends the auth cookie without every caller remembering to', async () => {
    let seenInit: RequestInit | undefined;
    await httpFetch('/api/chat/agents', undefined, async (_u, init) => {
      seenInit = init;
      return res(200);
    });
    expect(seenInit?.credentials).toBe('include');
  });
});

describe('lib/http — what a failed request is allowed to say', () => {
  /*
    The whole bug in one assertion. Nine surfaces rendered a thrown message
    verbatim, so the messages themselves have to be safe — a rule at the render
    site is a rule forty other render sites do not know about.
  */
  it.each([401, 403, 404, 500, 503])(
    'never puts the status, the path or a reason-phrase in the message (%i)',
    (status) => {
      const err = new HttpError('/api/workspace/agents/ag_x', status);
      expect(err.message).not.toMatch(/\d/);
      expect(err.message).not.toMatch(/ag_x|\/api|→|Unauthorized|Forbidden/);
      // …and it is a sentence, not a fragment glued into someone else's.
      expect(err.message).toMatch(/^[A-Z].*\.$/s);
    },
  );

  it('keeps the raw form for the console, off the message', () => {
    const err = new HttpError('/api/workspace/board', 401);
    expect(err.detail).toBe('/api/workspace/board → 401');
    expect(err.message).toBe(HTTP_SESSION_ENDED);
  });

  it('still lets a caller tell 503 from 500', () => {
    expect(httpErrorMessage(503)).not.toBe(httpErrorMessage(500));
    expect(new HttpError('/p', 503).status).toBe(503);
  });

  it('falls back to the generic sentence for a status it has no words for', () => {
    expect(httpErrorMessage(418)).toBe(HTTP_FAILED);
  });

  /*
    A 500 means the server WAS reached and broke. Telling someone we could not
    reach it sends them to check their wifi over a bug on our side.
  */
  it.each([500, 502, 504])('does not blame the network for a %i', (status) => {
    expect(httpErrorMessage(status)).toBe(HTTP_SERVER_ERROR);
    expect(httpErrorMessage(status)).not.toBe(HTTP_FAILED);
  });

  it('keeps 503 distinct from the rest of the 5xx band', () => {
    // "no workspace backend in this deployment" is not "the server broke",
    // and `workspace-files.ts` branches on exactly that difference.
    expect(httpErrorMessage(503)).not.toBe(HTTP_SERVER_ERROR);
  });
});

describe('App — a post-boot 401 returns to the sign-in page', () => {
  function boot(handlers: {
    adminMe?: () => Promise<Response>;
    fallback?: () => Promise<Response>;
  }): void {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, pathname: '/', search: '', replace: vi.fn() },
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/admin/bootstrap-status')) {
        return res(200, { status: 'completed' });
      }
      if (url.includes('/admin/me')) {
        return handlers.adminMe
          ? await handlers.adminMe()
          : res(200, {
              user: {
                id: 'u1',
                email: 'alice@local',
                displayName: 'Alice',
                isAdmin: false,
              },
            });
      }
      return handlers.fallback ? await handlers.fallback() : res(200, { agents: [] });
    }) as unknown as typeof fetch;
  }

  it('swaps a signed-in app for LoginPage when a later request 401s', async () => {
    boot({});
    const { container } = render(<App />);
    // Signed in first — otherwise this proves nothing about POST-boot.
    await waitFor(() =>
      expect(container.querySelector('aside[data-testid="sidebar"]')).toBeTruthy(),
    );

    await httpFetch('/api/chat/agents', undefined, async () => res(401));

    await waitFor(() => expect(screen.getByText(/Sign in with Google/i)).toBeTruthy());
    expect(container.querySelector('aside[data-testid="sidebar"]')).toBeNull();
  });

  /*
    The post-boot half of the deliberate asymmetry. Boot signs you out when it
    cannot reach the server; once you are in, it must not — a 500 on one read
    is a blip on one surface, and throwing the whole session away over it would
    lose an unsent draft to a server hiccup.
  */
  it('leaves a signed-in app alone when a later request fails with a 500', async () => {
    boot({});
    const { container } = render(<App />);
    await waitFor(() =>
      expect(container.querySelector('aside[data-testid="sidebar"]')).toBeTruthy(),
    );

    await httpFetch('/api/chat/agents', undefined, async () => res(500));

    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('aside[data-testid="sidebar"]')).toBeTruthy();
    expect(screen.queryByText(/Sign in with Google/i)).toBeNull();
  });
});

describe('LoginPage — the sign-in button has a failure path', () => {
  /*
    It had none at all: a bare `void signInWithGoogle()` with no `.catch()`, so
    a misconfigured provider was an unhandled rejection and a button that did
    nothing. That is a dead end on the one screen with nowhere else to go —
    and post-boot 401s now send people here.
  */
  it('says so when sign-in cannot start', async () => {
    signInMock.mockRejectedValue(new Error('no provider configured'));
    render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));
    expect(await screen.findByText(SIGN_IN_FAILED)).toBeTruthy();
  });

  it('says nothing until something actually fails', () => {
    render(<LoginPage />);
    expect(screen.queryByText(SIGN_IN_FAILED)).toBeNull();
  });

  it('clears a previous failure when the person tries again', async () => {
    signInMock.mockRejectedValueOnce(new Error('flake'));
    render(<LoginPage />);
    const btn = screen.getByRole('button', { name: /sign in with google/i });
    fireEvent.click(btn);
    expect(await screen.findByText(SIGN_IN_FAILED)).toBeTruthy();

    signInMock.mockResolvedValueOnce(undefined);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByText(SIGN_IN_FAILED)).toBeNull());
  });
});

/*
  The second half of the fix, and the one with a user-visible wrong answer if
  the ordering is off.

  `FirstRunAutoCreate` catches a failed bootstrap and offers
  "give it another go". On a dead session that retry can never work — every
  attempt returns the same 401 — so it is a button that lies. The latch fires
  inside `httpFetch`, on the response, BEFORE `autoCreateBareAgent` throws and
  therefore before that catch runs, so `App` has already swapped to
  `<LoginPage />` by the time the retry copy would render.

  The harness below is `App`'s own ordering (`App.tsx:208-210`: the
  `sessionExpired` check sits above `<AppContent />`, which is what mounts
  `FirstRunAutoCreate`), reproduced around the real component so the assertion
  is about the components and not about a mock of them.
*/
describe('first-run agent create on a dead session', () => {
  function Gate({ children }: { children: React.ReactNode }) {
    return useSessionExpired() ? <LoginPage /> : <>{children}</>;
  }

  it('throws with the status and latches, rather than reporting a retryable blip', async () => {
    globalThis.fetch = (async () => res(401)) as unknown as typeof fetch;
    await expect(autoCreateBareAgent('Scout')).rejects.toMatchObject({
      status: 401,
    });
    expect(getSessionExpired()).toBe(true);
  });

  it('lands on the sign-in page instead of offering a retry that cannot work', async () => {
    globalThis.fetch = (async () => res(401)) as unknown as typeof fetch;
    render(
      <Gate>
        <FirstRunAutoCreate agentName="Scout" onDone={() => undefined} />
      </Gate>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Sign in with Google/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/give it another go/i)).toBeNull();
  });

  /*
    …and the retry copy is still right for a failure that IS retryable, which
    is the half a latch-everything rule would have broken.
  */
  it('still offers the retry when the bootstrap fails for a reason retrying could fix', async () => {
    globalThis.fetch = (async () => res(500)) as unknown as typeof fetch;
    render(
      <Gate>
        <FirstRunAutoCreate agentName="Scout" onDone={() => undefined} />
      </Gate>,
    );
    expect(await screen.findByText(/give it another go/i)).toBeTruthy();
    expect(screen.queryByText(/Sign in with Google/i)).toBeNull();
  });
});

/** Counts renders driven by the latch, and nothing else. */
function Latch({ onRender }: { onRender: () => void }) {
  const expired = useSessionExpired();
  onRender();
  return <span>{String(expired)}</span>;
}
