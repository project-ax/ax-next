import { cn } from '@/lib/utils';

export type StatusDotVariant = 'empty' | 'ok' | 'bad' | 'pending';

export interface StatusDotProps {
  variant: StatusDotVariant;
  className?: string;
}

/**
 * Every fill here is an information-bearing mark, so each owes 3:1 against the
 * surfaces it lands on (WCAG 1.4.11). `empty` and `pending` used to be
 * `bg-ink-ghost` and measured 1.72:1 light / 1.67:1 dark on the card they sit
 * in — a bit over half the floor. They are `bg-state-quiet` now.
 *
 * Worth being honest about what that buys, because it is less than the card
 * that asked for it assumed: this dot never renders alone. All three LIVE
 * render sites are in `ConnectorsTab`, and each puts a plain-English label
 * immediately beside the dot ("Ready", "Needs a key", "Awaiting your
 * approval"), with the dot itself `aria-hidden`. So nobody was ever relying on
 * the colour to know the state, and the pulse gives `pending` a second channel
 * on top. The defect being fixed is a faint mark, not a lost meaning.
 *
 * `ProviderRow` pairs its dot with `DEFAULT_LABEL` in exactly the same way, and
 * is named here precisely because it does NOT count — nothing in the running UI
 * renders it, only its own unit test. Saying so beats re-grepping it.
 *
 * `theme-contrast.test.ts` reads these classes back out of this file and
 * measures whatever it finds, so reverting one fails with a ratio.
 */
const VARIANT_CLASS: Record<StatusDotVariant, string> = {
  empty: 'bg-state-quiet',
  ok: 'bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,hsl(var(--primary))_18%,transparent)]',
  bad: 'bg-destructive',
  pending: 'bg-state-quiet animate-pulse',
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
