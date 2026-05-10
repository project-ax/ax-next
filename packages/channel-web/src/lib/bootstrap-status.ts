/**
 * Wire client for `GET /admin/bootstrap-status` (registered by
 * @ax/onboarding). Public read-only status echo so the SPA can decide
 * whether to render the chat shell or the setup wizard without trapping
 * a fresh-install user on a sign-in screen they can't satisfy.
 *
 * On any fetch error, timeout, or non-2xx response we default to
 * 'completed' — if we can't reach the endpoint, the safer fallback is
 * "act normal" (chat shell + auth check) rather than trap the user in
 * a redirect loop to /setup. We log every fallback so an operator
 * debugging boot can see why the SPA didn't redirect.
 */
export type BootstrapStatus = 'pending' | 'claimed' | 'completed' | 'uninitialized';

const FETCH_TIMEOUT_MS = 5_000;

export async function fetchBootstrapStatus(): Promise<BootstrapStatus> {
  // AbortSignal.timeout() isn't universally available across the older end
  // of the evergreen-browser matrix yet; pair AbortController with a manual
  // setTimeout for compatibility.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch('/admin/bootstrap-status', {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!r.ok) {
      console.warn('[bootstrap-status] non-2xx, defaulting to completed', r.status);
      return 'completed';
    }
    const body = (await r.json()) as { status?: BootstrapStatus };
    if (
      body.status === 'pending' ||
      body.status === 'claimed' ||
      body.status === 'completed' ||
      body.status === 'uninitialized'
    ) {
      return body.status;
    }
    console.warn('[bootstrap-status] invalid status field, defaulting to completed', body);
    return 'completed';
  } catch (err) {
    console.warn('[bootstrap-status] fetch failed, defaulting to completed', err);
    return 'completed';
  } finally {
    clearTimeout(timeoutId);
  }
}
