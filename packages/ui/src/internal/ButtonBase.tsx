import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx.js';
import { Spinner } from './Spinner.js';

export type ButtonBaseIntent = 'primary' | 'secondary' | 'quiet';
export type ButtonBaseSize = 'sm' | 'md';

// Internal: not exported from the package. Spreads the remaining props so Radix triggers (asChild) can attach handlers and refs.
export interface ButtonBaseProps
  extends Omit<ComponentProps<'button'>, 'className' | 'style' | 'children' | 'type'> {
  intent: ButtonBaseIntent;
  size: ButtonBaseSize;
  // Internal destructive look (ConfirmAction); the public Button has no danger intent.
  tone?: 'danger';
  busy?: boolean;
  type?: 'button' | 'submit' | 'reset';
  icon?: LucideIcon;
  iconOnly?: boolean;
  children?: ReactNode;
}

const BASE =
  'ax-relative ax-inline-flex ax-items-center ax-justify-center ax-gap-sm ax-whitespace-nowrap ax-rounded-md ax-border ax-text-subheading ax-font-sans ' +
  'ax-min-h-touch ax-min-w-touch md:ax-min-h-none md:ax-min-w-none ax-transition-colors ax-duration-fast ' +
  'focus-visible:ax-outline focus-visible:ax-outline-2 focus-visible:ax-outline-offset-2 focus-visible:ax-outline-line-ring ' +
  'disabled:ax-pointer-events-none';

const INTENT: Record<ButtonBaseIntent, string> = {
  primary: 'ax-border-transparent ax-bg-action ax-text-fg-inverse hover:ax-bg-action-hover',
  secondary: 'ax-border-line-border ax-bg-surface-raised ax-text-fg hover:ax-bg-muted',
  quiet: 'ax-border-transparent ax-bg-transparent ax-text-fg hover:ax-bg-muted',
};

const DANGER = 'ax-border-transparent ax-bg-status-danger ax-text-status-danger-fg hover:ax-bg-status-danger-hover';

const SIZE: Record<ButtonBaseSize, string> = {
  sm: 'ax-h-control-sm ax-px-lg',
  md: 'ax-h-control-md ax-px-lg',
};

const ICON_ONLY_SIZE: Record<ButtonBaseSize, string> = {
  sm: 'ax-h-control-sm ax-w-control-sm',
  md: 'ax-h-control-md ax-w-control-md',
};

const GLYPH = 'ax-h-lg ax-w-lg ax-shrink-0';

export function ButtonBase({
  intent,
  size,
  tone,
  busy,
  type = 'button',
  icon: Icon,
  iconOnly,
  disabled,
  children,
  ...rest
}: ButtonBaseProps) {
  const className = cx(
    BASE,
    tone === 'danger' ? DANGER : INTENT[intent],
    iconOnly ? ICON_ONLY_SIZE[size] : SIZE[size],
    disabled && !busy && 'ax-opacity-50',
  );
  // With an icon the spinner takes the icon's slot; without one it sits in the left padding so the width never changes.
  let lead: ReactNode = null;
  if (busy) {
    lead = <Spinner className={Icon || iconOnly ? GLYPH : 'ax-absolute ax-left-xs ax-h-md ax-w-md'} />;
  } else if (Icon) {
    lead = <Icon aria-hidden="true" className={GLYPH} />;
  }
  return (
    <button {...rest} type={type} disabled={disabled || busy} aria-busy={busy ? true : undefined} className={className}>
      {lead}
      {children}
    </button>
  );
}
