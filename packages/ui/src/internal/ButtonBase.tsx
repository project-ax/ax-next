import type { ComponentProps, MouseEvent, ReactNode } from 'react';
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
  icon?: LucideIcon | undefined;
  iconOnly?: boolean;
  children?: ReactNode;
}

const BASE =
  'ax-relative ax-inline-flex ax-items-center ax-justify-center ax-whitespace-nowrap ax-rounded-md ax-border ax-border-solid ax-text-subheading ax-font-sans ' +
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
  sm: 'ax-h-control-sm',
  md: 'ax-h-control-md',
};

// Idle: 16 + label + 16. Busy without an icon: 8 + 12 spinner + 4 + label + 8, the same total, so the button never changes width.
const SPACING_IDLE = 'ax-gap-sm ax-px-lg';
const SPACING_BUSY_NO_ICON = 'ax-gap-xs ax-pl-sm ax-pr-sm';

const ICON_ONLY_SIZE: Record<ButtonBaseSize, string> = {
  sm: 'ax-h-control-sm ax-w-control-sm',
  md: 'ax-h-control-md ax-w-control-md',
};

const GLYPH = 'ax-h-lg ax-w-lg ax-shrink-0';

// Busy buttons stay focusable (a `disabled` attribute would drop focus to <body>), so clicks, and form submits, are swallowed here.
function suppress(e: MouseEvent<HTMLButtonElement>) {
  e.preventDefault();
}

export function ButtonBase({
  intent,
  size,
  tone,
  busy,
  type = 'button',
  icon: Icon,
  iconOnly,
  disabled,
  onClick,
  children,
  ...rest
}: ButtonBaseProps) {
  const spinnerInIconSlot = Boolean(Icon) || Boolean(iconOnly);
  const className = cx(
    BASE,
    tone === 'danger' ? DANGER : INTENT[intent],
    iconOnly ? ICON_ONLY_SIZE[size] : SIZE[size],
    iconOnly ? 'ax-gap-sm' : busy && !spinnerInIconSlot ? SPACING_BUSY_NO_ICON : SPACING_IDLE,
    disabled && 'ax-opacity-50',
  );
  // With an icon the spinner takes the icon's slot; without one it sits in flow with tighter padding (SPACING_BUSY_NO_ICON).
  let lead: ReactNode = null;
  if (busy) {
    lead = <Spinner className={spinnerInIconSlot ? GLYPH : 'ax-h-md ax-w-md ax-shrink-0'} />;
  } else if (Icon) {
    lead = <Icon aria-hidden="true" className={GLYPH} />;
  }
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-busy={busy ? true : undefined}
      aria-disabled={busy ? true : undefined}
      onClick={busy ? suppress : onClick}
      className={className}
    >
      {lead}
      {children}
    </button>
  );
}
