/**
 * "Used N memories" — the chip under an answer (TASK-628).
 *
 * It lists what `memory_recall` handed the model for this one answer, so a
 * person can see what the agent was going on and Fix anything wrong right
 * where they noticed it. It is shaped like the step panel above it (the same
 * bordered disclosure), but CLOSED by default: the answer is the point, and
 * the memories behind it are a footnote a person opens when they wonder.
 *
 * Fix is the shared `MemoryFixDialog`, with the shared words from
 * `memory-copy.ts`. Once a fix saves, that row stops offering Fix and says
 * what happened instead — the same words the server uses for a row that was
 * closed before this read (`closedSince`), so a reload reads the same.
 *
 * Every statement is untrusted (it came out of a conversation). It is drawn as
 * text nodes only — no markdown, no HTML — and long values wrap.
 */
import { useState } from 'react';
import { BookOpen, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { MemoryUsed, MemoryUsedStatement } from '@/lib/workspace-types';
import { MemoryFixDialog, MemoryReceipt, useMemoryReceipt } from './MemoryCorrection';
import {
  MEMORY_FIX,
  MEMORY_USED_SINCE,
  memoryFixLabel,
  memoryStatementText,
  memoryUsedDetail,
  memoryUsedLabel,
  type MemoryUsedSinceKind,
} from './memory-copy';

const DATE = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** The row's date, or '' when `when` does not parse. */
function usedDate(when: string): string {
  const t = Date.parse(when);
  return Number.isNaN(t) ? '' : DATE.format(new Date(t));
}

// Nothing in memory changes under the chip's own list when a fix saves: the
// list is what the answer USED, which a later fix does not rewrite.
const noop = () => {};

export function MemoryUsedChip({ used, agentId }: { used: MemoryUsed; agentId: string }) {
  const [fixTarget, setFixTarget] = useState<MemoryUsedStatement | null>(null);
  /** Rows fixed from this chip since it was drawn, by id. */
  const [fixed, setFixed] = useState<ReadonlyMap<string, MemoryUsedSinceKind>>(
    () => new Map(),
  );
  // An undone fix hands the row its Fix button back.
  const receipt = useMemoryReceipt(agentId, noop, {
    onFixUndone: (fix) =>
      setFixed((m) => {
        const next = new Map(m);
        next.delete(fix.row.id);
        return next;
      }),
  });

  return (
    <Collapsible
      data-testid="workspace-memory-used"
      className="mt-3 max-w-[600px] overflow-hidden rounded-lg border border-border"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 bg-muted px-3.5 py-2 text-[12px] text-muted-foreground">
        <BookOpen size={12} aria-hidden="true" />
        {memoryUsedLabel(used.statements.length)}
        <ChevronRight
          size={12}
          aria-hidden="true"
          className="ml-auto transition-transform duration-150 group-data-[state=open]:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="px-3.5 py-1">
          {used.statements.map((row, i) => {
            const since = fixed.get(row.id) ?? row.closedSince;
            return (
              <li
                key={`${i}-${row.id}`}
                className={cn(
                  'flex items-start justify-between gap-3 py-2',
                  i > 0 && 'border-t border-rule-soft',
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="break-words text-[12.5px]">{memoryStatementText(row)}</span>
                  <span className="text-[11.5px] text-muted-foreground">
                    {memoryUsedDetail(row, usedDate(row.when))}
                  </span>
                </div>
                {since !== undefined ? (
                  <Badge variant="secondary" className="shrink-0">
                    {MEMORY_USED_SINCE[since]}
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    aria-label={memoryFixLabel(row.value)}
                    onClick={() => setFixTarget(row)}
                  >
                    {MEMORY_FIX}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {receipt.receipt !== null && (
          <MemoryReceipt
            receipt={receipt.receipt}
            now={receipt.now}
            onUndo={(row) => void receipt.undo(row)}
            onUndoFix={(fix) => void receipt.undoFix(fix)}
            className="rounded-none border-x-0 border-b-0"
          />
        )}
      </CollapsibleContent>
      <MemoryFixDialog
        target={fixTarget}
        agentId={agentId}
        visibility={used.visibility}
        onClose={() => setFixTarget(null)}
        onSaved={(reason, saved) => {
          const target = fixTarget;
          setFixTarget(null);
          if (target !== null) {
            setFixed((m) =>
              new Map(m).set(target.id, reason === 'never-right' ? 'retracted' : 'replaced'),
            );
            receipt.updated({ row: target, ...saved });
          }
        }}
      />
    </Collapsible>
  );
}
