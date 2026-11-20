/**
 * The two pieces of Slack's configuration-token step that more than one
 * surface shows (TASK-1167): the link to Slack's app settings, where the token
 * is generated, and the write-only field the token is pasted into. Admin ›
 * Slack and an agent's "Its own Slack bot" section both use them, so the two
 * can't drift on how a token is asked for.
 */
import type { RefObject } from 'react';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

const SLACK_APPS_URL = 'https://api.slack.com/apps';

export function SlackAppsLink() {
  return (
    <a
      href={SLACK_APPS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-primary underline underline-offset-4"
    >
      Slack&apos;s app settings
    </a>
  );
}

/**
 * A write-only field for one pasted configuration token. It is a password
 * field so the token isn't shown, which also makes password managers offer to
 * save it: the `data-*ignore` attributes tell 1Password, LastPass and
 * Bitwarden to leave it alone (`autoComplete="off"` alone doesn't stop them).
 */
export function TokenField({
  id,
  label,
  hint,
  inputRef,
  error,
  disabled,
  required = false,
}: {
  id: string;
  label: string;
  hint: string;
  inputRef: RefObject<HTMLInputElement | null>;
  error: string | null;
  disabled: boolean;
  /** The form can't go without it (an agent's bot request when the server holds no token for the person). */
  required?: boolean;
}) {
  const invalid = error !== null;
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        ref={inputRef}
        type="password"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        spellCheck={false}
        disabled={disabled}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-hint ${id}-error` : `${id}-hint`}
      />
      <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      {invalid && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}
