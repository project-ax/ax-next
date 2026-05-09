/**
 * Wire client for `GET /admin/bootstrap-status` (registered by
 * @ax/onboarding). Public read-only status echo so the SPA can decide
 * whether to render the chat shell or the setup wizard without trapping
 * a fresh-install user on a sign-in screen they can't satisfy.
 *
 * On any fetch error or non-2xx response we default to 'completed' —
 * if we can't reach the endpoint, the safer fallback is "act normal"
 * (chat shell + auth check) rather than trap the user in a redirect
 * loop to /setup.
 */
export type BootstrapStatus = 'pending' | 'claimed' | 'completed' | 'uninitialized';

export async function fetchBootstrapStatus(): Promise<BootstrapStatus> {
  try {
    const r = await fetch('/admin/bootstrap-status', { credentials: 'include' });
    if (!r.ok) return 'completed';
    const body = (await r.json()) as { status?: BootstrapStatus };
    if (
      body.status === 'pending' ||
      body.status === 'claimed' ||
      body.status === 'completed' ||
      body.status === 'uninitialized'
    ) {
      return body.status;
    }
    return 'completed';
  } catch {
    return 'completed';
  }
}
