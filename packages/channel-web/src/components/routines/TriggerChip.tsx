/**
 * TriggerChip — compact summary of a routine's trigger spec. Mirrors the
 * way CredentialsList renders the kind subtitle: monospace, restrained,
 * just enough info to recognize the trigger at a glance.
 */
import { describeCron } from '@/lib/cron-describe';
import type { TriggerSpec } from '../../lib/routines';

function summarize(t: TriggerSpec): string {
  switch (t.kind) {
    case 'interval':
      return `interval ${t.every}`;
    case 'cron': {
      const summary = describeCron(t.expr);
      return `${summary.kind === 'described' ? summary.text : t.expr} · ${t.tz}`;
    }
    case 'webhook':
      return `webhook ${t.path}${t.hmac !== undefined ? ' (hmac)' : ''}`;
  }
}

export function TriggerChip({ trigger }: { trigger: TriggerSpec }) {
  return (
    <span
      className="text-xs text-muted-foreground"
      title={`Trigger: ${trigger.kind}`}
    >
      {summarize(trigger)}
    </span>
  );
}
