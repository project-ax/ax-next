/**
 * ApiKeyField — one password field for one API key: label, optional hint,
 * and the input. Nothing else: no form, no save, no presence read.
 *
 * Extracted from `CredentialSlotForm` (slice 3) so the rail's Add key form can
 * collect EVERY key a connector needs and send them in one request (the save
 * is the Add — all or nothing), while the per-slot forms keep saving one key
 * at a time. Both draw the same field.
 *
 * It renders no access notice: like `CredentialSlotForm` it is a primitive,
 * and the connector call site that renders it owns `<ConnectorAccessNotice>`
 * (`connector-access-coverage.test.ts` scans for `<ApiKeyField`).
 *
 * SECURITY: a password input with autocomplete off; the value is never echoed.
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useId } from 'react';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export interface ApiKeyFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A short hint under the field (the connector's slot description). */
  description?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function ApiKeyField({
  label,
  value,
  onChange,
  description,
  placeholder,
  disabled,
}: ApiKeyFieldProps) {
  // A multi-slot connector renders one field per slot: a per-instance id
  // keeps each label's association unique (TASK-124).
  const id = useId();
  const hintId = useId();
  return (
    <Field data-disabled={disabled === true ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required
        {...(description !== undefined ? { 'aria-describedby': hintId } : {})}
      />
      {description !== undefined && (
        <FieldDescription id={hintId}>{description}</FieldDescription>
      )}
    </Field>
  );
}
