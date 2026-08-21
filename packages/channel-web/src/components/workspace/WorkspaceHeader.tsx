/**
 * The page header — where you are, what day it is, and the controls that act on
 * the whole page.
 *
 * Restored from the source design. It matters more than it looks: without it the
 * filter control was floating above the list with no anchor, and the queue had
 * no date on it at all — which for a surface whose entire subject is "what
 * happened while you were away" is a real omission.
 */
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export function WorkspaceHeader({
  title,
  subtitle,
  dark,
  onTheme,
  children,
}: {
  title: string;
  subtitle?: string;
  dark: boolean;
  onTheme: (dark: boolean) => void;
  /** Page-level controls, rendered left of the theme toggle. */
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 px-6">
      <h1 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h1>
      {subtitle && (
        <span className="text-[13px] text-muted-foreground">{subtitle}</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {children}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label="Toggle theme"
          onClick={() => onTheme(!dark)}
        >
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </Button>
      </div>
    </header>
  );
}

/**
 * The segmented control from the source design: one recessed track, the active
 * segment raised out of it. Distinct from a row of buttons — the raised segment
 * is what tells you these are views of one list rather than three actions.
 */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: Array<{ value: T; label: string; count?: number }>;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      className="gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          className="h-7 rounded-md px-3 text-[12.5px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
        >
          {o.label}
          {o.count !== undefined && (
            <span className="ml-1.5 tabular-nums">{o.count}</span>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
