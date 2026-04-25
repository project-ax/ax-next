/**
 * LoginPage — unauthenticated landing.
 *
 * Centered Tide-warm card with the brand wordmark, a one-line blurb, and
 * a single "Sign in with Google" CTA. The CTA POSTs to
 * `/api/auth/sign-in/social` and follows the redirect URL the server
 * returns. Mock backend (Task 4) returns `/api/auth/mock/google-callback`,
 * which sets a session cookie and redirects back to `/`.
 *
 * Google-only by design for Week 7 — additional providers (or a local
 * email/password mode) are deferred until earned.
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
          onClick={() => {
            void signInWithGoogle();
          }}
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
