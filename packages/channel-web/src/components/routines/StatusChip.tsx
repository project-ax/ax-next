/**
 * StatusChip — one run's status, on each row of a routine's run history in
 * Settings (`FireRowsTable`): `ok`, `silenced` or `error`, as that run's fire
 * row recorded it. It is not the routine's own `lastStatus`, which no
 * channel-web view draws. `null` draws a muted em dash labelled "Never fired";
 * no caller passes it today, since every run has a status. Color tokens stay
 * semantic (no raw hex). The only deviations from neutral are `error`'s
 * destructive ink, fill and border (`text-destructive` on
 * `bg-destructive-soft`) and a subdued `text-foreground/60` on `silenced`, so
 * a silenced run reads as "intentional", not "broken".
 */
import type { FireStatus } from '../../lib/routines';

export function StatusChip({ status }: { status: FireStatus | null }) {
  if (status === null) {
    return (
      <span
        className="inline-flex items-center justify-center w-[58px] py-0.5 rounded-sm bg-muted text-[11px] text-muted-foreground shrink-0"
        aria-label="Never fired"
      >
        —
      </span>
    );
  }
  const styles: Record<FireStatus, string> = {
    ok: 'bg-muted text-foreground',
    silenced: 'bg-muted text-foreground/60',
    error: 'bg-destructive-soft text-destructive border border-destructive/25',
  };
  return (
    <span
      className={`inline-flex items-center justify-center w-[58px] py-0.5 rounded-sm text-[11px] font-mono tracking-[0.02em] shrink-0 ${styles[status]}`}
    >
      {status}
    </span>
  );
}
