import type { LucideIcon } from 'lucide-react';
import type { MouseEvent, ReactNode, Ref } from 'react';
import { ButtonBase } from '../internal/ButtonBase.js';

export type ButtonIntent = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps {
  intent?: ButtonIntent;
  size?: ButtonSize;
  busy?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  icon?: LucideIcon;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  form?: string;
  autoFocus?: boolean;
  'aria-describedby'?: string;
  // For a row of look-alike buttons. Must contain the visible label text (WCAG 2.5.3 Label in Name):
  // "Decline Quill Bot" for a "Decline" button. Without it the label is the name.
  'aria-label'?: string;
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
}

export function Button({ intent = 'secondary', size = 'md', type = 'button', children, ...rest }: ButtonProps) {
  return (
    <ButtonBase intent={intent} size={size} type={type} {...rest}>
      {children}
    </ButtonBase>
  );
}
