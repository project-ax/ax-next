import * as Tooltip from '@radix-ui/react-tooltip';
import type { LucideIcon } from 'lucide-react';
import type { MouseEvent, Ref } from 'react';
import { ButtonBase } from '../internal/ButtonBase.js';
import type { ButtonSize } from './Button.js';

export interface IconButtonProps {
  label: string;
  icon: LucideIcon;
  intent?: 'secondary' | 'quiet';
  size?: ButtonSize;
  busy?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  ref?: Ref<HTMLButtonElement>;
}

// Shared with the TooltipOpen story; not part of the package exports.
export const TOOLTIP_CLASS =
  'ax-z-50 ax-rounded-md ax-border ax-border-solid ax-border-line-border ax-bg-overlay ax-px-md ax-py-xs ax-shadow-overlay ax-text-caption ax-text-fg-muted ax-font-sans';

export function IconButton({ label, icon, intent = 'quiet', size = 'md', ...rest }: IconButtonProps) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <ButtonBase {...rest} intent={intent} size={size} icon={icon} iconOnly aria-label={label} />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={TOOLTIP_CLASS} sideOffset={4}>
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
