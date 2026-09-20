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
import { useRef } from 'react';
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

/** Which way an arrow key moves, or `null` for a key we do not own. */
function arrowStep(key: string): number | 'first' | 'last' | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return 1;
    case 'ArrowLeft':
    case 'ArrowUp':
      return -1;
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

/**
 * The segmented control from the source design: one recessed track, the active
 * segment raised out of it. Distinct from a row of buttons — the raised segment
 * is what tells you these are views of one list rather than three actions.
 *
 * IT IS A RADIOGROUP, AND UNTIL TASK-429 IT ONLY HALF-ADMITTED IT. Radix's
 * `ToggleGroup type="single"` gives each item `role="radio"` + `aria-checked`
 * but roots the set at `role="group"` — so the radios had no radiogroup owning
 * them, and the group had no accessible name. Both are set below; `role` and
 * `aria-label` reach Radix's own `<div>` because it spreads caller props after
 * its hardcoded `role="group"`.
 *
 * SELECTION FOLLOWS FOCUS, which is the half that was a real defect rather than
 * a mislabel. Radix wires the items into a RovingFocusGroup, so `ArrowRight`
 * moved focus to "Working" and left `aria-checked` on "Needs you": a screen
 * reader announced a segment that was not selected, and nothing the person did
 * next would make the two agree. For a radiogroup the arrow keys move selection
 * and focus TOGETHER (WAI-ARIA APG), which is what `moveSelection` below does.
 *
 * WHY THE HANDLER IS ON THE *ITEM* AND NOT ON THE GROUP. This is the whole
 * trick, and getting it wrong looks identical in this app's configuration —
 * verified against the installed `@radix-ui/react-roving-focus@1.1.11` dist,
 * not from memory:
 *
 *   - The roving group's ROOT installs no `onKeyDown` at all — only
 *     `onMouseDown` / `onFocus` / `onBlur`. The arrow handling lives on each
 *     ITEM, as `composeEventHandlers(itemProps.onKeyDown, rovingHandler)`.
 *   - `RovingFocusGroup.Item` wraps our button with `asChild`, and Radix's
 *     `Slot` calls the CHILD's handler first and the slot's second. The slot's
 *     is the composed one, and `composeEventHandlers` skips its own half when
 *     `event.defaultPrevented`.
 *
 * So an `onKeyDown` on the ITEM runs first and its `preventDefault()` genuinely
 * stands Radix's roving handler down. The same handler on the GROUP does not:
 * keydown reaches the item first, Radix has already queued its
 * `setTimeout(focusFirst)`, and both then run — agreeing only by coincidence,
 * because our target arithmetic happens to match Radix's for an LTR set of
 * all-focusable segments. Change any of that and focus and selection split
 * again, which is the bug this card exists to close.
 *
 * The group keeps a handler for one case the items cannot see: the track itself
 * holding focus with no item focused. It is guarded on
 * `event.target === event.currentTarget` so an item's own keydown does not
 * bubble up and move twice.
 *
 * IT ASSUMES LTR, DELIBERATELY AND NOT SILENTLY. Radix RTL-swaps Left/Right
 * (`getDirectionAwareKey`); we do not, because Radix resolves direction from a
 * `DirectionProvider` context rather than the DOM, this app installs none, and
 * a mirror we cannot exercise is a mirror that rots. Because we preempt Radix
 * rather than race it, an RTL deployment gets arrows that are visually
 * backwards — not arrows that move focus and selection to different segments.
 * Worth fixing before this app ever ships RTL.
 */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  label,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: Array<{ value: T; label: string; count?: number }>;
  /** The group's accessible name — a radiogroup with no name announces as one. */
  label: string;
}) {
  const track = useRef<HTMLDivElement>(null);

  function moveSelection(event: React.KeyboardEvent<HTMLElement>) {
    const step = arrowStep(event.key);
    if (step === null) return;
    // A modified arrow is somebody else's shortcut, not ours. Radix bails on
    // the same set, so leaving these alone changes nothing about who handles
    // them — it just means we are not the one who broke the shortcut.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    // FIRST, before any early return below: this is what makes Radix's roving
    // handler stand down (see the header). Suppressing the browser's own arrow
    // scrolling is the lesser half of what it buys.
    event.preventDefault();

    // The DOM is the source of truth for both the order and the values, so a
    // segment that cannot be focused is simply not in the list — indexing a
    // parallel `options` array would have gone out of step the first time one
    // was disabled. Move from whichever segment has focus, falling back to the
    // checked one when focus is still on the track itself.
    const items = Array.from(
      track.current?.querySelectorAll<HTMLElement>('[data-segment]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;

    const focused = items.findIndex((el) => el === document.activeElement);
    const checked = items.findIndex((el) => el.dataset.segment === value);
    const from = focused >= 0 ? focused : checked >= 0 ? checked : 0;

    const index =
      step === 'first'
        ? 0
        : step === 'last'
          ? items.length - 1
          : // Wraps, as a radiogroup does.
            (from + step + items.length) % items.length;

    // `index` is always in range — `items` is non-empty by the guard above, and
    // every branch either clamps to an end or takes a modulus. Written
    // defensively because `noUncheckedIndexedAccess` is on, and a silent no-op
    // beats an exception thrown out of a key handler.
    const target = items[index];
    const next = target?.dataset.segment;
    if (target === undefined || next === undefined) return;
    onValueChange(next as T);
    target.focus();
  }

  return (
    <ToggleGroup
      ref={track}
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      // Only when the TRACK itself holds the key. An item's own keydown bubbles
      // through here too, and it has already been handled below.
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) moveSelection(event);
      }}
      role="radiogroup"
      aria-label={label}
      className="gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          data-segment={o.value}
          onKeyDown={moveSelection}
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
