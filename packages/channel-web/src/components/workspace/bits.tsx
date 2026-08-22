/**
 * Agent-workspace — small shared pieces.
 *
 * Everything here composes shadcn primitives and semantic tokens. No raw
 * colours: "held for you" uses the project's existing `warning` token
 * (`tailwind.config.ts` / `index.css`, both themes), because waiting-on-a-human
 * is a real third state that is neither an error nor business as usual.
 */
import { AlertTriangle, Ban, Check, Hand, type LucideIcon } from 'lucide-react';
import { AvatarTile } from '@/components/AvatarTile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { frameCapability, verdictFrame } from '@/lib/permission-frames';
import { cn } from '@/lib/utils';
import type {
  AgentRunState,
  CapabilityVerdict,
  GrantRow,
  PermissionRow,
  WorkspaceAgent,
} from '@/lib/workspace-types';

/**
 * Up to two initials from the agent's display name — the same convention the
 * shipped avatars use (`AgentChip` over `AvatarTile`), and the only identity
 * mark we actually have. The prototype keyed a lucide glyph off an `icon`
 * field the real agent record never carried: a picked-for-you icon is
 * decoration pretending to be information.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function AgentTile({
  agent,
  size = 26,
}: {
  agent: Pick<WorkspaceAgent, 'name'>;
  size?: number;
}) {
  return (
    <AvatarTile size={size} shape="square">
      <span
        aria-hidden="true"
        style={{ fontSize: Math.max(9, Math.round(size * 0.38)) }}
        className="font-medium leading-none text-foreground/70"
      >
        {initials(agent.name)}
      </span>
    </AvatarTile>
  );
}

/** Colour is the state, so the dot needs no label to be scannable in a list. */
export function StateDot({
  state,
  className,
}: {
  state: AgentRunState | 'held';
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'h-[7px] w-[7px] shrink-0 rounded-full',
        state === 'working' && 'bg-primary',
        state === 'waiting' && 'bg-warning',
        state === 'held' && 'bg-warning',
        state === 'resting' && 'bg-ink-ghost',
        state === 'stopped' && 'bg-destructive',
        className,
      )}
    />
  );
}

export function AgentStateLabel({ agent }: { agent: WorkspaceAgent }) {
  if (agent.state === 'stopped') return <Badge variant="destructive">Stopped</Badge>;
  if (agent.state === 'waiting')
    return (
      <Badge variant="secondary" className="bg-warning-soft text-warning">
        Waiting on you
      </Badge>
    );
  if (agent.state === 'working') return <Badge variant="secondary">Working</Badge>;
  return <Badge variant="secondary">Resting</Badge>;
}

/**
 * Elapsed, never remaining.
 *
 * The design this came from showed a progress bar and "~2 min left". An agent
 * cannot know either number, and one wrong ETA costs more trust than the widget
 * could ever earn. What it CAN report honestly is how long it has been going
 * and how far through a countable list it is.
 */
export function Elapsed({ since }: { since: string | null }) {
  if (!since) return null;
  const ms = Date.now() - Date.parse(since);
  const mins = Math.max(0, Math.round(ms / 60_000));
  return (
    <span>
      {mins < 1 ? 'just started' : `started ${mins} min ago`}
    </span>
  );
}

const VERDICT: Record<CapabilityVerdict, { Icon: LucideIcon; tone: string; label: string }> =
  {
    allow: { Icon: Check, tone: 'text-primary', label: 'Allowed' },
    hold: { Icon: Hand, tone: 'text-warning', label: 'Asks you first' },
    deny: { Icon: Ban, tone: 'text-destructive', label: 'Never' },
  };

/** The verdict mark. Colour and glyph are the renderer's; the verdict is not. */
function VerdictMark({ verdict }: { verdict: CapabilityVerdict }) {
  const v = VERDICT[verdict];
  return (
    <v.Icon size={13} aria-label={v.label} className={cn('mt-[3px] shrink-0', v.tone)} />
  );
}

/**
 * The vendor's own description of a third-party tool, behind an affordance.
 *
 * EVERYTHING here is about making sure this cannot be mistaken for our voice.
 * The text sits inside a quotation, in the muted colour the rest of the rail
 * uses for data rather than claims, under a line that names who wrote it and
 * says we have not checked it. It is rendered as TEXT — React escapes it, and
 * nothing on this surface turns a string into markup — so a description
 * containing headings, bold, or a convincing "⚠ Verified by AX" cannot become
 * any of those things. That is the attack this affordance exists to lose:
 * a third party writing prose that renders as our security claim.
 */
function TheirDescription({ row }: { row: PermissionRow }) {
  const who = row.theirName ?? 'somewhere else';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-sm underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          What {who} says it does
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="text-[11.5px] font-medium text-muted-foreground">
          {who} describes this tool as:
        </p>
        <p className="sr-only">
          This description was written by {who}, not by us, and we have not
          checked it.
        </p>
        <blockquote className="mt-1.5 border-l-2 border-border pl-2.5 text-[12.5px] italic text-muted-foreground">
          {row.theirDescription}
        </blockquote>
        <p className="mt-2.5 text-[11.5px] text-muted-foreground">
          Those are their words, not ours. We haven&apos;t checked them — the
          only parts we can vouch for are the tool&apos;s name and whether{' '}
          {row.verdict === 'hold' ? 'it has to ask you first' : 'it can run on its own'}.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One row of "What it may do alone".
 *
 * Two shapes, and `described` picks. A described row is OUR sentence, generated
 * from the rule that enforces it and framed by the verdict — never by anything
 * in the sentence itself, so a clause cannot contradict its own verdict. A row
 * we cannot describe goes mechanical: the tool's name (ours) and the verdict
 * (ours), with the third party's prose available, quoted and attributed.
 *
 * Nothing here reads `row.source`. It is printed as provenance and switched on
 * never — `provenance` is the machine-readable half, and parsing a display
 * string to decide rendering is how a renderer quietly couples itself to one
 * backend's id shapes.
 */
export function PermissionLine({ row }: { row: PermissionRow }) {
  const frame = row.described
    ? frameCapability({ verdict: row.verdict, capability: row.capability })
    : { ...verdictFrame(row.verdict), clause: null };
  return (
    <div className="flex items-start gap-2.5 py-1 text-[13px]">
      <VerdictMark verdict={row.verdict} />
      <span className="min-w-0 text-muted-foreground">
        <span className="text-foreground">{frame.prefix}</span>{' '}
        {row.described && <span>{frame.clause}</span>}
        {!row.described && row.mechanicalLabel !== null && (
          <>
            <span>use </span>
            <code className="break-all rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">
              {row.mechanicalLabel}
            </code>
          </>
        )}
        {/*
          Neither a sentence NOR a name. Rare — a described row whose clause
          fenced away to nothing, with no tool name behind it — and it still
          gets a row, because the alternative is dropping a capability the
          agent has (design H4). An empty <code> block would have been worse
          than either: it reads as a rendering bug rather than as reach.
        */}
        {!row.described && row.mechanicalLabel === null && (
          <span>do something we can&apos;t put a name to</span>
        )}
        {frame.suffix !== null && <span> — {frame.suffix}</span>}
        {/*
          THE TRUST LINE, and it is its own line on purpose.

          Inline and muted, "not verified" read as a footnote about the TEXT —
          a documentation quibble — when the thing we cannot vouch for is the
          TOOL. So the sentence is now about the tool, in our voice, on its own
          row, with the warning glyph design §4.3.5 asks for. The verdict mark
          on the left still tells the truth about what happens (this really can
          run on its own); this tells the truth about what we know.
        */}
        {!row.described && (
          <span className="mt-0.5 flex items-start gap-1 text-[11.5px] text-muted-foreground">
            <AlertTriangle size={10} aria-hidden="true" className="mt-[3px] shrink-0" />
            <span>
              {row.theirName === null
                ? "We haven't described this one."
                : `We can't tell you what this does — it comes from ${row.theirName}.`}{' '}
              {row.theirDescription !== null && <TheirDescription row={row} />}
            </span>
          </span>
        )}
        <span className="ml-1.5 break-all font-mono text-[10.5px] text-ink-ghost">
          {row.source}
        </span>
      </span>
    </div>
  );
}

/**
 * One row of "Granted by you", with its Revoke control.
 *
 * `action` is ours and `label` is the granted thing, kept apart and styled
 * apart: a hostname out of somebody's skill manifest is rendered as data, never
 * folded into our sentence.
 *
 * The button says Revoke and it revokes. That sounds like nothing to promise
 * until you have shipped a "Pick another time" wired to dismiss.
 */
export function GrantLine({
  row,
  busy,
  onRevoke,
}: {
  row: GrantRow;
  busy: boolean;
  onRevoke: (row: GrantRow) => void;
}) {
  const frame = verdictFrame(row.verdict);
  return (
    <div className="flex items-start gap-2.5 py-1 text-[13px]">
      <VerdictMark verdict={row.verdict} />
      <span className="min-w-0 flex-1 text-muted-foreground">
        <span className="text-foreground">{frame.prefix}</span> {row.action}{' '}
        <code className="break-all rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">
          {row.label}
        </code>
        {frame.suffix !== null && <span> — {frame.suffix}</span>}
        {row.grantedFor !== null && (
          <span className="text-[11.5px]">
            {' '}
            · for the {row.grantedFor.id}{' '}
            {row.grantedFor.kind === 'skill' ? 'skill' : 'connection'}
          </span>
        )}
        {row.grantedAt !== null && (
          <span className="ml-1.5 text-[11px] text-ink-ghost">
            {grantedDay(row.grantedAt)}
          </span>
        )}
      </span>
      {row.revocable && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onRevoke(row)}
          className="-mt-0.5 h-6 shrink-0 px-1.5 text-[11.5px]"
        >
          {busy ? 'Revoking…' : 'Revoke'}
        </Button>
      )}
    </div>
  );
}

/** "14 Aug", in the READER's locale. A server-formatted date is a wrong date. */
function grantedDay(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 text-[11.5px] font-medium text-muted-foreground first:mt-0">
      {children}
    </div>
  );
}
