/**
 * "Sign in" — the button offered beside an expired-session notice.
 *
 * WHY IT IS A COMPONENT AND NOT A `<Button onClick={…}>` (TASK-288).
 * Two surfaces render this exact offer (`TodayView`, `InThreadApprovals`) and
 * both used to do the same thing with the failure: `.catch(console.warn)`. So
 * a person told "your session ended, sign in" could press the one button on
 * the screen, have it fail, and get nothing back at all — on a surface whose
 * entire purpose is to tell them a true thing about their own session. Owning
 * the failure in one place means neither surface can forget it again.
 *
 * On success `signInWithGoogle()` navigates away, so nothing after it runs.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { signInWithGoogle } from '@/lib/auth';
import { SIGN_IN_FAILED } from './LoginPage';

export function SignInAgainButton({
  variant = 'outline',
}: {
  variant?: 'outline' | 'secondary';
}) {
  const [failed, setFailed] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        onClick={() => {
          setFailed(false);
          void signInWithGoogle().catch((err: unknown) => {
            // The operator still gets the cause; the reader gets a sentence.
            console.warn('[auth] could not start sign-in', err);
            setFailed(true);
          });
        }}
      >
        Sign in
      </Button>
      {failed && (
        <span className="text-[12.5px] leading-relaxed text-muted-foreground">
          {SIGN_IN_FAILED}
        </span>
      )}
    </>
  );
}
