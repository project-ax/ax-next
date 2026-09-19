/**
 * The page header — where you are, what day it is, and the controls that act on
 * the whole page.
 *
 * Restored from the source design. It matters more than it looks: without it the
 * filter control was floating above the list with no anchor, and the queue had
 * no date on it at all — which for a surface whose entire subject is "what
 * happened while you were away" is a real omission.
 *
 * No theme control here. Theme lives in the user menu at the bottom of the
 * sidebar, where the shipping app already puts it — a second home for one
 * setting is how two controls end up disagreeing.
 */
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export function WorkspaceHeader({
  title,
  subtitle,
  leading,
  children,
}: {
  title: string;
  subtitle?: string;
  /**
   * Rendered before the title, bare — no wrapper element, so when nothing is
   * passed the header's children are byte-for-byte what they always were.
   * Below `md` the shell puts its nav trigger here, because that is the only
   * door to a sidebar that has gone off-canvas (TASK-404).
   */
  leading?: React.ReactNode;
  /** Page-level controls, rendered at the right end. */
  children?: React.ReactNode;
}) {
  return (
    /*
      WHY THIS WRAPS BELOW `md` (TASK-404). `h-14` is a hard 56px and
      `ml-auto` pushes the controls at whatever the title and date leave —
      which on a phone is past the right edge of a viewport that cannot scroll
      sideways, so the filter chips were measured off-screen and unreachable.
      `min-h-14` keeps the desktop metric exactly (56px, nothing here is
      taller) while letting a second line exist at all; `w-full` on the control
      block claims its own wrapped line starting at the left padding edge,
      rather than trailing a title that has already used up the row.

      Deliberately NOT truncation. Clamping the title would hide the one thing
      that says where you are, and TASK-436 is separately putting `title`
      attributes back on text this app already clamps — adding another clamp
      here would be work in the opposite direction. Wrapping costs a line and
      loses nothing.

      At `md` and up every compact class is cancelled (`md:h-14`,
      `md:flex-nowrap`, `md:py-0`, `md:ml-auto`, `md:w-auto`), so the desktop
      layout is the one that shipped.
    */
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2 md:h-14 md:flex-nowrap md:py-0">
      {leading}
      <h1 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h1>
      {subtitle && (
        <span className="text-[13px] text-muted-foreground">{subtitle}</span>
      )}
      <div className="flex w-full items-center gap-2 md:ml-auto md:w-auto">
        {children}
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
          {/*
            A badge is a count of things that are there. Zero of them is not a
            count, it is the absence of one — and "Needs you 0" reads as a
            measurement we have not made. The tab says "Needs you" until there
            is something to number.
          */}
          {o.count !== undefined && o.count > 0 && (
            <span className="ml-1.5 tabular-nums">{o.count}</span>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
