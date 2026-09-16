/**
 * The find bar over an agent's conversation, and the highlighter it drives
 * (TASK-354).
 *
 * WHY HIGHLIGHT AND NOT FILTER. The card allows either. Highlighting is the one
 * that cannot produce the defect the acceptance names: a filter over a query
 * nothing matches leaves an empty transcript, which reads as "this agent never
 * said anything" — design rule H7, the same one `AgentFiles` spends its header
 * avoiding. With a highlight the thread is never emptied, so that claim is
 * impossible to make by accident rather than merely remembered not to.
 *
 * It is also the better answer to the question being asked. Somebody looking
 * for a sentence from three weeks ago usually wants it back IN ITS CONTEXT —
 * what they asked just before, what the agent said just after. A filter throws
 * exactly that away.
 *
 * SCOPE, and what is deliberately absent: this searches the thread already on
 * screen and nothing else. No route, no index, no cross-conversation reach, and
 * no disabled control hinting at one. Past conversations are reachable through
 * the rail, which re-reads them by `conversationId`, so each becomes "the
 * thread on screen" in its turn.
 */
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { findRanges } from '@/lib/thread-find';
import type { FindIndex } from '@/lib/thread-find';

/** The id the toggle's `aria-controls` points at. One bar per conversation. */
export const THREAD_FIND_BAR_ID = 'thread-find-bar';

/**
 * How long the announced count waits for the typing to stop.
 *
 * Long enough that a word typed at a normal pace produces ONE reading instead
 * of one per letter; short enough that the answer still feels like it belongs
 * to what was just typed. Exported so the test can wait exactly this long
 * rather than guess.
 */
export const ANNOUNCE_DELAY_MS = 400;

/**
 * `value`, but only after it has stopped changing for `delay`.
 *
 * Deliberately starts EMPTY rather than at `value`: this backs a live region,
 * and a region whose first render already contains its message is the case
 * assistive tech does not reliably announce.
 */
function useDebounced(value: string, delay: number): string {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return settled;
}

/**
 * What a rendered message needs to know to paint itself, or `null` when the
 * bar is shut.
 *
 * Passing `null` rather than an empty query is the point: it makes "find is not
 * running" a state the renderer has to handle rather than one it infers from an
 * empty string, and it keeps a closed bar from paying for a walk of the thread.
 */
export interface FindView {
  query: string;
  /** Thread-wide index of the match the reader is standing on, -1 for none. */
  active: number;
  index: FindIndex;
}

interface BarProps {
  query: string;
  onQuery: (next: string) => void;
  /** 0-based position in the thread-wide numbering, -1 when nothing matched. */
  active: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  /** Escape, the X, and the toggle all land here — see `AgentConversation`. */
  onClose: () => void;
}

export function ThreadFindBar({
  query,
  onQuery,
  active,
  total,
  onNext,
  onPrev,
  onClose,
}: BarProps) {
  const boxRef = useRef<HTMLInputElement>(null);

  // A keyboard user who opens the bar lands in it. Without this they would
  // have to Tab back into the control they just opened, which is the sort of
  // thing that makes a "keyboard accessible" feature technically true.
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const searching = query.trim().length > 0;

  /*
    The sentence a screen reader gets. Spelled out rather than borrowing the
    visible "1 of 3", which is a find-bar idiom that reads as a fragment when
    there is no bar to look at.
  */
  const sentence = !searching
    ? ''
    : total === 0
      ? 'No matches.'
      : `Match ${active + 1} of ${total}.`;
  const announced = useDebounced(sentence, ANNOUNCE_DELAY_MS);

  return (
    <div
      id={THREAD_FIND_BAR_ID}
      className="flex min-w-0 flex-1 items-center gap-1.5"
      onKeyDown={(e) => {
        // Bound on the wrapper so Escape works from the field OR from any of
        // the three buttons — a reader who tabbed to "Next" should not have to
        // tab back to get out.
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <Input
        ref={boxRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (e.shiftKey) onPrev();
          else onNext();
        }}
        aria-label="Find in this conversation"
        placeholder="Find in this conversation"
        className="h-8 max-w-[260px] text-[13px]"
      />

      {/*
        TWO NODES, not one, and the split is the point.

        The SEEN count is conditional: "0 matches" over an untouched field
        answers a question nobody asked. It carries no ARIA at all. An earlier
        draft made this same node the live region and kept it permanently
        mounted-but-empty, which cost 6px twice over — an empty flex item still
        sits between its neighbours, so `gap-1.5` applied on both sides of
        nothing and the bar's spacing doubled every time it opened.

        The ANNOUNCED count is a permanently mounted `sr-only` region. It has to
        be permanent: a live region inserted into the DOM already holding its
        message is not reliably announced, because the assistive tech has
        nothing to have observed changing. `hidden`/`display:none` would have
        kept the layout tidy and taken it straight back out of the a11y tree,
        undoing the fix; `sr-only` keeps it there and takes no space.

        It is also DEBOUNCED. `role="status"` implies `aria-atomic`, so every
        keystroke re-reads the WHOLE sentence: typing "deploy" queues six full
        readings and the reader hears the first one over and over. The eye gets
        its answer immediately; the ear gets it once the typing settles.
      */}
      {searching && (
        <span
          data-find-count=""
          aria-hidden="true"
          className="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-muted-foreground"
        >
          {total === 0 ? 'No matches' : `${active + 1} of ${total}`}
        </span>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>

      {/*
        Disabled rather than hidden when there is nowhere to go: a control that
        appears and disappears under the pointer is harder to use than one that
        stays put and says it cannot help. And disabled rather than a no-op,
        because a button that swallows the click is the affordance-that-lies
        problem this card was written about.
      */}
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label="Previous match"
        disabled={total === 0}
        onClick={onPrev}
      >
        <ChevronUp size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label="Next match"
        disabled={total === 0}
        onClick={onNext}
      >
        <ChevronDown size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label="Close find"
        onClick={onClose}
      >
        <X size={15} />
      </Button>
    </div>
  );
}

interface ToggleProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /**
   * Owned by the conversation, not by this button, because the conversation is
   * what closes the bar (on Escape, from inside it) and therefore what has to
   * put focus back here.
   */
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The control that opens the bar — and, just as importantly, the control focus
 * comes back to when it closes.
 *
 * It stays mounted while the bar is open. That is not a styling preference: if
 * the toggle unmounted, the element Escape is supposed to return focus to would
 * be gone by the time it ran, and a keyboard user would be dropped on `<body>`
 * — the same silent failure `use-opener-restore.ts` was written to fix for
 * dialogs.
 */
export function ThreadFindToggle({
  open,
  onOpen,
  onClose,
  buttonRef,
}: ToggleProps) {
  return (
    <Button
      ref={buttonRef}
      variant="ghost"
      size="sm"
      className="h-8 shrink-0 gap-1.5 px-2 text-[12.5px] text-muted-foreground"
      aria-expanded={open}
      aria-controls={THREAD_FIND_BAR_ID}
      onClick={open ? onClose : onOpen}
    >
      <Search size={14} />
      Find
    </Button>
  );
};

/**
 * One run of message text, with the matches painted.
 *
 * It re-derives the ranges from the SAME `findRanges` the count came from, so
 * the number in the bar and the marks on the screen are two readings of one
 * calculation. Anything cleverer here — a second matcher, a memoized range list
 * that drifts — is how a find bar starts lying.
 *
 * COLOURS, MEASURED (WCAG 2.1, computed from the token values in `index.css`,
 * light / dark). A mark sits on two different backgrounds in this thread: the
 * pane behind an agent turn (`--background`) and the blue bubble behind a user
 * turn (`--primary`). Both readings matter, and `bg-foreground/text-background`
 * was the only pair that cleared every one of them:
 *
 *   active   `bg-foreground text-background` — own text 17.72:1 / 19.11:1;
 *            against the agent pane 17.72:1 / 19.11:1; against the user
 *            bubble 3.56:1 / 3.41:1.
 *   inactive `bg-warning-soft text-foreground` — own text 16.30:1 / 12.76:1.
 *            Its FILL measures only 1.09:1 against a white agent pane, which is
 *            no boundary at all, so it also carries `border-b border-warning`
 *            (4.84:1 / 12.68:1 there) to give the eye an edge to catch.
 *
 * `<mark>` needs both halves stated: the user-agent default is black on yellow
 * and Tailwind's preflight does not reset it, so a mark with only a background
 * class would keep a hardcoded colour underneath.
 */
export function FindHighlight({
  fieldKey,
  text,
  find,
}: {
  fieldKey: string;
  text: string;
  find: FindView | null;
}) {
  if (find === null) return <>{text}</>;
  const base = find.index.firstMatch.get(fieldKey);
  if (base === undefined) return <>{text}</>;

  const ranges = findRanges(text, find.query);
  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, n) => {
    if (range.start > cursor) out.push(text.slice(cursor, range.start));
    const isActive = base + n === find.active;
    out.push(
      <mark
        key={`${fieldKey}:${range.start}`}
        data-find-field={fieldKey}
        {...(isActive ? { 'data-find-active': 'true', 'aria-current': true as const } : {})}
        className={
          isActive
            ? 'rounded-[3px] bg-foreground px-0.5 text-background'
            : 'rounded-[3px] border-b border-warning bg-warning-soft px-0.5 text-foreground'
        }
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}
