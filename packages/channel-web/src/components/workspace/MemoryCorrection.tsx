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
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
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
  | { kind: 'restored'; since: number }
  | { kind: 'fix-undone'; since: number };

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
  options?: { onFixUndone?: (fix: MemoryFix) => void },
) {
  const [receipt, setReceipt] = useState<MemoryReceiptState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onFixUndone = options?.onFixUndone;

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
    if (now - receipt.since >= UNDO_WINDOW_MS) setReceipt(null);
  }, [receipt, now]);

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

  const undo = useCallback(
    async (row: FactMemoryStatement) => {
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
        start((since) => ({ kind: 'restored', since }));
        onChanged();
      } catch {
        setReceipt({ kind: 'undo-failed', row, status: 'idle' });
      }
    },
    [agentId, onChanged, start],
  );

  const undoFix = useCallback(
    async (fix: MemoryFix) => {
      setReceipt((r) =>
        r !== null && (r.kind === 'updated' || r.kind === 'fix-undo-failed')
          ? { ...r, status: 'undoing' }
          : r,
      );
      try {
        // `undone: false` means the fix was already taken back (a retry after
        // a lost response) — the old row IS in effect, so the receipt says so.
        await workspaceApi.uncorrectMemory(agentId, { id: fix.id, restore: fix.row.id });
        start((since) => ({ kind: 'fix-undone', since }));
        onFixUndone?.(fix);
        onChanged();
      } catch {
        setReceipt({ kind: 'fix-undo-failed', fix, status: 'idle' });
      }
    },
    [agentId, onChanged, onFixUndone, start],
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

  return { receipt, now, forgotten, updated, undo, undoFix, element };
}

/**
 * One receipt. Only the failure is an alert; the others are polite status
 * lines, and the ticking Undo button sits OUTSIDE the live region so a screen
 * reader hears "Forgotten" (or "Updated.") once rather than a number every
 * second. shadcn's `Alert` hard-codes `role="alert"`, so the polite ones
 * clear it.
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
  if (receipt.kind === 'restored' || receipt.kind === 'fix-undone') {
    return (
      <Alert role={undefined} className={className}>
        <AlertDescription>
          <span role="status">
            {receipt.kind === 'restored' ? MEMORY_RESTORED : MEMORY_FIX_UNDONE}
          </span>
        </AlertDescription>
      </Alert>
    );
  }
  if (isUndoFailed(receipt)) {
    const retry =
      receipt.kind === 'undo-failed' ? () => onUndo(receipt.row) : () => onUndoFix(receipt.fix);
    return (
      <Alert variant="destructive" className={className}>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {receipt.kind === 'undo-failed' ? MEMORY_UNDO_FAILED : MEMORY_FIX_UNDO_FAILED}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={receipt.status === 'undoing'}
            onClick={retry}
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
    <Alert role={undefined} className={className}>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {/* Where focus lands once the dialog that produced this closes (TASK-644). */}
        <span
          role="status"
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
