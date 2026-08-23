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
 *
 * THE CTA HAS A FAILURE PATH (TASK-288). It used to be a bare
 * `void signInWithGoogle()` with no `.catch()` at all — so a misconfigured
 * provider, or a host that could not answer, was an unhandled promise
 * rejection and a button that visibly did nothing. This is also the screen a
 * post-boot 401 now lands people on, which makes "the button does nothing" a
 * dead end rather than an annoyance: there is nowhere else to go from here.
 */
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { signInWithGoogle } from '../lib/auth';
import { BrandMark } from './BrandMark';

/*
  What happened, and what to do about it. We cannot tell a misconfigured
  provider from an unreachable host without guessing, and guessing wrong here
  sends someone to the wrong person for help — so the copy names both and
  offers the one action that is always right to try first.
*/
export const SIGN_IN_FAILED =
  'We could not start the sign-in. Please try again — if it keeps happening, the sign-in provider may need attention from whoever set this up.';

export function LoginPage() {
  const [failed, setFailed] = useState(false);

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
            // On success this navigates away, so nothing below it runs. On a
            // misconfigured provider or an unreachable host it throws, and the
            // person stays here — which is exactly when they need to be told.
            setFailed(false);
            void signInWithGoogle().catch((err: unknown) => {
              console.warn('[auth] could not start sign-in', err);
              setFailed(true);
            });
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
        {failed && (
          <Alert variant="destructive" className="text-left">
            <AlertDescription>{SIGN_IN_FAILED}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
