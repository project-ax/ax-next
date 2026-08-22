/**
 * The agent's current conversation.
 *
 * One continuous thread per agent, compacted rather than forked — the `fold`
 * message is the compaction summarize rung surfaced as a fact the user can see
 * rather than an invisible cost optimisation. Past conversations live in the
 * rail; routine fires never appear here at all, or 612 unattended runs would
 * bury the two conversations the human actually had.
 */
import { useState } from 'react';
import { ArrowUp, ChevronRight, Layers, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import type {
  Decision,
  ThreadMessage,
  WorkspaceAgent,
} from '@/lib/workspace-api';
import { AgentTile } from './bits';
import { ApprovalCard } from './ApprovalCard';

interface Props {
  agent: WorkspaceAgent;
  thread: ThreadMessage[];
  decisions: Decision[];
  readOnly: boolean;
  /** True while a reply is streaming — the composer waits it out. */
  busy?: boolean;
  onSend: (text: string) => void;
  /**
   * The three ways out of a decision. OPTIONAL, and an inline `ApprovalCard`
   * renders only when all three are supplied — nothing serves approve/dismiss/
   * undo yet, and a card whose buttons swallow the click is worse than no card.
   * AW-11 supplies them along with the decisions themselves.
   */
  onApprove?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => void;
}

export function AgentConversation({
  agent,
  thread,
  decisions,
  readOnly,
  busy = false,
  onSend,
  onApprove,
  onDismiss,
  onUndo,
}: Props) {
  const [draft, setDraft] = useState('');

  const send = () => {
    const v = draft.trim();
    if (!v || busy) return;
    setDraft('');
    onSend(v);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="flex max-w-[720px] flex-col gap-5">
          {thread.map((m) => (
            <Message
              key={m.id}
              m={m}
              agent={agent}
              decisions={decisions}
              onApprove={onApprove}
              onDismiss={onDismiss}
              onUndo={onUndo}
            />
          ))}
        </div>
      </div>

      {!readOnly && (
        <div className="border-t border-border px-6 py-4">
          <div className="flex max-w-[720px] items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder={`Message ${agent.name}`}
              className="h-10"
              disabled={busy}
            />
            <Button size="icon" onClick={send} aria-label="Send" disabled={busy}>
              <ArrowUp size={15} />
            </Button>
          </div>
          {/*
            No suggestion chips. They were authored prose in the prototype and
            the wire never carried them — a chip that puts words in the user's
            mouth is only worth it when something real proposes them.
          */}
        </div>
      )}
    </div>
  );
}

function Message({
  m,
  agent,
  decisions,
  onApprove,
  onDismiss,
  onUndo,
}: {
  m: ThreadMessage;
  agent: WorkspaceAgent;
  decisions: Decision[];
  onApprove: ((id: string) => void) | undefined;
  onDismiss: ((id: string) => void) | undefined;
  onUndo: ((id: string) => void) | undefined;
}) {
  if (m.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[13.5px] leading-relaxed text-primary-foreground">
          {m.text}
        </div>
      </div>
    );
  }

  if (m.kind === 'fold') {
    return (
      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Layers size={11} />
          {m.text}
        </span>
        <Separator className="flex-1" />
      </div>
    );
  }

  if (m.kind === 'status') {
    return (
      <div className="flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        {m.text}
      </div>
    );
  }

  if (m.kind === 'approval') {
    if (!onApprove || !onDismiss || !onUndo) return null;
    const d = decisions.find((x) => x.id === m.decisionId);
    if (!d) return null;
    return (
      <div className="flex gap-3">
        <AgentTile agent={agent} />
        <ApprovalCard
          decision={d}
          onApprove={() => onApprove(d.id)}
          onDismiss={() => onDismiss(d.id)}
          onUndo={() => onUndo(d.id)}
        />
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <AgentTile agent={agent} />
      <div className="min-w-0 flex-1">
        <div className="max-w-[600px] text-[13.5px] leading-relaxed text-pretty">
          {m.text}
        </div>
        {m.kind === 'steps' && <Steps label={m.stepsLabel} steps={m.steps} />}
        <div className="mt-1.5 text-[11.5px] text-muted-foreground">{m.time}</div>
      </div>
    </div>
  );
}

function Steps({ label, steps }: { label: string; steps: string[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-3 max-w-[600px] overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-muted px-3.5 py-2 text-[12px] text-muted-foreground"
      >
        <ListChecks size={12} />
        {label}
        <ChevronRight
          size={12}
          className={open ? 'ml-auto rotate-90' : 'ml-auto'}
        />
      </button>
      {open && (
        <div className="px-3.5 py-1">
          {steps.map((s, i) => (
            <div
              key={s}
              className={
                i === 0
                  ? 'py-2 text-[12.5px] text-muted-foreground'
                  : 'border-t border-rule-soft py-2 text-[12.5px] text-muted-foreground'
              }
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
