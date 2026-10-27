/**
 * TriggerChip — compact summary of a routine's trigger spec. Mirrors the
 * way CredentialsList renders the kind subtitle: monospace, restrained,
 * just enough info to recognize the trigger at a glance.
 */
import { describeCron } from '@/lib/cron-describe';
import type { TriggerSpec } from '../../lib/routines';
import type { RoutineSchedule, WebhookTrigger } from '@ax/routines-contract';

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

export function TriggerChip({ schedule, webhook }: { schedule: RoutineSchedule | null; webhook: WebhookTrigger | null }) {
  const text = [schedule === null ? null : summarize(schedule), webhook === null ? null : summarize(webhook)].filter(Boolean).join(' · ');
  return (
    <span
      className="text-xs text-muted-foreground"
      title="When it runs"
    >
      {text}
    </span>
  );
}
