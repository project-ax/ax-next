/**
 * The pieces every memory-correction surface shares: the Fix dialog, the
 * Forget dialog, and the receipt that follows either one.
 *
 * They live outside `FactsMemory` so the rail's "What I learned in this chat"
 * block and the "Memory used" chip can offer the same Fix and Forget with the
 * same words and the same receipt, instead of growing their own. The words
 * themselves are in `memory-copy.ts`; nothing in this file spells one out.
 *
 * WHY UNDO UN-FORGETS. Undo calls `memory:unforget` (TASK-630), which puts
 * the SAME row back with the provenance it had. It used to re-save the
 * subject, relation and value as the person who pressed Undo — and a
 * person-saved row outranks newer values the agent learned, so one Undo
 * silently changed which fact the profile shows. The forget itself is never
 * deferred to make Undo cheaper; a person who asks us to forget something
 * and closes the tab has had it forgotten.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { RESOLUTION_FOCUS_RING, takeResolutionFocus } from '@/lib/consent-focus';
import { cn } from '@/lib/utils';
import { workspaceApi, type FactMemoryStatement } from '@/lib/workspace-api';
import { UNDO_WINDOW_MS } from '@/lib/workspace-types';
import {
  MEMORY_CANCEL,
  MEMORY_FIX_FIELD_LABEL,
  MEMORY_FIX_REASON_CHANGED,
  MEMORY_FIX_REASON_CHANGED_HELPER,
  MEMORY_FIX_REASON_LEGEND,
  MEMORY_FIX_REASON_NEVER_RIGHT,
  MEMORY_FIX_REASON_NEVER_RIGHT_HELPER,
  MEMORY_FIX_SAVE,
  MEMORY_FIX_SAVE_FAILED,
  MEMORY_FIX_TITLE,
  MEMORY_FIX_UNDO_FAILED,
  MEMORY_FIX_UNDONE,
  MEMORY_FORGET,
  MEMORY_FORGET_FAILED,
  MEMORY_FORGET_TITLE,
  MEMORY_FORGOTTEN,
  MEMORY_RESTORED,
  MEMORY_UNDO_FAILED,
  MEMORY_UNDO_RETRY,
  MEMORY_UPDATED,
  memoryFixHelper,
  memoryForgetHelper,
  memoryStatementText,
  memoryUndoFixLabel,
  memoryUndoLabel,
  memoryUndoSecondsLeft,
  memoryUndoText,
  type MemoryFixReason,
  type MemoryVisibility,
} from './memory-copy';

function isFixReason(v: string): v is MemoryFixReason {
  return v === 'changed' || v === 'never-right';
}

/**
 * Marks a receipt's outcome line ("Updated.", "Forgotten") — the place focus
 * lands once a Fix or a Forget has saved (TASK-644).
 */
const OUTCOME_ATTR = 'data-memory-outcome';

/** Marks a drawn receipt, so the hook can tell whether it holds focus (TASK-651). */
const RECEIPT_ATTR = 'data-memory-receipt';

/** Marks a failed Undo's "Try again", where focus lands when an Undo fails. */
const RETRY_ATTR = 'data-memory-retry';

/**
 * Marks a memory row's own line — the place focus lands when an Undo gives
 * the row back, or a receipt runs out while it has focus (TASK-651). The value
 * is the row's id.
 */
export const MEMORY_ROW_ATTR = 'data-memory-row';

/**
 * Marks the heading of a surface's list: where focus waits when the row it
 * should land on is gone (a Forget whose Undo ran out) or not drawn yet (the
 * Memory tab re-reading after an Undo).
 */
export const MEMORY_HEADING_ATTR = 'data-memory-heading';

/**
 * The props that make a row's line a landing place: focusable only by script
 * (`tabIndex={-1}`), with the TASK-427 focus ring. It is the line and not the
 * row's Fix or Forget, for the same reason the receipt lands on its outcome
 * line and not on Undo: the key that just pressed Undo must not be one repeat
 * away from Forget. Fix is the next Tab stop.
 */
export function memoryRowLanding(id: string, className?: string) {
  return {
    tabIndex: -1,
    [MEMORY_ROW_ATTR]: id,
    className: cn(className, 'rounded-sm', RESOLUTION_FOCUS_RING),
  } as const;
}

/** As `memoryRowLanding`, for the list's heading. */
export const memoryHeadingLanding = {
  tabIndex: -1,
  [MEMORY_HEADING_ATTR]: '',
  className: cn('rounded-sm', RESOLUTION_FOCUS_RING),
} as const;

/**
 * How long a landing waits for its row to be drawn (the Memory tab re-reads
 * its list after an Undo). Past this, focus stays on the heading.
 */
const LAND_WAIT_MS = 5_000;

/**
 * Where keyboard focus goes when a Fix or Forget dialog closes (TASK-644).
 *
 * THE BUG. The dialogs are opened from state, so `useOpenerRestore` (in the
 * shadcn `DialogContent`) hands focus back to the button that opened them —
 * which is right for Cancel and Escape, where that button is still there. A
 * SAVE takes it away: the chip swaps the row's Fix for a badge, the rail
 * re-keys the row to the fixed memory's new id (or, on Forget, draws the
 * receipt in its place), and the Memory tab re-reads its list. The opener is
 * detached by the time the dialog closes, and focus fell to `<body>` — with a
 * ten-second Undo that is then a blind crawl away.
 *
 * WHERE IT LANDS: on the receipt's outcome line, not on Undo — the same call
 * the approval cards made (`consent-focus.ts`, TASK-427). Focus on Undo would
 * leave the key that just said "save" or "forget" one repeat away from taking
 * it back. The outcome line is inert (`tabIndex={-1}`), a screen reader reads
 * what happened, and Undo is the very next Tab stop.
 *
 * Only a close that FOLLOWS a save lands there — `arm()` is called just
 * before `onSaved` / `onForgotten`. Any other close (Cancel, Escape, a click
 * outside) is left to the opener restore. And if the surface drew no outcome
 * line (nothing matched in `scope`), this steps aside rather than guess.
 *
 * `scope` is the surface the receipt is drawn in. Each surface draws at most
 * one receipt at a time, so the first outcome line inside it is the one.
 */
function useLandOnOutcome(scope: RefObject<HTMLElement | null> | undefined) {
  const armed = useRef(false);
  const arm = useCallback(() => {
    armed.current = true;
  }, []);
  const disarm = useCallback(() => {
    armed.current = false;
  }, []);
  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      if (!armed.current) return;
      armed.current = false;
      const outcome = scope?.current?.querySelector<HTMLElement>(`[${OUTCOME_ATTR}]`);
      if (outcome === null || outcome === undefined) return;
      event.preventDefault();
      takeResolutionFocus(outcome);
    },
    [scope],
  );
  return { arm, disarm, onCloseAutoFocus };
}

export function MemoryFixDialog({
  target,
  agentId,
  visibility,
  onClose,
  onSaved,
  outcomeScope,
}: {
  target: FactMemoryStatement | null;
  agentId: string;
  visibility: MemoryVisibility;
  onClose: () => void;
  /**
   * The surface the receipt is drawn in: once the fix saves, focus lands on
   * the receipt's outcome line inside it (TASK-644, `useLandOnOutcome`).
   */
  outcomeScope?: RefObject<HTMLElement | null>;
  /**
   * Called once the fix is saved, with the answer to "What happened?" and
   * the fixed memory's new id and value. A fix writes a NEW row and closes
   * the old one, so a surface that keeps the row on screen (the rail block,
   * TASK-627) needs both to redraw it; the Memory tab just re-reads.
   */
  onSaved: (reason: MemoryFixReason, saved: { id: string; value: string }) => void;
}) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState<MemoryFixReason>('changed');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const land = useLandOnOutcome(outcomeScope);
  const { disarm } = land;

  useEffect(() => {
    if (target !== null) {
      setValue(target.value);
      // A new memory is a new question: never carry the last answer over.
      setReason('changed');
      setError(false);
      setPending(false);
      disarm();
    }
  }, [target, disarm]);

  async function save() {
    if (target === null || pending || value.trim() === '') return;
    setPending(true);
    setError(false);
    try {
      const saved = await workspaceApi.correctMemory(agentId, {
        id: target.id,
        about: target.about,
        relation: target.relation,
        value,
        reason,
      });
      land.arm();
      onSaved(reason, { id: saved.id, value });
    } catch {
      setPending(false);
      setError(true);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={land.onCloseAutoFocus}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{MEMORY_FIX_TITLE}</DialogTitle>
          <DialogDescription>{memoryFixHelper(visibility)}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="memory-fix-value">{MEMORY_FIX_FIELD_LABEL}</FieldLabel>
            <Input
              id="memory-fix-value"
              value={value}
              disabled={pending}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <FieldSet>
            <FieldLegend variant="label">{MEMORY_FIX_REASON_LEGEND}</FieldLegend>
            <RadioGroup
              value={reason}
              disabled={pending}
              onValueChange={(v) => {
                if (isFixReason(v)) setReason(v);
              }}
            >
              <Field orientation="horizontal" data-disabled={pending || undefined}>
                <RadioGroupItem value="changed" id="memory-fix-reason-changed" />
                <FieldContent>
                  <FieldLabel htmlFor="memory-fix-reason-changed">
                    {MEMORY_FIX_REASON_CHANGED}
                  </FieldLabel>
                  <FieldDescription>{MEMORY_FIX_REASON_CHANGED_HELPER}</FieldDescription>
                </FieldContent>
              </Field>
              <Field orientation="horizontal" data-disabled={pending || undefined}>
                <RadioGroupItem value="never-right" id="memory-fix-reason-never-right" />
                <FieldContent>
                  <FieldLabel htmlFor="memory-fix-reason-never-right">
                    {MEMORY_FIX_REASON_NEVER_RIGHT}
                  </FieldLabel>
                  <FieldDescription>{MEMORY_FIX_REASON_NEVER_RIGHT_HELPER}</FieldDescription>
                </FieldContent>
              </Field>
            </RadioGroup>
          </FieldSet>
        </FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{MEMORY_FIX_SAVE_FAILED}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            {MEMORY_CANCEL}
          </Button>
          <Button
            type="button"
            disabled={pending || value.trim() === ''}
            onClick={() => void save()}
          >
            {MEMORY_FIX_SAVE}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MemoryForgetDialog({
  target,
  agentId,
  visibility,
  onClose,
  onForgotten,
  outcomeScope,
}: {
  target: FactMemoryStatement | null;
  agentId: string;
  visibility: MemoryVisibility;
  onClose: () => void;
  /** Called with the row that is now forgotten, so the caller can offer Undo. */
  onForgotten: (row: FactMemoryStatement) => void;
  /** As on `MemoryFixDialog`: where the receipt that follows is drawn. */
  outcomeScope?: RefObject<HTMLElement | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const land = useLandOnOutcome(outcomeScope);
  const { disarm } = land;

  useEffect(() => {
    if (target !== null) {
      setPending(false);
      setError(false);
      disarm();
    }
  }, [target, disarm]);

  async function forget() {
    if (target === null || pending) return;
    setPending(true);
    setError(false);
    try {
      await workspaceApi.forgetMemory(agentId, [target.id]);
      land.arm();
      onForgotten(target);
    } catch {
      setPending(false);
      setError(true);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={land.onCloseAutoFocus}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{MEMORY_FORGET_TITLE}</DialogTitle>
          <DialogDescription>{memoryForgetHelper(visibility)}</DialogDescription>
        </DialogHeader>
        {target !== null && <p className="text-sm">{memoryStatementText(target)}</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{MEMORY_FORGET_FAILED}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            {MEMORY_CANCEL}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void forget()}
          >
            {MEMORY_FORGET}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A saved Fix: the row it corrected (`row`), and the row it wrote in that
 * row's place (`id`, `value`). The receipt keeps both so Undo can name the two
 * rows `memory:uncorrect` needs, and a surface can redraw the old one.
 */
export interface MemoryFix {
  row: FactMemoryStatement;
  id: string;
  value: string;
}

/**
 * What just happened to a memory. One at a time: a new correction replaces the
 * previous receipt, the way a second approval replaces the first one's toast.
 */
export type MemoryReceiptState =
  | { kind: 'forgotten'; row: FactMemoryStatement; since: number; status: 'idle' | 'undoing' }
  | { kind: 'undo-failed'; row: FactMemoryStatement; status: 'idle' | 'undoing' }
  | { kind: 'updated'; fix: MemoryFix; since: number; status: 'idle' | 'undoing' }
  | { kind: 'fix-undo-failed'; fix: MemoryFix; status: 'idle' | 'undoing' }
  | { kind: 'restored'; rowId: string; since: number }
  | { kind: 'fix-undone'; rowId: string; since: number };

/**
 * Where focus should go once the receipt it was in changes (TASK-651): the
 * first of `rows` that is drawn, else the failed Undo's "Try again" (`retry`),
 * else the list heading. `wait` keeps watching for the row after parking on
 * the heading, for a surface that re-reads its list before drawing it.
 */
interface Landing {
  rows: string[];
  retry: boolean;
  wait: boolean;
}

function findRow(root: HTMLElement, ids: readonly string[]): HTMLElement | null {
  const drawn = Array.from(root.querySelectorAll<HTMLElement>(`[${MEMORY_ROW_ATTR}]`));
  for (const id of ids) {
    const hit = drawn.find((el) => el.getAttribute(MEMORY_ROW_ATTR) === id);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** The rows a receipt that runs out while it has focus hands focus to. */
function rowsAfterExpiry(r: MemoryReceiptState): string[] {
  switch (r.kind) {
    // A forgotten row leaves the list with its receipt: nothing to land on.
    case 'forgotten':
    case 'undo-failed':
      return [];
    // The fixed row, under its new id (rail, Memory tab) or its old one (chip).
    case 'updated':
    case 'fix-undo-failed':
      return [r.fix.id, r.fix.row.id];
    case 'restored':
    case 'fix-undone':
      return [r.rowId];
  }
}

/** The receipts that wait for a person (a retry) rather than for the clock. */
function isUndoFailed(
  r: MemoryReceiptState,
): r is Extract<MemoryReceiptState, { kind: 'undo-failed' | 'fix-undo-failed' }> {
  return r.kind === 'undo-failed' || r.kind === 'fix-undo-failed';
}

/**
 * The receipt and its clock, for a surface that offers Fix and Forget.
 *
 * `onChanged` runs after any write that changed what is in memory (either
 * Undo), so the surface can re-read. `onFixUndone` runs once a Fix's Undo has
 * worked, for a surface that keeps rows on screen itself (the rail block, the
 * chip) and has to put the old row back by hand. `element` is the receipt
 * drawn for the Memory tab (pinned to the bottom of the scroll area); a
 * surface with other room — the rail, an inline chip — renders
 * `MemoryReceipt` itself from `receipt`, `now`, `undo` and `undoFix`, with
 * its own `className`.
 *
 * WHY A FIX'S UNDO UN-CORRECTS (TASK-634). A Fix wrote a new row and closed
 * the old one. Undo calls `memory:uncorrect`, which retracts the new row and
 * re-opens the old one as it was — not a second Fix back to the old value,
 * which would re-save it as the person who pressed Undo.
 */
export function useMemoryReceipt(
  agentId: string,
  onChanged: () => void,
  options?: {
    onFixUndone?: (fix: MemoryFix) => void;
    /**
     * The surface the receipt and its rows are drawn in (TASK-651). When the
     * receipt holds focus and goes away under it — an Undo, or its ten
     * seconds running out — focus lands on the affected row's line
     * (`memoryRowLanding`) or, when that row is gone, on the list heading
     * (`memoryHeadingLanding`) inside it, instead of falling to `<body>`.
     */
    scope?: RefObject<HTMLElement | null>;
  },
) {
  const [receipt, setReceipt] = useState<MemoryReceiptState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onFixUndone = options?.onFixUndone;
  const scope = options?.scope;

  /*
    WHERE FOCUS GOES WHEN THE RECEIPT GOES (TASK-651). TASK-644 put focus on
    the receipt once a dialog saves; the receipt then leaves on its own — Undo
    swaps it for "Remembered again." (and drops the button that had focus), or
    its window runs out — and focus fell to `<body>`. So whether the receipt
    holds focus is read at the moment it is about to change (on the press, or
    on the tick that ends it), and the landing runs in the commit that draws
    what replaced it.

    Only a receipt that HOLDS focus moves it. One that runs out while the
    person is somewhere else leaves them there: moving focus nobody asked to
    move is the focus theft `useResolutionFocus`'s arming avoids.
  */
  const landing = useRef<Landing | null>(null);
  const stopWaiting = useRef<(() => void) | null>(null);
  const holdsFocus = useCallback((): boolean => {
    const root = scope?.current;
    const active = document.activeElement;
    if (root == null || !(active instanceof HTMLElement) || !root.contains(active)) return false;
    return active.closest(`[${RECEIPT_ATTR}]`) !== null;
  }, [scope]);

  useLayoutEffect(() => {
    const plan = landing.current;
    landing.current = null;
    const root = scope?.current;
    if (plan === null || root == null) return;
    stopWaiting.current?.();
    const row = findRow(root, plan.rows);
    if (row !== null) {
      takeResolutionFocus(row);
      return;
    }
    if (plan.retry) {
      const retry = root.querySelector<HTMLElement>(`[${RETRY_ATTR}]`);
      if (retry !== null) {
        takeResolutionFocus(retry);
        return;
      }
    }
    const heading = root.querySelector<HTMLElement>(`[${MEMORY_HEADING_ATTR}]`);
    takeResolutionFocus(heading);
    if (!plan.wait || heading === null || plan.rows.length === 0) return;
    // The row is on its way (a re-read): move on to it when it is drawn — but
    // only if the person is still waiting on the heading, never from wherever
    // they have gone since.
    const observer = new MutationObserver(() => {
      if (document.activeElement !== heading) {
        stop();
        return;
      }
      const drawn = findRow(root, plan.rows);
      if (drawn !== null) {
        takeResolutionFocus(drawn);
        stop();
      }
    });
    const timer = setTimeout(() => stop(), LAND_WAIT_MS);
    function stop() {
      observer.disconnect();
      clearTimeout(timer);
      if (stopWaiting.current === stop) stopWaiting.current = null;
    }
    stopWaiting.current = stop;
    observer.observe(root, { childList: true, subtree: true });
  }, [receipt, scope]);
  useEffect(() => () => stopWaiting.current?.(), []);

  const timed = receipt !== null && !isUndoFailed(receipt);
  useEffect(() => {
    if (!timed) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [timed, receipt]);

  // The offer ends on the clock, not on the next render that happens to look.
  useEffect(() => {
    if (receipt === null || isUndoFailed(receipt)) return;
    if (
      (receipt.kind === 'forgotten' || receipt.kind === 'updated') &&
      receipt.status === 'undoing'
    ) {
      return;
    }
    if (now - receipt.since >= UNDO_WINDOW_MS) {
      if (holdsFocus()) {
        landing.current = { rows: rowsAfterExpiry(receipt), retry: false, wait: false };
      }
      setReceipt(null);
    }
  }, [receipt, now, holdsFocus]);

  // Every receipt starts its clock and `now` together, so its first paint never
  // counts from a stale `now` (it would read "Undo 73s" for a frame).
  const start = useCallback((next: (at: number) => MemoryReceiptState) => {
    const at = Date.now();
    setNow(at);
    setReceipt(next(at));
  }, []);

  const forgotten = useCallback(
    (row: FactMemoryStatement) =>
      start((since) => ({ kind: 'forgotten', row, since, status: 'idle' })),
    [start],
  );
  const updated = useCallback(
    (fix: MemoryFix) => start((since) => ({ kind: 'updated', fix, since, status: 'idle' })),
    [start],
  );

  /*
    Where an Undo sends focus, read when it is PRESSED — the button is still
    there then; it is disabled while the write is out and gone once the
    receipt changes. It worked: the row it gave back (waiting for it, on a
    surface that re-reads). It failed: "Try again".
  */
  const landAfterUndo = useCallback(
    (held: boolean, rowId: string, ok: boolean) => {
      if (!held) return;
      landing.current = ok
        ? { rows: [rowId], retry: false, wait: true }
        : { rows: [], retry: true, wait: false };
    },
    [],
  );

  const undo = useCallback(
    async (row: FactMemoryStatement) => {
      const held = holdsFocus();
      setReceipt((r) =>
        r !== null && (r.kind === 'forgotten' || r.kind === 'undo-failed')
          ? { ...r, status: 'undoing' }
          : r,
      );
      try {
        // An empty `restored` means the row was no longer forgotten (a retry
        // after a lost response, a second tab) — it IS in effect, so the
        // receipt tells the truth, and the re-read below shows the rest.
        await workspaceApi.unforgetMemory(agentId, [row.id]);
        landAfterUndo(held, row.id, true);
        start((since) => ({ kind: 'restored', rowId: row.id, since }));
        onChanged();
      } catch {
        landAfterUndo(held, row.id, false);
        setReceipt({ kind: 'undo-failed', row, status: 'idle' });
      }
    },
    [agentId, onChanged, start, holdsFocus, landAfterUndo],
  );

  const undoFix = useCallback(
    async (fix: MemoryFix) => {
      const held = holdsFocus();
      setReceipt((r) =>
        r !== null && (r.kind === 'updated' || r.kind === 'fix-undo-failed')
          ? { ...r, status: 'undoing' }
          : r,
      );
      try {
        // `undone: false` means the fix was already taken back (a retry after
        // a lost response) — the old row IS in effect, so the receipt says so.
        await workspaceApi.uncorrectMemory(agentId, { id: fix.id, restore: fix.row.id });
        landAfterUndo(held, fix.row.id, true);
        start((since) => ({ kind: 'fix-undone', rowId: fix.row.id, since }));
        onFixUndone?.(fix);
        onChanged();
      } catch {
        landAfterUndo(held, fix.row.id, false);
        setReceipt({ kind: 'fix-undo-failed', fix, status: 'idle' });
      }
    },
    [agentId, onChanged, onFixUndone, start, holdsFocus, landAfterUndo],
  );

  const element =
    receipt === null ? null : (
      <MemoryReceipt
        receipt={receipt}
        now={now}
        onUndo={(row) => void undo(row)}
        onUndoFix={(fix) => void undoFix(fix)}
        className="sticky bottom-0"
      />
    );

  /*
    WHAT IS SAID OUT LOUD, AND BY WHOM — each outcome once (TASK-651).
    "Updated." and "Forgotten" are said by FOCUS: the dialog lands on that
    very line (TASK-644), so the line is not also a live region — it used to
    be one, and a reader could hear it twice. "Remembered again." and "Fix
    undone." are said HERE: after an Undo focus goes to the row, which does
    not carry those words. It is a region the surface keeps mounted (one
    inserted already holding its message is not reliably announced — see
    `LearnedAnnouncer`), and the sentence is keyed by the receipt's clock so
    two Undos in a row are two announcements. It is empty on mount and once
    the receipt is gone, so a reader walking the page finds no stale news.
  */
  const said =
    receipt?.kind === 'restored'
      ? MEMORY_RESTORED
      : receipt?.kind === 'fix-undone'
        ? MEMORY_FIX_UNDONE
        : null;
  const announcer = (
    <span className="sr-only" role="status" aria-live="polite" data-memory-said="">
      {said !== null && receipt !== null && 'since' in receipt && (
        <span key={receipt.since}>{said}</span>
      )}
    </span>
  );

  return { receipt, now, forgotten, updated, undo, undoFix, element, announcer };
}

/**
 * One receipt. Only the failure is an alert. The others are not live regions
 * at all (TASK-651): "Forgotten" and "Updated." are read by the focus that
 * lands on them, and "Remembered again." / "Fix undone." by the hook's
 * `announcer` — never by a region wrapped around the ticking Undo, which would
 * read a number every second. shadcn's `Alert` hard-codes `role="alert"`, so
 * the quiet ones clear it.
 */
export function MemoryReceipt({
  receipt,
  now,
  onUndo,
  onUndoFix,
  className,
}: {
  receipt: MemoryReceiptState;
  now: number;
  onUndo: (row: FactMemoryStatement) => void;
  onUndoFix: (fix: MemoryFix) => void;
  className?: string;
}) {
  const drawn = { [RECEIPT_ATTR]: '' };
  if (receipt.kind === 'restored' || receipt.kind === 'fix-undone') {
    // Said by the hook's `announcer`, not here (TASK-651): see `useMemoryReceipt`.
    return (
      <Alert role={undefined} className={className} {...drawn}>
        <AlertDescription>
          <span>{receipt.kind === 'restored' ? MEMORY_RESTORED : MEMORY_FIX_UNDONE}</span>
        </AlertDescription>
      </Alert>
    );
  }
  if (isUndoFailed(receipt)) {
    const retry =
      receipt.kind === 'undo-failed' ? () => onUndo(receipt.row) : () => onUndoFix(receipt.fix);
    return (
      <Alert variant="destructive" className={className} {...drawn}>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {receipt.kind === 'undo-failed' ? MEMORY_UNDO_FAILED : MEMORY_FIX_UNDO_FAILED}
          </span>
          {/*
            Where focus lands when an Undo fails (TASK-651): the one thing to
            do next. The alert says what went wrong; the button is its own words.
          */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={receipt.status === 'undoing'}
            onClick={retry}
            {...{ [RETRY_ATTR]: '' }}
          >
            {MEMORY_UNDO_RETRY}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const left = memoryUndoSecondsLeft(receipt.since, now);
  const offer = left > 0 || receipt.status === 'undoing';
  const label =
    receipt.kind === 'forgotten'
      ? memoryUndoLabel(receipt.row.value)
      : memoryUndoFixLabel(receipt.fix.value);
  const undo =
    receipt.kind === 'forgotten' ? () => onUndo(receipt.row) : () => onUndoFix(receipt.fix);
  return (
    <Alert role={undefined} className={className} {...drawn}>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {/*
          Where focus lands once the dialog that produced this closes
          (TASK-644). Not a live region (TASK-651): focus already reads it, and
          a line that is both was one way to hear "Updated." twice.
        */}
        <span
          tabIndex={-1}
          {...{ [OUTCOME_ATTR]: '' }}
          className={cn('rounded-sm', RESOLUTION_FOCUS_RING)}
        >
          {receipt.kind === 'forgotten' ? MEMORY_FORGOTTEN : MEMORY_UPDATED}
        </span>
        {offer && (
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
        )}
        {offer && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label={label}
            disabled={receipt.status === 'undoing'}
            onClick={undo}
          >
            {memoryUndoText(Math.max(left, 1))}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
