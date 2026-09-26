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
import { Badge, badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  disclosedEffects,
  effectDisclosure,
  frameCapability,
  verdictFrame,
} from '@/lib/permission-frames';
import { cn } from '@/lib/utils';
import type {
  AgentRunState,
  CapabilityEffect,
  CapabilityVerdict,
  GrantRow,
  PermissionRow,
  WorkspaceAgent,
  WorkspaceReadStatus,
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

/**
 * The plain-English word for each state — one copy, shared by the badge below
 * and by every place that has to SAY a dot's state rather than paint it
 * (TASK-485: the sidebar roster, where the dot sits beside nothing but a name).
 * `held` is a decision waiting on you, which reads the same to the person.
 */
export const STATE_WORDS: Record<AgentRunState | 'held', string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  held: 'Waiting on you',
  resting: 'Resting',
  stopped: 'Stopped',
};

/**
 * `STATE_WORDS[state]`, with the badge's old fall-through kept: a state
 * outside the contract (malformed server data) reads as "Resting" rather than
 * as an empty badge or a crash in the roster's `.toLowerCase()`.
 */
export function stateWord(state: AgentRunState | 'held'): string {
  return STATE_WORDS[state] ?? STATE_WORDS.resting;
}

/**
 * Shape is the second channel (WCAG 1.4.1, TASK-485). Colour used to be the
 * whole message, so someone who cannot tell the hues apart got no state at
 * all. Each state now has its own outline too, readable in greyscale:
 *
 *   working ● circle · waiting/held ◆ diamond · resting ▬ dash · stopped ■ square
 *
 * Deliberately a separate record, NOT more `state === … && '…'` arms inside
 * the `cn()` below: `theme-contrast.test.ts` reads those arms back as the
 * dot's FILL, keyed by state, so a second arm per state would overwrite the
 * fill it measures. Fill lives there; geometry lives here.
 *
 * Every width here must fit inside `StateDotSlot` below (8px).
 * `StateDotSlot.test.tsx` fails if one doesn't.
 */
export const STATE_SHAPE: Record<AgentRunState | 'held', string> = {
  working: 'h-[7px] w-[7px] rounded-full',
  waiting: 'h-[6px] w-[6px] rotate-45 rounded-[1px]',
  held: 'h-[6px] w-[6px] rotate-45 rounded-[1px]',
  resting: 'h-[3px] w-[8px] rounded-full',
  stopped: 'h-[7px] w-[7px] rounded-[1px]',
};

/**
 * The state mark: a coloured SHAPE, never colour alone.
 *
 * It stays `aria-hidden` on purpose. A mark before a name cannot carry an
 * accessible name that reads well ("Waiting on you Ada"), and at most call
 * sites the adjacent text already says the state — a receipt line, a question
 * summary, a list of who is working. Where the dot is the ONLY carrier (the
 * sidebar roster), the call site adds the `STATE_WORDS` word as `sr-only` text
 * after the name. A new call site where the dot stands alone owes the same.
 *
 * Every fill still owes 3:1 against the surfaces it lands on — an
 * information-bearing non-text element under WCAG 1.4.11. `resting` used to be
 * `bg-ink-ghost` and measured 1.72:1 light / 1.67:1 dark, so on a pale row it
 * was less "quiet" than "absent". It is `bg-state-quiet` now; `--ink-ghost`
 * stayed behind with the composer's send circle, which is a disabled control
 * and the one thing 1.4.11 exempts. `theme-contrast.test.ts` reads these
 * classes back out of this file and measures whatever it finds.
 */
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
        'shrink-0',
        STATE_SHAPE[state],
        state === 'working' && 'bg-primary',
        state === 'waiting' && 'bg-warning',
        state === 'held' && 'bg-warning',
        state === 'resting' && 'bg-state-quiet',
        state === 'stopped' && 'bg-destructive',
        className,
      )}
    />
  );
}

/**
 * A fixed-width slot for `StateDot` (TASK-544, shared since TASK-546). The
 * shapes above differ in width by state, so a bare dot nudged the text after
 * it by a pixel from row to row. Centred in one 8px slot, every row's text
 * starts at the same offset. Use it wherever text lines up after a dot.
 *
 * The slot must be at least as wide as the widest `STATE_SHAPE`, or that
 * shape spills into the gap beside it. `StateDotSlot.test.tsx` pins this.
 */
export function StateDotSlot({ children }: { children: React.ReactNode }) {
  return <span className="flex w-2 shrink-0 justify-center">{children}</span>;
}

export function AgentStateLabel({ agent }: { agent: WorkspaceAgent }) {
  const word = stateWord(agent.state);
  if (agent.state === 'stopped') return <Badge variant="destructive">{word}</Badge>;
  if (agent.state === 'waiting')
    return (
      <Badge variant="secondary" className="bg-warning-soft text-warning">
        {word}
      </Badge>
    );
  return <Badge variant="secondary">{word}</Badge>;
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
 * ONE declared effect's disclosure — TASK-329.
 *
 * One badge per member, never a merged one. A row declares a SET (TASK-330)
 * and `web_extract` is the first to carry two: it spends money AND it hands
 * data to a third party. Those are different risks with separately authored
 * copy — see `EFFECT_DISCLOSURES` — so they get separate badges, and the row
 * reads as two facts because it IS two facts. A single badge summarising both
 * would be the collapse `ToolEffect`'s split exists to prevent.
 *
 * `Popover`, not `Tooltip` (D5): `Tooltip` needs a `TooltipProvider` this rail
 * does not have, is hover-only, and auto-dismisses — unreliable on touch and
 * awkward for assistive tech. `TheirDescription` above already puts its
 * explanatory affordance behind a `Popover` for the same reason, and this
 * follows that structure closely on purpose.
 *
 * The trigger is a real `<button>` wearing `badgeVariants` rather than the
 * `Badge` component (D6). `Badge` renders a `<div>`, and `PermissionLine`'s
 * content sits inside a `<span>` — a `div` there is invalid nesting, and a
 * `PopoverTrigger asChild` over a non-interactive `div` is not a
 * keyboard-reachable control. Applying the exported `badgeVariants` to a
 * `<button>` is shadcn's own documented escape hatch for exactly this. Layout
 * classes shrink the badge to the rail's micro-type (the badge's base class
 * sets `text-xs`; the rail runs `text-[10.5px]`/`text-[11px]`) — that override
 * is type-scale and padding only, never colour.
 *
 * `variant="outline"` plus `text-muted-foreground`, explicitly NOT
 * `variant="destructive"`. A red badge would out-shout the verdict glyph to
 * its left, which is the more important claim on this row ("can it run at
 * all"), and a cost is not a danger — painting it in the same red as "Never"
 * would tell a scanning reader the wrong thing about which fact matters more.
 * Hierarchy stays glyph > badge > the muted `source` id that follows it.
 *
 * The badge is a CLAIM, not decoration, so it stays in the a11y tree —
 * `aria-label` carries the standalone clause (the visible label alone,
 * "Costs money", reads as a floating fragment to a screen reader that has not
 * also seen the row's icon and clause).
 */
function EffectMark({ effect }: { effect: CapabilityEffect }) {
  const d = effectDisclosure(effect);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${d.srLabel} Details.`}
          className={cn(
            badgeVariants({ variant: 'outline' }),
            'ml-1.5 px-1.5 py-0 text-[10.5px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          {d.label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="text-[12.5px] text-muted-foreground">{d.detail}</p>
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
    ? frameCapability({
        verdict: row.verdict,
        capability: row.capability,
        conditional: row.conditional,
      })
    : { ...verdictFrame(row.verdict, row.conditional), clause: null };
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
          EVERY declared effect, one badge each, in the rule's order — a row
          that draws only the first of two understates its own reach, which is
          the one direction design H4 forbids, and it is exactly how
          `web_extract`'s outward half stayed invisible before TASK-330.

          The suppression rule is `disclosedEffects`, NOT a condition written
          out here — it carries the reasoning, and it lives beside the copy in
          `permission-frames.ts` so a second renderer that takes
          `effectDisclosure` takes the rule with it rather than printing
          "Cannot pay an invoice — Costs money". It also does the filtering, so
          there is deliberately no `.filter()` or emptiness check at this call
          site: a render site re-testing half the rule is a copy of the rule
          that nothing tests. An empty list maps to nothing and needs no guard.

          `key` is the effect name because the set is deduped at the wire
          boundary (`toWireEffects`), so a member appears at most once per row.
        */}
        {disclosedEffects(row.verdict, row.effect).map((effect) => (
          <EffectMark key={effect} effect={effect} />
        ))}
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
        <span className="ml-1.5 break-all font-mono text-[10.5px] text-muted-foreground">
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
  // Never conditional: a grant is a thing a person did, not a rule with a
  // predicate over a call's arguments. It applies to every call or it does not
  // exist.
  const frame = verdictFrame(row.verdict, false);
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
          <span className="ml-1.5 text-[11px] text-muted-foreground">
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

/**
 * The workspace surface's one section heading — "Right now", "Granted by you",
 * "Previous conversations", the Memory tiers, the Files shelves.
 *
 * AN `h3`, NOT A `div` (TASK-446). Every use of this sits one level inside a
 * region that `AgentView` heads with an `h2` — a tab panel or the rail — so the
 * level is fixed by where the component is allowed to appear, not guessed per
 * call site. That is also why there is no `level` prop: a caller free to pick
 * its own number is how a tree acquires an `h2` that skips to an `h4`, and the
 * one honest alternative (a context-derived level) would be machinery for a
 * surface that has exactly one depth.
 *
 * The typography is unchanged — Tailwind's preflight strips the browser's
 * heading font-size, weight and margin, so this renders byte-for-byte as it
 * did as a `div`.
 */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2.5 mt-6 text-[11.5px] font-medium text-muted-foreground first:mt-0">
      {children}
    </h3>
  );
}

/**
 * What a surface says when a read came back with no rows to show.
 *
 * TWO sentences for two different facts, because a reader can act on the
 * difference: nothing to read FROM, versus something that would not answer.
 * Neither is ever drawn as an empty list — on this surface an empty list is a
 * claim, and a claim we cannot support is the bug (`WorkspaceReadStatus`).
 *
 * IT LIVES HERE, SHARED, ON PURPOSE. It started local to `AgentRail`; the
 * Memory tab then needed the same two facts and TASK-417 nearly wrote a third
 * wording for them. `decision-copy.ts` argues at length against sharing strings
 * between surfaces that know DIFFERENT things, and that argument stands — but
 * these two surfaces know the SAME thing, and `what` is the only part that
 * varies. Three phrasings of one fact teaches a reader that the difference
 * between them means something.
 *
 * `status: 'ok'` cannot reach here: a caller with rows renders rows.
 */
export function ReadFailure({
  status,
  what,
  className = 'text-[13px]',
}: {
  status: Exclude<WorkspaceReadStatus, 'ok'>;
  /** The thing we cannot show, as a noun phrase: "what Quill works out". */
  what: string;
  /** The caller's own type scale. The words are shared; the size is not. */
  className?: string;
}) {
  return (
    <p className={cn('leading-relaxed text-muted-foreground', className)}>
      {status === 'unavailable' ? (
        <>
          This deployment doesn&apos;t keep {what}, so there&apos;s nothing to
          show.
        </>
      ) : (
        <>
          We couldn&apos;t read {what} just now. Treat this as unknown rather
          than empty, and try reloading.
        </>
      )}
    </p>
  );
}
