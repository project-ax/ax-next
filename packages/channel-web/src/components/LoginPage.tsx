/**
 * LoginPage — unauthenticated landing.
 *
 * Centered Tide-warm card with the brand wordmark, a one-line blurb, and
 * a single "Sign in with Google" CTA. Clicking navigates to
 * `/auth/sign-in/google` (handled by @ax/auth-oidc); the server
 * 302-redirects to Google, then back via `/auth/callback/google` which
 * sets the signed session cookie and lands the user back at `/`.
 *
 * Google-only by design for Week 9.5 — additional providers (SAML,
 * passkeys, local email+password) are deferred until earned.
 */
import { signInWithGoogle } from '../lib/auth';

export function LoginPage() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">tide</div>
        <p className="login-blurb">Sign in to start chatting</p>
        <button
          className="login-cta"
          type="button"
          onClick={signInWithGoogle}
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
