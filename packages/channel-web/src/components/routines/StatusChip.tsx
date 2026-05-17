/**
 * StatusChip — last_status indicator. Three real states + a never-fired
 * em-dash. Color tokens stay semantic (no raw hex); the only deviation
 * from neutral is `text-destructive` on `error` and a subdued `text-foreground/75`
 * on `silenced` so it reads as "intentional", not "broken".
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
    error: 'bg-destructive/10 text-destructive border border-destructive/25',
  };
  return (
    <span
      className={`inline-flex items-center justify-center w-[58px] py-0.5 rounded-sm text-[11px] font-mono tracking-[0.02em] shrink-0 ${styles[status]}`}
    >
      {status}
    </span>
  );
}
