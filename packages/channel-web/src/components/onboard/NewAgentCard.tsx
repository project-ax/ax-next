import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SetupShell } from '../setup/SetupShell';

export interface NewAgentCardProps {
  /**
   * `'first-run'` — the person has no agent yet, this is the first thing they
   * meet after signing in, and there is nothing behind it to go back to.
   * `'add'` — the explicit "+ New agent…" entry from the workspace.
   */
  mode: 'first-run' | 'add';
  /** Called with the trimmed name when the user confirms. */
  onCreate: (name: string) => void;
  /**
   * Add mode only: back to the workspace. First run has no equivalent and
   * ignores this — the only way out of first run is making an agent.
   */
  onCancel?: () => void;
  /**
   * Pre-fills the field. Used when the create failed and the person chose
   * "Change name": they should get the name they typed back, not a blank box.
   */
  initialName?: string;
}

// The bootstrap route's contract (`routes-agent-bootstrap.ts`): 1–128 chars,
// after trimming.
const MAX_NAME_LENGTH = 128;

/**
 * The name step of both "make an agent" flows (TASK-689; it replaced
 * `NewAgentDialog`).
 *
 * The user must supply a name before the agent is created, so the
 * `display_name` column is correct from the start — no placeholder that has to
 * be overwritten later.
 *
 * A CARD, NOT A DIALOG. On first run the old dialog was a modal over an empty
 * page: no product name, no welcome, and a look of its own between the login
 * card and the "Setting up your agent…" card. It is not a modal in the add flow
 * either — `App.tsx`'s bootstrap gate REPLACES the workspace while this is up
 * (see TASK-510), so there is no app behind it for an overlay to sit on. Being
 * a `SetupShell` card says what it is: a step, on its own page, that looks
 * like the steps on either side of it.
 *
 * Because it is no longer a Radix dialog it does not get Escape for free. Add
 * mode restores it with a listener of its own; first run deliberately has none.
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
export function NewAgentCard({
  mode,
  onCreate,
  onCancel,
  initialName = '',
}: NewAgentCardProps) {
  const [name, setName] = useState(initialName);
  const isAdd = mode === 'add';

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!valid) return;
      onCreate(trimmed);
    },
    [valid, trimmed, onCreate],
  );

  useEffect(() => {
    if (!isAdd) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // An Escape that ends an IME composition belongs to the composition.
      if (e.key !== 'Escape' || e.isComposing) return;
      onCancel?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isAdd, onCancel]);

  return (
    <SetupShell
      title={isAdd ? 'New agent' : 'Welcome to ax'}
      description={
        isAdd
          ? "Give it a name. It'll introduce itself in a moment."
          : "First, let's create your personal AI assistant."
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-agent-name">Agent name</FieldLabel>
            <Input
              id="new-agent-name"
              autoFocus
              placeholder="e.g. Juniper"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
            />
            <FieldDescription>You can change it later.</FieldDescription>
          </Field>
        </FieldGroup>
        <div className="flex justify-end gap-2">
          {isAdd && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={!valid}>
            Create agent
          </Button>
        </div>
      </form>
    </SetupShell>
  );
}
