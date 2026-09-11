import type { ReactNode } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { BrandMark } from '../BrandMark';

/** How many numbered steps the setup wizard has: gate → admin → model. */
export const SETUP_TOTAL_STEPS = 3;

/**
 * (TASK-340 / audit B7) What a wizard step says when the server failed in a way
 * we have nothing specific to say about.
 *
 * Every step ended its `if/else` chain with `Unexpected (${r.status})`. "500"
 * is not information to the person setting up a server for the first time — it
 * is a number they cannot act on, in a sentence that reads like the software
 * gave up. The status goes to the console, where the one person who can use it
 * will look.
 */
export const SETUP_UNEXPECTED =
  'Something went wrong on our end. Give it another try in a moment.';

interface Props {
  title: string;
  description?: string;
  /**
   * (TASK-340 / audit B5) Which numbered wizard step this is. Omitted for the
   * screens that are not part of the numbered run — the "you're done" screen
   * and the first-run agent bootstrap both use this shell without being a step,
   * and inventing a number for them would be worse than showing none.
   */
  step?: number;
  children: ReactNode;
}

export function SetupShell({ title, description, step, children }: Props) {
  return (
    <div className="flex items-center justify-center min-h-screen p-6 bg-background">
      <Card className="w-full max-w-[460px]">
        <CardHeader className="items-center text-center gap-3 pb-4">
          <BrandMark size="xl" />
          {/* The wizard never said how long it was. Three screens is short, but
              a first-time user setting up a server has no way to know that, and
              "how much more of this is there" is the question an unnumbered
              wizard leaves hanging. */}
          {step !== undefined && (
            <p className="text-xs text-muted-foreground" data-testid="setup-step">
              Step {step} of {SETUP_TOTAL_STEPS}
            </p>
          )}
          <CardTitle className="text-xl font-semibold tracking-[-0.012em]">
            {title}
          </CardTitle>
          {description !== undefined && (
            <CardDescription>{description}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="pt-2">{children}</CardContent>
      </Card>
    </div>
  );
}
