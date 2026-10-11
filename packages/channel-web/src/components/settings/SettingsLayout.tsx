import { createContext, useContext, useState, useRef, type Ref, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export const SettingsActionsContext = createContext<HTMLElement | null>(null);

/** Keeps each page's existing actions in the shared header, including live disabled states. */
export function SettingsActions({ children }: { children: ReactNode }) {
  const target = useContext(SettingsActionsContext);
  return target ? createPortal(children, target) : <div className="flex flex-wrap gap-2">{children}</div>;
}

export function SettingsHelp({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider delayDuration={300}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={`About ${title}`}>
                <Info aria-hidden="true" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          {!open && <TooltipContent>{title}</TooltipContent>}
        </Tooltip>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-3rem)]">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">{title}</p>
            <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setOpen(false)}>Close help</Button>
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

export function SettingsRow({ label, detail, value, onClick, disabled, children, ariaLabel, rowRef }: {
  label: ReactNode;
  detail?: ReactNode;
  value?: ReactNode;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  children?: ReactNode;
  ariaLabel?: string;
  rowRef?: Ref<HTMLButtonElement>;
}) {
  const content = <>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
      <span className="break-words text-sm font-medium">{label}</span>
      {detail && <span className="break-words text-xs font-normal text-muted-foreground">{detail}</span>}
    </span>
    {value && <span className="shrink-0 text-sm font-normal text-muted-foreground">{value}</span>}
    {onClick && <span className="flex size-10 shrink-0 items-center justify-center"><ChevronRight aria-hidden="true" /></span>}
    {children}
  </>;
  return <>
    {onClick ? <Button type="button" variant="settings-row" className="h-auto w-full max-md:min-h-[72px]" ref={rowRef} aria-label={ariaLabel} onClick={onClick} disabled={disabled}>{content}</Button>
      : <div className="flex min-h-[72px] items-center gap-4 px-2 py-3">{content}</div>}
    <Separator />
  </>;
}

export function SettingsDisclosure({ title, value, children, defaultOpen = false }: {
  title: string; value?: ReactNode; children: ReactNode; defaultOpen?: boolean;
}) {
  return <Collapsible defaultOpen={defaultOpen}>
    <CollapsibleTrigger asChild>
      <Button type="button" variant="settings-row" className="group h-auto min-h-14 w-full max-md:min-h-14">
        <span className="flex-1 text-left">{title}</span>
        {value && <span className="text-muted-foreground">{value}</span>}
        <ChevronDown aria-hidden="true" className="transition-transform group-data-[state=open]:rotate-180" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent className="pb-6 pt-3">{children}</CollapsibleContent>
    <Separator />
  </Collapsible>;
}

export function SettingsDetailRow({ label, detail, value, description, children }: {
  label: string; detail?: ReactNode; value?: ReactNode; description?: ReactNode; children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  return <>
    <SettingsRow rowRef={rowRef} label={label} detail={detail} value={value} ariaLabel={`Details for ${label}`} onClick={() => setOpen(true)} />
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[424px]" onCloseAutoFocus={(event) => { event.preventDefault(); rowRef.current?.focus(); }}>
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription asChild><div>{description || detail || 'Manage this setting.'}</div></SheetDescription>
        </SheetHeader>
        <div className="mt-6 flex flex-col gap-4">{typeof children === 'function' ? children(() => setOpen(false)) : children}</div>
      </SheetContent>
    </Sheet>
  </>;
}
