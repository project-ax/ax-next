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
import { Button } from '@/components/ui/button';
import { HTTP_SESSION_ENDED } from '../lib/http';
import { signInWithGoogle } from '../lib/auth';
import { BrandMark } from './BrandMark';

/*
  What happened, and what to do about it. We cannot tell a misconfigured
  provider from an unreachable host without guessing, and guessing wrong here
  sends someone to the wrong person for help — so the copy names both and
  offers the one action that is always right to try first.

  (TASK-339 / audit B2) The ORDER is the fix. This said "the sign-in provider
  may need attention from whoever set this up" before it said "try again",
  which points at the operator first for what is, in the overwhelming majority
  of cases, the reader's own connection. It now leads with the thing they can
  check themselves, and keeps the operator as the fallback it should be.
*/
export const SIGN_IN_FAILED =
  'We couldn’t start sign-in. Check your connection and try again. If it keeps happening, the sign-in setup may need a look from whoever installed ax.';

export function LoginPage({ sessionExpired = false }: { sessionExpired?: boolean } = {}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex items-center justify-center min-h-screen p-6 bg-background">
      <div className="w-full max-w-[360px] flex flex-col items-center gap-3.5 text-center px-8 pt-9 pb-7 rounded-[14px] bg-card border border-border shadow-md">
        <BrandMark size="xl" />
        <p className="text-[13px] tracking-[-0.005em] leading-[1.4] text-muted-foreground mb-1.5">
          Sign in to start chatting
        </p>
        {/* (B1) A session that ends mid-use swaps the whole app for this
            screen. Landing on a bare sign-in page with no explanation reads as
            "something broke and threw me out" — so say what happened. Not
            `destructive`: nothing went wrong, and colouring it red would make a
            routine, protective event look like a failure. The sentence is the
            shared `HTTP_SESSION_ENDED`, which `SignInAgainButton` already shows
            inline for the same event — one sentence for one thing. */}
        {sessionExpired && (
          <Alert className="text-left" data-testid="session-expired">
            <AlertDescription>{HTTP_SESSION_ENDED}</AlertDescription>
          </Alert>
        )}
        {/* (B3) This was a hand-rolled `<button>` with bespoke hover-translate,
            brightness and shadow — invariant 6, on the first button anyone ever
            touches in this product. */}
        <Button
          className="w-full"
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
        >
          Sign in with Google
        </Button>
        {failed && (
          <Alert variant="destructive" className="text-left">
            <AlertDescription>{SIGN_IN_FAILED}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
