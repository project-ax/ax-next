import type { ReactNode } from 'react';
import { Card, Stack, Text } from '@project-ax/ui';
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
    <div className="flex items-center justify-center min-h-screen p-6 bg-canvas">
      <div className="w-full max-w-md">
        <Card>
          <Stack gap="lg">
            <Stack gap="sm" align="center">
              <BrandMark size="xl" />
              {/* The wizard never said how long it was. Three screens is short, but
                  a first-time user setting up a server has no way to know that, and
                  "how much more of this is there" is the question an unnumbered
                  wizard leaves hanging. */}
              {step !== undefined && (
                <Text role="caption">
                  Step {step} of {SETUP_TOTAL_STEPS}
                </Text>
              )}
              {/* Without a heading this whole screen had none, which the first-run
                  name step (a dialog with an <h2> until TASK-689) cannot afford:
                  it is the first page anyone sees. */}
              <h1>
                <Text role="body-strong" inline>
                  {title}
                </Text>
              </h1>
              {description !== undefined && <Text role="meta">{description}</Text>}
            </Stack>
            {children}
          </Stack>
        </Card>
      </div>
    </div>
  );
}
