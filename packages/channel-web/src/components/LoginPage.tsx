/**
 * LoginPage — unauthenticated landing.
 *
 * Centered card with the brand mark, a one-line blurb, and a single
 * "Sign in with Google" CTA. Clicking POSTs `/auth/sign-in/social`
 * (handled by @ax/auth-better) and navigates to the Google authorize
 * URL it returns; Google redirects back via `/auth/callback/google`,
 * which sets the signed session cookie and lands the user back at `/`.
 *
 * Google-only by design for Week 9.5 — additional providers (SAML,
 * passkeys, local email+password) are deferred until earned.
 */
import { signInWithGoogle } from '../lib/auth';
import { BrandMark } from './BrandMark';

export function LoginPage() {
  return (
    <div className="flex items-center justify-center min-h-screen p-6 bg-background">
      <div className="w-full max-w-[360px] flex flex-col items-center gap-3.5 text-center px-8 pt-9 pb-7 rounded-[14px] bg-card border border-border shadow-md">
        <BrandMark size="xl" />
        <p className="text-[13px] tracking-[-0.005em] leading-[1.4] text-muted-foreground mb-1.5">
          Sign in to start chatting
        </p>
        <button
          type="button"
          onClick={() => {
            // Fire-and-forget: signInWithGoogle navigates on success and
            // throws on a misconfigured provider (no inline error surface
            // yet). `void` keeps the onClick handler `() => void`.
            void signInWithGoogle();
          }}
          className="
            w-full px-3.5 py-2.5 rounded-lg cursor-pointer text-center
            bg-primary text-primary-foreground shadow-sm
            text-[13.5px] font-medium tracking-[-0.005em]
            transition-[transform,filter,box-shadow] duration-150
            hover:-translate-y-px hover:brightness-105 hover:shadow-md
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/50 focus-visible:outline-offset-2
          "
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
