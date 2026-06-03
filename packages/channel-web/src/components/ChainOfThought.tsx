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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';

/** The part status the group node mirrors from its last contained part. */
interface PartStatusLike {
  type?: string;
}

/**
 * Summarize what the disclosure contains. While streaming → "Thinking…".
 * Settled → reflects the group's contents so the collapsed header tells the
 * user what happened without opening it: any tool calls → "Ran a command" /
 * "Ran N commands" (the disclosure also holds the reasoning, but the action is
 * what the header leads with); reasoning only → "Thought". Pure function so the
 * wording is unit-testable without a render.
 */
export function chainOfThoughtLabel(opts: { tools: number; running: boolean }): string {
  if (opts.running) return 'Thinking…';
  if (opts.tools === 1) return 'Ran a command';
  if (opts.tools > 1) return `Ran ${opts.tools} commands`;
  return 'Thought';
}

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
  // node carries only part INDICES, so we read the message's parts and look up
  // their types (same pattern the old tool-group used).
  const parts = useMessage(
    (m) => (m as { content?: readonly unknown[] }).content ?? EMPTY_PARTS,
  );
  let tools = 0;
  for (const i of indices) {
    if ((parts[i] as { type?: string } | undefined)?.type === 'tool-call') tools += 1;
  }
  const label = chainOfThoughtLabel({ tools, running });
  return (
    <Collapsible
      defaultOpen={false}
      className="my-3 max-w-[60ch]"
      data-testid="chain-of-thought"
    >
      <CollapsibleTrigger
        className="
          group inline-flex items-center gap-1.5 cursor-pointer
          text-[14px] leading-[1.4] text-muted-foreground transition-colors
          hover:text-foreground
          focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/50 focus-visible:outline-offset-2 focus-visible:rounded-sm
        "
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
