/**
 * ChainOfThought — the collapsed disclosure that holds an assistant turn's
 * reasoning (and the tool calls it made along the way).
 *
 * `MessagePrimitive.GroupedParts` (see Thread.tsx) coalesces adjacent
 * `reasoning` + `tool-call` parts into a single `group-chain-of-thought`
 * node and hands it to us as `children`. We wrap them in a shadcn
 * `Collapsible` that is **collapsed by default** (Invariant J4 — the UI hides
 * chain-of-thought unless the user opens it). This replaces the old approach
 * where thinking rode as a `text` part and leaked into the visible reply.
 *
 * `ReasoningText` renders one `reasoning` leaf — the model's thought prose —
 * as muted text inside the disclosure.
 */
import type { FC, PropsWithChildren } from 'react';
import { ChevronRight } from 'lucide-react';
import { useMessage } from '@assistant-ui/react';
import { cn } from '@/lib/utils';
import { toolStepStatus, type ToolStepLike } from '@/lib/tool-step-status';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';

/** The part status the group node mirrors from its last contained part. */
interface PartStatusLike {
  type?: string;
}

/** How the collapsed header should read — muted is the ordinary settled case. */
export type ChainOfThoughtTone = 'muted' | 'destructive' | 'warning';

export interface ChainOfThoughtSummary {
  text: string;
  tone: ChainOfThoughtTone;
}

/**
 * Summarize what the disclosure contains. While streaming → "Thinking…".
 * Settled → reflects the group's contents so the collapsed header tells the
 * user what happened without opening it: any tool calls → "Ran a command" /
 * "Ran N commands" (the disclosure also holds the reasoning, but the action is
 * what the header leads with); reasoning only → "Thought". Pure function so the
 * wording is unit-testable without a render.
 *
 * (TASK-335 / audit A3) A group containing a FAILED step used to summarize as
 * "Ran a command" — the header claimed a success and the failure was visible
 * only to someone who thought to open the disclosure. A HELD step was worse: it
 * is waiting on the reader, and the header said nothing about that at all.
 *
 * Text and tone come back together on purpose. They are the same decision, and
 * splitting them into two functions reading the same counts is how a header
 * ends up tinted red while saying "Ran a command".
 *
 * Failure outranks a hold here, which inverts the per-step ordering in
 * `lib/tool-step-status.ts` — deliberately. Per step, a hold is not a failure
 * and must not be painted as one. Across a whole group, a hold already has two
 * other places to announce itself (the composer's hold line and the approval
 * card itself) while a failure has none, so the failure leads.
 */
export function chainOfThoughtLabel(opts: {
  tools: number;
  running: boolean;
  failed?: number;
  held?: number;
}): ChainOfThoughtSummary {
  if (opts.running) return { text: 'Thinking…', tone: 'muted' };
  if ((opts.failed ?? 0) > 0) {
    return { text: "Couldn't finish a step", tone: 'destructive' };
  }
  if ((opts.held ?? 0) > 0) return { text: 'Waiting for you', tone: 'warning' };
  if (opts.tools === 1) return { text: 'Ran a command', tone: 'muted' };
  if (opts.tools > 1) return { text: `Ran ${opts.tools} commands`, tone: 'muted' };
  return { text: 'Thought', tone: 'muted' };
}

/** Semantic tokens only — `text-warning` is the same token the workspace uses for holds. */
const TONE_CLASS: Record<ChainOfThoughtTone, string> = {
  muted: 'text-muted-foreground hover:text-foreground',
  destructive: 'text-destructive hover:text-destructive',
  warning: 'text-warning hover:text-warning',
};

const EMPTY_PARTS: readonly unknown[] = Object.freeze([]);

/**
 * Collapsed-by-default chain-of-thought disclosure. The header summarizes the
 * group's contents (see {@link chainOfThoughtLabel}) — counting the reasoning
 * and tool-call parts at `indices` (the message-part positions the group
 * coalesced) — so "Thought and ran 3 commands" reads at a glance without
 * opening it. While streaming it reads "Thinking…". Stays closed until the
 * user opens it (Invariant J4).
 */
export const ChainOfThought: FC<
  PropsWithChildren<{ status?: PartStatusLike; indices: readonly number[] }>
> = ({ status, indices, children }) => {
  const running = status?.type === 'running';
  // Count this group's tool-call parts to build the summary header. The group
  // node carries only part INDICES, so we read the message's parts off the
  // message store and look up their types by index.
  const parts = useMessage(
    (m) => (m as { content?: readonly unknown[] }).content ?? EMPTY_PARTS,
  );
  let tools = 0;
  let failed = 0;
  let held = 0;
  for (const i of indices) {
    const part = parts[i] as (ToolStepLike & { type?: string }) | undefined;
    if (part?.type !== 'tool-call') continue;
    tools += 1;
    const step = toolStepStatus(part);
    if (step === 'failed') failed += 1;
    else if (step === 'waiting') held += 1;
  }
  const { text: label, tone } = chainOfThoughtLabel({ tools, running, failed, held });
  return (
    <Collapsible
      defaultOpen={false}
      className="my-3 max-w-[60ch]"
      data-testid="chain-of-thought"
    >
      <CollapsibleTrigger
        className={cn(
          `group inline-flex items-center gap-1.5 cursor-pointer
           text-[14px] leading-[1.4] transition-colors
           focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/50 focus-visible:outline-offset-2 focus-visible:rounded-sm`,
          TONE_CLASS[tone],
        )}
      >
        <span>{label}</span>
        <ChevronRight
          className="size-3 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-90"
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 ml-0.5 pl-3.5 border-l border-border flex flex-col gap-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};

/** One `reasoning` leaf — the model's thought prose, rendered muted. */
export const ReasoningText: FC<{ text: string }> = ({ text }) => (
  <div
    className="
      font-sans text-[14px] leading-[1.6] text-muted-foreground
      whitespace-pre-wrap break-words
    "
    data-testid="reasoning-part"
  >
    {text}
  </div>
);
