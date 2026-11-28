import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { ListRow } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

/**
 * A `ListRow` whose click opens a Sheet with the row's details and actions. It renders the row (an `li`, so put it
 * inside a `List`) and the portaled Sheet. `meta` is one muted line, `description` up to two clamped lines,
 * `trailing` static badges or controls that must not open the sheet.
 */
export function SheetRow({ title, meta, description, trailing, sheetDescription, children }: {
  title: string;
  meta?: ReactNode;
  description?: string;
  trailing?: ReactNode;
  sheetDescription?: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  // The row's own button, kept from the click: Safari does not focus a clicked button, so the sheet's "previously
  // focused element" would be <body>. If the row is gone by the time the sheet closes, the sheet's default applies.
  const opener = useRef<HTMLElement | null>(null);
  return <>
    <ListRow
      title={title}
      {...(meta ? { meta } : {})}
      {...(description ? { description } : {})}
      {...(trailing ? { trailing } : {})}
      onOpen={(event) => { opener.current = event.currentTarget; setOpen(true); }}
    />
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-[424px]"
        onCloseAutoFocus={(event) => {
          const el = opener.current;
          if (el?.isConnected) {
            event.preventDefault();
            el.focus();
          }
        }}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription asChild><div>{sheetDescription || description || meta || 'Manage this setting.'}</div></SheetDescription>
        </SheetHeader>
        <div className="mt-6 flex flex-col gap-4">{typeof children === 'function' ? children(() => setOpen(false)) : children}</div>
      </SheetContent>
    </Sheet>
  </>;
}
