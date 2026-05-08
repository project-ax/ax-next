import { cn } from '@/lib/utils';

export type StatusDotVariant = 'empty' | 'ok' | 'bad' | 'pending';

export interface StatusDotProps {
  variant: StatusDotVariant;
  className?: string;
}

const VARIANT_CLASS: Record<StatusDotVariant, string> = {
  empty: 'bg-ink-ghost',
  ok: 'bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,hsl(var(--primary))_18%,transparent)]',
  bad: 'bg-destructive',
  pending:
    'bg-ink-ghost animate-pulse',
};

export function StatusDot({ variant, className }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block w-1.5 h-1.5 rounded-full shrink-0',
        VARIANT_CLASS[variant],
        className,
      )}
    />
  );
}
