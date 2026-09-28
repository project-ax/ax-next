/**
 * "What I learned in this chat" — the rail block under "Right now" (TASK-627).
 *
 * Why a rail block and not a chip under each message: extraction runs AFTER
 * the turn, sometimes minutes later, so a chip would land beside a message
 * the person has already scrolled past. The rail sits beside the whole
 * conversation, so a new memory shows up where the person can see it and fix
 * it while the chat is still fresh — without interrupting the chat.
 *
 * The rail's first rule applies here too: an empty list is a CLAIM. So the
 * block always says which of its states it is in — nothing new yet, reading,
 * paused, a save that failed, a read that failed, or memory not switched on —
 * and never shows a bare empty card.
 *
 * Every word is in `memory-copy.ts`; Fix, Forget and the receipt are the
 * shared ones in `MemoryCorrection.tsx`. The state behind this block is
 * `useConversationMemory`, owned by `AgentView` (see that hook for why).
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import type { FactMemoryStatement } from '@/lib/workspace-api';
import type { ConversationMemory, LearnedRow } from '@/lib/use-conversation-memory';
import { previewSource } from '@/lib/thread-jump';
import { SectionLabel } from './bits';
import {
  MemoryFixDialog,
  MemoryForgetDialog,
  MemoryReceipt,
  useMemoryReceipt,
} from './MemoryCorrection';
import {
  LEARNED_EARLIER,
  LEARNED_EXTRACTING,
  LEARNED_FROM_YOUR_MESSAGE,
  LEARNED_LOADING,
  LEARNED_NOTHING_NEW,
  LEARNED_NOT_ENABLED,
  LEARNED_PAUSED,
  LEARNED_PAUSED_ACTION,
  LEARNED_READ_FAILED,
  LEARNED_READ_FAILED_ACTION,
  LEARNED_SAVE_FAILED,
  LEARNED_SEE_ALL,
  LEARNED_TITLE,
  MEMORY_FIX,
  MEMORY_FORGET,
  MEMORY_RESTORED,
  MEMORY_UPDATED,
  learnedAgo,
  learnedMore,
  learnedNewBadge,
  memoryFixLabel,
  memoryForgetLabel,
  memoryStatementText,
  type MemoryVisibility,
} from './memory-copy';

/** Rows shown before "+N more from this chat". */
export const LEARNED_ROW_CAP = 5;

/** How often "4 min ago" is recomputed. */
const AGO_TICK_MS = 30_000;

/** The data attribute a row's container carries — focus finds its receipt by it. */
const ROW_ATTR = 'data-learned-row';

interface Props {
  memory: ConversationMemory;
  agentId: string;
  visibility: MemoryVisibility;
  /** Present only for an admin: opens Settings on AI model keys. */
  onOpenModelKeys?: (() => void) | undefined;
  /** Scroll the transcript to a message and highlight it. */
  onJumpToSource: (turnId: string) => void;
  /** Open the Memory tab. */
  onSeeAll: () => void;
}

/** One muted line — the same shape the rail's other blocks use. */
function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-muted-foreground">{children}</p>;
}

export function LearnedInChat({
  memory,
  agentId,
  visibility,
  onOpenModelKeys,
  onJumpToSource,
  onSeeAll,
}: Props) {
  const rootRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fixTarget, setFixTarget] = useState<FactMemoryStatement | null>(null);
  const [forgetTarget, setForgetTarget] = useState<FactMemoryStatement | null>(null);
  /** The row a receipt with no row of its own ("Updated.") belongs to. */
  const [receiptRowId, setReceiptRowId] = useState<string | null>(null);
  /*
    No re-read after an Undo. KNOWN LIMIT: Undo re-saves the memory under a
    NEW id (there is no un-forget yet), while this row keeps the old, closed
    one — so a Fix or Forget on a restored row acts on the closed statement.
    TASK-630's un-forget re-opens the SAME id, which removes the gap.
  */
  const receipt = useMemoryReceipt(agentId, () => {});
  const { markSeen, removeRow, pin, replaceRow, unseen } = memory;

  /*
    "New" clears when the block has actually been ON SCREEN, not when it
    rendered: the rail scrolls, and a count that clears itself below the fold
    would tell a person they had seen something they had not. Below `md` the
    sheet opening is what clears it (see `AgentView`).
  */
  useEffect(() => {
    const el = rootRef.current;
    if (el === null || unseen === 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) markSeen();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [unseen, markSeen]);

  // "4 min ago" moves on its own, but only while there is a time to show.
  const [now, setNow] = useState(() => Date.now());
  const anyTimed = memory.rows.some((r) => r.arrivedAt !== null);
  useEffect(() => {
    if (!anyTimed) return;
    const id = setInterval(() => setNow(Date.now()), AGO_TICK_MS);
    return () => clearInterval(id);
  }, [anyTimed]);

  /*
    A forgotten row leaves the list once its receipt is gone — when the Undo
    offer runs out, AND when another receipt replaces it (one receipt at a
    time). Only a successful Undo ("restored") keeps it.
  */
  const current = receipt.receipt;
  const lastForgotten = useRef<string | null>(null);
  useEffect(() => {
    if (current?.kind === 'restored') {
      lastForgotten.current = null;
      return;
    }
    const holding =
      current !== null && (current.kind === 'forgotten' || current.kind === 'undo-failed')
        ? current.row.id
        : null;
    const prev = lastForgotten.current;
    if (prev !== null && prev !== holding) removeRow(prev);
    lastForgotten.current = holding;
  }, [current, removeRow]);

  /*
    Focus goes to the receipt once a row is forgotten: the Forget button it was
    on is gone. A timeout, because the dialog's own close restores focus on a
    timer of its own, and that must not land after this one.
  */
  const forgottenSince = current?.kind === 'forgotten' ? current.since : null;
  const forgottenId = current?.kind === 'forgotten' ? current.row.id : null;
  useEffect(() => {
    if (forgottenSince === null || forgottenId === null) return;
    const id = setTimeout(() => {
      for (const el of rootRef.current?.querySelectorAll(`[${ROW_ATTR}]`) ?? []) {
        if (el.getAttribute(ROW_ATTR) === forgottenId) el.querySelector('button')?.focus();
      }
    }, 0);
    return () => clearTimeout(id);
  }, [forgottenSince, forgottenId]);

  return (
    <section ref={rootRef} aria-labelledby="learned-in-chat-title">
      <SectionLabel>
        <span id="learned-in-chat-title">{LEARNED_TITLE}</span>
        {unseen > 0 && (
          <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[11px]">
            {learnedNewBadge(unseen)}
          </Badge>
        )}
      </SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-2 p-3.5">
          <Body
            memory={memory}
            expanded={expanded}
            onExpand={() => setExpanded(true)}
            onOpenModelKeys={onOpenModelKeys}
            renderRow={(r) => {
              const statement = r.row;
              if (
                current !== null &&
                (current.kind === 'forgotten' || current.kind === 'undo-failed') &&
                current.row.id === statement.id
              ) {
                return (
                  <MemoryReceipt
                    receipt={current}
                    now={receipt.now}
                    onUndo={(row) => void receipt.undo(row)}
                    className="px-2.5 py-1.5 text-[12px]"
                  />
                );
              }
              const note =
                receiptRowId === statement.id &&
                (current?.kind === 'updated' || current?.kind === 'restored')
                  ? current.kind === 'updated'
                    ? MEMORY_UPDATED
                    : MEMORY_RESTORED
                  : null;
              return (
                <LearnedLine
                  learned={r}
                  now={now}
                  note={note}
                  onJump={onJumpToSource}
                  onFix={() => setFixTarget(statement)}
                  onForget={() => setForgetTarget(statement)}
                />
              );
            }}
          />
          {memory.status !== 'not-enabled' && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-[11.5px]"
                onClick={onSeeAll}
              >
                {LEARNED_SEE_ALL}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <MemoryFixDialog
        target={fixTarget}
        agentId={agentId}
        visibility={visibility}
        onClose={() => setFixTarget(null)}
        onSaved={(_reason, { id, value }) => {
          if (fixTarget !== null) {
            replaceRow(fixTarget.id, { ...fixTarget, id, value });
            setReceiptRowId(id);
          }
          setFixTarget(null);
          receipt.updated();
        }}
      />
      <MemoryForgetDialog
        target={forgetTarget}
        agentId={agentId}
        visibility={visibility}
        onClose={() => setForgetTarget(null)}
        onForgotten={(row) => {
          // Kept listed so its receipt can stand in its place.
          pin(row.id);
          setReceiptRowId(row.id);
          setForgetTarget(null);
          receipt.forgotten(row);
        }}
      />
    </section>
  );
}

function Body({
  memory,
  expanded,
  onExpand,
  onOpenModelKeys,
  renderRow,
}: {
  memory: ConversationMemory;
  expanded: boolean;
  onExpand: () => void;
  onOpenModelKeys: (() => void) | undefined;
  renderRow: (r: LearnedRow) => React.ReactNode;
}) {
  if (memory.status === 'not-enabled') return <Note>{LEARNED_NOT_ENABLED}</Note>;
  if (memory.status === 'loading') return <Note>{LEARNED_LOADING}</Note>;
  if (memory.status === 'read-failed') {
    return (
      <div className="flex flex-col items-start gap-2">
        <Note>{LEARNED_READ_FAILED}</Note>
        <Button type="button" variant="secondary" size="sm" onClick={memory.retry}>
          {LEARNED_READ_FAILED_ACTION}
        </Button>
      </div>
    );
  }

  const { rows } = memory;
  const paused = memory.extraction === 'paused';
  const extracting = !paused && memory.pass === 'extracting';
  const failed = !paused && memory.pass === 'failed';
  const visible = expanded ? rows : rows.slice(0, LEARNED_ROW_CAP);
  const hidden = rows.length - visible.length;
  const hasLive = rows.some((r) => r.batch > 0);

  return (
    <>
      {paused && (
        <div className="flex flex-col items-start gap-2">
          <Note>{LEARNED_PAUSED}</Note>
          {onOpenModelKeys !== undefined && (
            <Button type="button" variant="secondary" size="sm" onClick={onOpenModelKeys}>
              {LEARNED_PAUSED_ACTION}
            </Button>
          )}
        </div>
      )}
      {extracting && (
        <div className="flex items-center gap-2">
          {/* No progress bar and no ETA — same rule as "Right now". */}
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
          />
          <Note>{LEARNED_EXTRACTING}</Note>
        </div>
      )}
      {failed && <Note>{LEARNED_SAVE_FAILED}</Note>}
      {rows.length === 0 && !paused && !extracting && !failed && (
        <Note>{LEARNED_NOTHING_NEW}</Note>
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {visible.map((r, i) => {
            const prev = visible[i - 1];
            const newBatch = prev !== undefined && prev.batch !== r.batch;
            return (
              <Fragment key={r.row.id}>
                {newBatch && (
                  <li aria-hidden="true">
                    <Separator />
                  </li>
                )}
                {r.batch === 0 && hasLive && (prev === undefined || prev.batch !== 0) && (
                  // A group label, not an item: kept out of the list's count.
                  <li role="presentation" className="text-[11.5px] font-medium text-muted-foreground">
                    {LEARNED_EARLIER}
                  </li>
                )}
                <li {...{ [ROW_ATTR]: r.row.id }}>{renderRow(r)}</li>
              </Fragment>
            );
          })}
        </ul>
      )}
      {hidden > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 self-start px-1.5 text-[12px]"
          onClick={onExpand}
        >
          {learnedMore(hidden)}
        </Button>
      )}
    </>
  );
}

function LearnedLine({
  learned,
  now,
  note,
  onJump,
  onFix,
  onForget,
}: {
  learned: LearnedRow;
  now: number;
  note: string | null;
  onJump: (turnId: string) => void;
  onFix: () => void;
  onForget: () => void;
}) {
  const { row, arrivedAt } = learned;
  const text = memoryStatementText(row);
  const turnId = row.sourceTurnId;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[13px] leading-snug">{text}</p>
      <div className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted-foreground">
        {turnId !== undefined && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-[11.5px] font-normal text-muted-foreground underline"
            onMouseEnter={() => previewSource(turnId, true)}
            onMouseLeave={() => previewSource(turnId, false)}
            onFocus={() => previewSource(turnId, true)}
            onBlur={() => previewSource(turnId, false)}
            onClick={() => {
              previewSource(turnId, false);
              onJump(turnId);
            }}
          >
            {LEARNED_FROM_YOUR_MESSAGE}
          </Button>
        )}
        {turnId !== undefined && arrivedAt !== null && <span aria-hidden="true">·</span>}
        {arrivedAt !== null && <span>{learnedAgo(Math.max(0, now - arrivedAt))}</span>}
        {note !== null && <span role="status">{note}</span>}
        <span className="ml-auto flex gap-0.5">
          {/* Styled like GrantLine's Revoke, and never behind a ⋯ menu. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11.5px]"
            aria-label={memoryFixLabel(text)}
            onClick={onFix}
          >
            {MEMORY_FIX}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11.5px]"
            aria-label={memoryForgetLabel(text)}
            onClick={onForget}
          >
            {MEMORY_FORGET}
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * One polite announcement per batch: "Learned 2 things from this chat."
 *
 * Mounted by `AgentView`, outside the rail, so it speaks while the mobile
 * rail sheet is shut. The region is mounted before it has anything to say (a
 * region inserted already holding its message is not reliably announced), and
 * the text node is keyed by batch so two batches with the same sentence are
 * still two announcements.
 */
export function LearnedAnnouncer({
  announcement,
}: {
  announcement: { text: string; seq: number } | null;
}) {
  return (
    <span className="sr-only" role="status" aria-live="polite" data-learned-announcer="">
      {announcement !== null && <span key={announcement.seq}>{announcement.text}</span>}
    </span>
  );
}
