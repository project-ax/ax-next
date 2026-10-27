import { useId, useRef } from 'react';
import type { WebhookTrigger } from '@ax/routines-contract';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type Signature = NonNullable<WebhookTrigger['hmac']>;
type Custom = Extract<Signature, { header: string }>;
const github: Custom = { header: 'X-Hub-Signature-256', algorithm: 'sha256', prefix: 'sha256=' };
function isGitHub(value: Signature): boolean {
  return !('app' in value) && value.header.toLowerCase() === 'x-hub-signature-256'
    && value.algorithm === 'sha256' && (value.prefix === undefined || value.prefix === 'sha256=');
}

/** Signature configuration only. Secret entry stays in the owner-scoped vault UI. */
export function WebhookSignatureFields({ value, disabled, taskMode, invalidField, onChange }: {
  value: Signature | undefined; disabled: boolean; taskMode: boolean;
  invalidField?: string | undefined;
  onChange: (value: Signature | undefined) => void;
}) {
  const id = useId();
  const customDraft = useRef<Custom>({ header: 'X-Signature', algorithm: 'sha256' });
  if (value && !('app' in value) && !isGitHub(value)) customDraft.current = value;
  const app = value === undefined ? null : 'app' in value ? value.app : isGitHub(value) ? 'github' : 'other';
  const invalid = (field: string) => invalidField === 'webhook.hmac' || invalidField === `webhook.hmac.${field}`;
  return <>
    <Field orientation="horizontal">
      <FieldLabel htmlFor={`${id}-verify`}>Verify signature</FieldLabel>
      <Switch id={`${id}-verify`} checked={value !== undefined} disabled={disabled}
        onCheckedChange={checked => onChange(checked ? github : undefined)} />
    </Field>
    {value !== undefined && <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`${id}-app`}>App</FieldLabel>
        <ToggleGroup id={`${id}-app`} type="single" aria-label="App" value={app ?? ''} disabled={disabled}
          className="flex-wrap justify-start"
          onValueChange={next => {
            if (next === 'github') onChange(github);
            else if (next === 'other') onChange(customDraft.current);
            else if (next === 'stripe' || next === 'slack' || next === 'zendesk') onChange({ app: next });
          }}>
          <ToggleGroupItem value="github">GitHub</ToggleGroupItem>
          <ToggleGroupItem value="stripe">Stripe</ToggleGroupItem>
          <ToggleGroupItem value="slack">Slack</ToggleGroupItem>
          <ToggleGroupItem value="zendesk">Zendesk</ToggleGroupItem>
          <ToggleGroupItem value="other">Other</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {app === 'other' && !('app' in value) && <>
        <Field data-invalid={invalid('header') || undefined} data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={`${id}-header`}>Signature header</FieldLabel>
          <Input id={`${id}-header`} value={value.header} maxLength={128} disabled={disabled} aria-invalid={invalid('header') || undefined}
            onChange={event => onChange({ ...value, header: event.target.value })} />
        </Field>
        <Field data-invalid={invalid('algorithm') || undefined} data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={`${id}-algorithm`}>Signature algorithm</FieldLabel>
          <ToggleGroup id={`${id}-algorithm`} type="single" aria-label="Signature algorithm" value={value.algorithm} disabled={disabled}
            className="justify-start" onValueChange={algorithm => {
              if (algorithm === 'sha256' || algorithm === 'sha1') onChange({ ...value, algorithm });
            }}>
            <ToggleGroupItem value="sha256">SHA256</ToggleGroupItem>
            <ToggleGroupItem value="sha1">SHA1</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field data-invalid={invalid('prefix') || undefined} data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={`${id}-prefix`}>Signature prefix</FieldLabel>
          <Input id={`${id}-prefix`} value={value.prefix ?? ''} maxLength={128} disabled={disabled} aria-invalid={invalid('prefix') || undefined}
            onChange={event => {
              const { prefix: _prefix, ...rest } = value;
              onChange(event.target.value ? { ...rest, prefix: event.target.value } : rest);
            }} />
        </Field>
      </>}
      {app !== 'other' && app !== 'github' && <FieldDescription>
        We check the signature and reject updates with a timestamp more than five minutes from our clock.
      </FieldDescription>}
      <FieldDescription>
        {taskMode ? 'The task owner can manage its signing secret in Task options after saving. Without a saved secret, signed deliveries are rejected.' : 'The owner of this routine can manage its signing secret in the saved routine’s credential settings. Without a saved secret, signed deliveries are rejected.'}
      </FieldDescription>
    </FieldGroup>}
  </>;
}
