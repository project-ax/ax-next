import * as Dialog from '@radix-ui/react-dialog';
import type { LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { ButtonBase } from '../internal/ButtonBase.js';
import { Button, type ButtonSize } from './Button.js';
import { Heading } from './Heading.js';
import { IconButton } from './IconButton.js';
import { Notice } from './Notice.js';
import { Text } from './Text.js';

export type ConfirmActionTone = 'danger' | 'neutral';

interface ConfirmActionBase {
  // "Remove example.com?"
  title: string;
  description?: string;
  // The verb: "Remove site", "Revoke".
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  // Maps a failure to the copy shown in the dialog. The default never shows the thrown message.
  errorMessage?: (err: unknown) => string;
  // The confirm button: danger (default), or primary for a non-destructive confirm such as "Pause agents".
  tone?: ConfirmActionTone;
}

export interface ConfirmActionTrigger {
  label: string;
  intent?: 'secondary' | 'quiet';
  size?: ButtonSize;
  icon?: LucideIcon;
  iconOnly?: boolean;
}

// Exactly one of: a built-in trigger button, or controlled open state (opened from a menu item or row action).
export type ConfirmActionProps = ConfirmActionBase &
  (
    | { trigger: ConfirmActionTrigger; open?: never; onOpenChange?: never }
    | { open: boolean; onOpenChange: (open: boolean) => void; trigger?: never }
  );

const DEFAULT_ERROR = "That didn't work. Try again.";
const defaultErrorMessage = (): string => DEFAULT_ERROR;

// Overlay (scrim) doubles as the centering container; Content sits inside it (Radix's scrollable-overlay layout).
// There is no scrim token: the canvas color at 80% darkens in dark mode and washes out in light mode.
const OVERLAY = 'ax-fixed ax-inset-none ax-z-50 ax-flex ax-items-center ax-justify-center ax-overflow-y-auto ax-bg-canvas/80 ax-p-md';
const CONTENT =
  'ax-flex ax-w-full ax-max-w-narrow ax-flex-col ax-gap-lg ax-rounded-lg ax-border ax-border-line-border ax-bg-overlay ax-p-lg ax-shadow-overlay ' +
  'focus:ax-outline-none';

// Internal: the dialog for a given state. ConfirmAction owns the state; stories render this directly to pin the busy and error states.
export interface ConfirmActionViewProps {
  title: string;
  description?: string | undefined;
  confirmLabel: string;
  tone: ConfirmActionTone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}

export function ConfirmActionView({
  title,
  description,
  confirmLabel,
  tone,
  open,
  onOpenChange,
  trigger,
  busy,
  error,
  onConfirm,
}: ConfirmActionViewProps) {
  // Without a description, tell Radix there is none on purpose (it warns otherwise).
  const describedBy = description ? {} : { 'aria-describedby': undefined };
  // Radix returns focus to its Dialog.Trigger on close. Controlled mode has none, so Radix would drop focus to <body>.
  // Instead, remember what had focus when the dialog opened (a menu item, a row action) and return there.
  const restoreTo = useRef<HTMLElement | null>(null);
  const focusHandlers = trigger
    ? {}
    : {
        onOpenAutoFocus: () => {
          // Still the pre-open element: FocusScope fires this before moving focus into the dialog.
          restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        },
        onCloseAutoFocus: (e: Event) => {
          e.preventDefault();
          const el = restoreTo.current;
          restoreTo.current = null;
          if (el?.isConnected) el.focus();
        },
      };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY}>
          <Dialog.Content className={CONTENT} {...describedBy} {...focusHandlers}>
            <div className="ax-flex ax-flex-col ax-gap-sm">
              <Dialog.Title asChild>
                <Heading role="heading">{title}</Heading>
              </Dialog.Title>
              {description ? (
                <Dialog.Description asChild>
                  <Text role="body">{description}</Text>
                </Dialog.Description>
              ) : null}
            </div>
            {error !== null ? <Notice tone="danger">{error}</Notice> : null}
            <div className="ax-flex ax-flex-wrap ax-items-center ax-justify-end ax-gap-sm">
              <ButtonBase intent="quiet" size="md" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </ButtonBase>
              <ButtonBase
                intent="primary"
                size="md"
                {...(tone === 'danger' ? { tone: 'danger' as const } : {})}
                busy={busy}
                onClick={onConfirm}
              >
                {confirmLabel}
              </ButtonBase>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TriggerButton({ label, intent, size = 'md', icon, iconOnly, ...slot }: ConfirmActionTrigger) {
  // `slot` carries what Dialog.Trigger (asChild) adds: onClick, ref, aria-haspopup/-expanded/-controls, data-state.
  // Button and IconButton pass unknown props through to ButtonBase, which spreads them onto the <button>.
  if (iconOnly && icon) {
    return <IconButton {...slot} label={label} icon={icon} intent={intent ?? 'quiet'} size={size} />;
  }
  return (
    <Button {...slot} intent={intent ?? 'secondary'} size={size} {...(icon ? { icon } : {})}>
      {label}
    </Button>
  );
}

export function ConfirmAction(props: ConfirmActionProps) {
  const { title, description, confirmLabel, onConfirm, errorMessage = defaultErrorMessage, tone = 'danger' } = props;
  const [innerOpen, setInnerOpen] = useState(false);
  const open = props.trigger ? innerOpen : props.open;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set synchronously, before any re-render: a second click or Enter in the same tick must not call onConfirm again.
  const pending = useRef(false);

  // Each opening starts without an error, however it was closed (including a controlled parent setting open=false).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setError(null);
  }

  const setOpen = (next: boolean) => {
    if (props.trigger) setInnerOpen(next);
    else props.onOpenChange(next);
  };

  // Escape, an overlay click and Cancel all arrive here; while onConfirm is pending they do nothing.
  const handleOpenChange = (next: boolean) => {
    if (pending.current) return;
    setOpen(next);
  };

  const confirm = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      pending.current = false;
      setBusy(false);
      setError(errorMessage(err));
      return;
    }
    pending.current = false;
    setBusy(false);
    setOpen(false);
  };

  return (
    <ConfirmActionView
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      tone={tone}
      open={open}
      onOpenChange={handleOpenChange}
      trigger={props.trigger ? <TriggerButton {...props.trigger} /> : undefined}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
    />
  );
}
