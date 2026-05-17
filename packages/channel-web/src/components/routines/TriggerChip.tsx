/**
 * TriggerChip — compact summary of a routine's trigger spec. Mirrors the
 * way CredentialsList renders the kind subtitle: monospace, restrained,
 * just enough info to recognize the trigger at a glance.
 */
import type { TriggerSpec } from '../../lib/routines';

function summarize(t: TriggerSpec): string {
  switch (t.kind) {
    case 'interval':
      return `interval ${t.every}`;
    case 'cron':
      return `cron ${t.expr}`;
    case 'webhook':
      return `webhook ${t.path}${t.hmac !== undefined ? ' (hmac)' : ''}`;
  }
}

export function TriggerChip({ trigger }: { trigger: TriggerSpec }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded-sm bg-muted text-[11px] font-mono tracking-[0.02em] text-muted-foreground shrink-0"
      title={`Trigger: ${trigger.kind}`}
    >
      {summarize(trigger)}
    </span>
  );
}
