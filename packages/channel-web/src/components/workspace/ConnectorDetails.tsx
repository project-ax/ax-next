/**
 * One connector, in the rail (TASK-742, connectors-rail slice 9; Figma frame 3).
 *
 * "‹ Connectors" back + `⋯`, the connector's name and whether it answered,
 * then "What <agent> may do · N tools": every tool with an Allow / Ask first /
 * Deny segmented control, grouped "Looks things up" / "Makes changes".
 * "Edit connector" + "Remove" stay pinned at the bottom while the list scrolls.
 *
 * WHAT THE CONTROL CAN DO. It writes this agent's own choice through
 * `PUT …/tool-verdicts`, and the store refuses anything looser than the
 * admin's default for that tool (the ceiling). Those segments are drawn
 * disabled with the reason in a tooltip — focusable rather than `disabled`, so
 * the reason reaches a keyboard and a screen reader too. Never optimistic: the
 * selected segment is what the server re-read.
 *
 * SECURITY — a tool's title comes from the connector's server, not from us.
 * It is fenced server-side and rendered as React text only. Its self-described
 * hints only pick the group a row sits in, never what it may do. Its free-text
 * description is deliberately not drawn here (the editor in Settings shows it,
 * fenced); the rail is too narrow to set it apart as "their words".
 */
import { Fragment, useState } from 'react';
import {
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  KeyRound,
  Loader2,
  LogIn,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { TOOL_VERDICT_OPTIONS } from '@/components/settings/ConnectorToolPermissions';
import {
  ceilingReason,
  groupTools,
  useConnectorTools,
  type ConnectorToolsState,
} from '@/lib/agent-connector-tools';
import { cn } from '@/lib/utils';
import type { GrantRow } from '@/lib/workspace-api';
import type {
  AgentConnectorHealth,
  AgentConnectorRow,
  AgentConnectorSetup,
  AgentConnectorTool,
  AgentConnectorToolsRead,
  AgentToolVerdict,
} from '@/lib/workspace-types';
import { GrantLine, ReadFailure } from './bits';

/**
 * TASK-795 — the word for a `needs-sign-in` connector, by the setup it needs.
 * The list's neutral icon and this view's connection line say the same thing.
 */
export const SETUP_REASON: Record<AgentConnectorSetup, string> = {
  'sign-in': 'Not signed in yet',
  'add-key': 'No key added yet',
  'ask-admin': 'Needs a key from a workspace admin',
  // TASK-798 — a team agent's sign-in is its owner's (or an admin's) to make.
  'ask-owner': 'Ask the agent’s owner to sign in',
};

/** An older server may send `needs-sign-in` without a setup: no action then. */
export const SETUP_UNKNOWN_REASON = 'Not set up yet';

/** Decision 3: an unattended run cannot stop to ask, so it waits. */
export const ROUTINES_WAIT_NOTE = 'With Ask first, routines pause and wait for you.';

interface Props {
  agentId: string;
  /** The agent's display name — "What <agent> may do". */
  agentName: string;
  row: AgentConnectorRow;
  /** Approved access whose subject is THIS connector, with Revoke. */
  grants: GrantRow[];
  /** TASK-757 — the approved-access read failed: say so, don't hide it. */
  grantsFailed?: boolean;
  revoking: ReadonlySet<string>;
  onRevoke: (row: GrantRow) => void;
  busy: boolean;
  /** The row's `⋯` menu, shared with the list so the two never disagree. */
  menu: React.ReactNode;
  onBack: () => void;
  onEdit: () => void;
  onRemove: () => void;
  /** TASK-761 — this agent's model gets no connector tools (aisdk). */
  unsupported?: boolean;
  /**
   * TASK-795 — Sign in / Add key for a `needs-sign-in` row: the same dialogs
   * the `⋯` menu opens.
   */
  onSetUp?: () => void;
}

/**
 * TASK-761 — this agent's model gets no connector tools (the aisdk runner
 * doesn't load them, by design). Said plainly, once, above whatever is
 * listed, so nobody sets permissions that can't apply.
 */
export function ConnectorsUnsupported({ name }: { name: string }) {
  return (
    <Alert className="mb-3" data-testid="connectors-unsupported">
      <AlertDescription className="text-[12.5px]">
        {name}’s model can’t use connectors yet, so nothing here applies to {name} for
        now.
      </AlertDescription>
    </Alert>
  );
}

export function ConnectorDetails({
  agentId,
  agentName,
  row,
  grants,
  grantsFailed = false,
  revoking,
  onRevoke,
  busy,
  menu,
  onBack,
  onEdit,
  onRemove,
  unsupported = false,
  onSetUp,
}: Props) {
  const state = useConnectorTools(agentId, row.id);
  const { data, status } = state;
  return (
    <div className="flex min-h-full flex-col">
      <div className="-ml-2 mb-3 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-[13px] text-muted-foreground"
          onClick={onBack}
        >
          <ChevronLeft data-icon="inline-start" aria-hidden="true" />
          Connectors
        </Button>
        {menu}
      </div>
      <h3 className="truncate text-base font-semibold">{row.name}</h3>
      {row.health === 'needs-sign-in' ? (
        <SetupLine setup={row.setup} onSetUp={onSetUp} />
      ) : (
        <ConnectionLine data={data} health={row.health} />
      )}
      {unsupported && (
        <div className="mt-4">
          <ConnectorsUnsupported name={agentName} />
        </div>
      )}

      <div className="mt-5 flex-1">
        {status === 'loading' && (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        {(status === 'failed' || status === 'unavailable') && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {status === 'unavailable'
                ? 'This workspace can’t set what each tool may do yet.'
                : `We couldn’t read what ${agentName} may do with ${row.name} just now.`}
            </p>
            {status === 'failed' && (
              <Button type="button" variant="outline" size="sm" onClick={() => state.reload()}>
                Try again
              </Button>
            )}
          </div>
        )}
        {status === 'ok' && data !== null && (
          <ToolList
            agentName={agentName}
            data={data}
            state={state}
            notSetUp={row.health === 'needs-sign-in'}
          />
        )}
        {(grants.length > 0 || grantsFailed) && (
          <section aria-label="Access you approved" className="mt-6">
            <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">
              Access you approved
            </h4>
            {grantsFailed && (
              <ReadFailure
                status="failed"
                what={`the access you approved for ${row.name}`}
                className="text-[12.5px]"
              />
            )}
            {grants.map((g, i) => (
              <GrantLine
                key={`${g.source}#${String(i)}`}
                row={g}
                busy={revoking.has(g.source)}
                onRevoke={onRevoke}
              />
            ))}
          </section>
        )}
      </div>

      {/*
        Pinned: the tool list can be long, and these two should not scroll
        away with it. Sticky inside the rail's own scroll area, on the page
        background so rows passing under it don't show through.

        TASK-761 — that scroll area has `pb-5`, and a sticky box stops at the
        scroller's padding edge, so `bottom-0` pinned this 20px ABOVE the
        rail's bottom and rows scrolled past underneath it (measured on the
        TASK-743 walk). `-bottom-5` + `-mb-5` put its edge on the rail's edge
        in both the scrolling and the short case; `pb-8` (py-3 + those 20px)
        paints the strip; `z-10` keeps the segmented controls' focus layer
        under it. Keep the 5s in step with the rail scroller's padding.

        TASK-798 — with neither action to offer, there is no footer at all
        rather than an empty strip.
      */}
      {(row.editable || row.removable) && (
      <div
        data-testid="connector-details-footer"
        className="sticky -bottom-5 z-10 -mx-1 -mb-5 mt-4 flex items-center justify-between gap-2 border-t border-border bg-background px-1 pb-8 pt-3"
      >
        {row.editable ? (
          <Button type="button" variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <Pencil data-icon="inline-start" aria-hidden="true" />
            Edit connector
          </Button>
        ) : (
          <span />
        )}
        {/* TASK-798 — hidden, not drawn disabled, for anyone who may not
            remove it (on a team agent: not its owner, not an admin). */}
        {row.removable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive-soft hover:text-destructive"
            onClick={onRemove}
            disabled={busy}
          >
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            Remove
          </Button>
        )}
      </div>
      )}
    </div>
  );
}

/**
 * "Connected · signed in as you". Only what we know: the row's stored health
 * (the same word the list's error icon uses), else the last time we asked the
 * connector for its tools; "as you" is said only for a connector that acts
 * with the person's own access.
 */
function ConnectionLine({
  data,
  health,
}: {
  data: AgentConnectorToolsRead | null;
  health: AgentConnectorHealth;
}) {
  if (data === null) return null;
  // The list's health word wins (TASK-741): only the sign-in marker can say a
  // sign-in EXPIRED — a tool list answering needs-auth may just mean nobody
  // has signed in yet.
  const ok = data.status === 'ok' && health === 'ok';
  // TASK-745 — a connector a session can't fully load says so here too,
  // rather than "Connected" in red.
  const word =
    health === 'not-loaded'
      ? 'Couldn’t load it'
      : health === 'needs-reconnect'
      ? 'Sign-in expired'
      : health === 'unreachable'
        ? 'Can’t reach it'
        : data.status === 'ok'
      ? 'Connected'
      : data.status === 'needs-auth'
        ? 'Sign-in needed'
        : data.status === 'unreachable'
          ? 'Can’t reach it'
          : 'We can’t check this one from here';
  const who = data.connector.access === 'workspace' ? 'uses your workspace’s account' : 'signed in as you';
  const Icon = ok ? CircleCheck : CircleAlert;
  return (
    <p
      className={cn(
        'mt-0.5 flex items-center gap-1 text-[12px]',
        ok || (health === 'ok' && data.status === 'unknown')
          ? 'text-muted-foreground'
          : 'text-destructive',
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        {word}
        {ok && ` · ${who}`}
      </span>
    </p>
  );
}

/**
 * TASK-795 — nobody has set this connector up yet. Muted, not red: nothing is
 * broken. The button is the same first-time setup the `⋯` menu leads with;
 * `ask-admin` has none (only a workspace admin can add that key), and nor
 * does `ask-owner` (TASK-798: only the team agent's owner or an admin can
 * sign in on it).
 */
function SetupLine({
  setup,
  onSetUp,
}: {
  setup: AgentConnectorSetup | undefined;
  onSetUp: (() => void) | undefined;
}) {
  const action =
    setup === 'sign-in' ? 'Sign in' : setup === 'add-key' ? 'Add key' : null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <p className="flex items-center gap-1 text-[12px] text-muted-foreground">
        <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        <span>{setup !== undefined ? SETUP_REASON[setup] : SETUP_UNKNOWN_REASON}</span>
      </p>
      {action !== null && onSetUp !== undefined && (
        <Button type="button" variant="outline" size="sm" className="h-7 text-[12px]" onClick={onSetUp}>
          {setup === 'sign-in' ? (
            <LogIn data-icon="inline-start" aria-hidden="true" />
          ) : (
            <KeyRound data-icon="inline-start" aria-hidden="true" />
          )}
          {action}
        </Button>
      )}
    </div>
  );
}

function unavailableText(data: AgentConnectorToolsRead, notSetUp: boolean): string | null {
  switch (data.status) {
    case 'needs-auth':
      // TASK-795 — "again" is wrong for someone who never signed in.
      return notSetUp
        ? 'Once it’s set up, all of its tools show here.'
        : 'Sign in to this connector again to see all of its tools.';
    case 'unreachable':
      return 'We couldn’t reach this connector to list its tools.';
    case 'unknown':
      return 'We can’t list this connector’s tools from here.';
    case 'ok':
      return data.tools.length === 0 ? 'This connector didn’t list any tools.' : null;
  }
}

function ToolList({
  agentName,
  data,
  state,
  notSetUp = false,
}: {
  agentName: string;
  data: AgentConnectorToolsRead;
  state: ConnectorToolsState;
  /** TASK-795 — the row is `needs-sign-in`: nobody has set it up yet. */
  notSetUp?: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  // TASK-757 — the save landed but we couldn't read it back. Soft, not red:
  // nothing went wrong with the change itself.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const groups = groupTools(data.tools);
  const missing = unavailableText(data, notSetUp);

  async function change(tool: AgentConnectorTool, verdict: AgentToolVerdict) {
    setNotice(null);
    setUnconfirmed(false);
    const outcome = await state.setVerdict(tool.toolKey, verdict);
    if (outcome === 'saved-unconfirmed') setUnconfirmed(true);
    if (outcome === 'failed') setNotice('We couldn’t change that just now. Nothing changed.');
    if (outcome === 'refused')
      setNotice(
        `That choice isn’t available for ${tool.title} any more, so it wasn’t saved. What’s shown is what’s set now.`,
      );
  }

  return (
    <>
      <h4 className="flex items-baseline gap-1.5 text-[13px] font-medium">
        What {agentName} may do
        <span className="text-[12px] font-normal text-muted-foreground tabular-nums">
          {data.tools.length === 1 ? '1 tool' : `${String(data.tools.length)} tools`}
        </span>
      </h4>
      <ul
        aria-label="What each choice means"
        className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground"
      >
        {TOOL_VERDICT_OPTIONS.map(({ value, label, Icon }) => (
          <li key={value} className="flex items-center gap-1">
            <Icon aria-hidden="true" className="size-3.5" />
            {label}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11.5px] text-muted-foreground">{ROUTINES_WAIT_NOTE}</p>

      {missing !== null && (
        <Alert className="mt-3">
          <AlertDescription className="flex flex-col items-start gap-2 text-[12.5px]">
            <p>{missing}</p>
            {data.status === 'unreachable' && (
              <Button type="button" variant="outline" size="sm" onClick={() => state.reload(true)}>
                Check again
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {data.status === 'ok' && data.possiblyIncomplete && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          Part of this connector can’t be listed from here, so some of its tools may be
          missing. Any it uses that aren’t listed ask you first unless your admin chose
          otherwise.
        </p>
      )}
      {notice !== null && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {unconfirmed && (
        <Alert className="mt-3" data-testid="verdict-unconfirmed">
          <AlertDescription className="text-[12.5px]">
            Saved. We couldn’t refresh this list just now, so reload to confirm.
          </AlertDescription>
        </Alert>
      )}

      <TooltipProvider delayDuration={200}>
        <ToolGroup
          label="Looks things up"
          tools={groups.looksUp}
          pending={state.pending}
          onChange={change}
        />
        <ToolGroup
          label="Makes changes"
          caption={
            groups.makesChanges.some((t) => t.outward === true)
              ? 'Others may see these'
              : undefined
          }
          tools={groups.makesChanges}
          pending={state.pending}
          onChange={change}
        />
      </TooltipProvider>
    </>
  );
}

function ToolGroup({
  label,
  caption,
  tools,
  pending,
  onChange,
}: {
  label: string;
  caption?: string | undefined;
  tools: AgentConnectorTool[];
  pending: ReadonlySet<string>;
  onChange: (tool: AgentConnectorTool, verdict: AgentToolVerdict) => void;
}) {
  if (tools.length === 0) return null;
  return (
    <section aria-label={label} className="mt-4">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h5 className="text-[12px] font-medium text-muted-foreground">{label}</h5>
        {caption !== undefined && (
          <span className="text-[11.5px] text-muted-foreground">{caption}</span>
        )}
      </div>
      <Card className="shadow-none">
        <ul>
          {tools.map((tool, i) => (
            <Fragment key={tool.toolKey}>
              {i > 0 && <Separator />}
              <ToolRow
                tool={tool}
                busy={pending.has(tool.toolKey)}
                onChange={(v) => onChange(tool, v)}
              />
            </Fragment>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function ToolRow({
  tool,
  busy,
  onChange,
}: {
  tool: AgentConnectorTool;
  busy: boolean;
  onChange: (verdict: AgentToolVerdict) => void;
}) {
  return (
    <li className="flex min-h-10 items-center gap-2 py-1 pl-3 pr-1.5">
      <span className="min-w-0 flex-1 truncate text-[13px]" title={tool.title}>
        {tool.title}
      </span>
      {busy && (
        <Loader2
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      )}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        className="shrink-0 gap-0.5"
        aria-label={`What it may do with ${tool.title}`}
        aria-busy={busy || undefined}
        value={tool.verdict}
        onValueChange={(value) => {
          // A single toggle group lets you press the selected item off; a tool
          // always has exactly one choice, so an empty value is ignored. So is
          // a segment the admin's ceiling rules out, and a press mid-write.
          if (!value || busy || value === tool.verdict) return;
          const verdict = value as AgentToolVerdict;
          if (ceilingReason(verdict, tool.ceiling) !== null) return;
          onChange(verdict);
        }}
      >
        {TOOL_VERDICT_OPTIONS.map(({ value, label, Icon, on }) => {
          const reason = ceilingReason(value, tool.ceiling);
          const item = (
            <ToggleGroupItem
              key={value}
              value={value}
              aria-label={label}
              aria-disabled={reason !== null || undefined}
              className={cn(
                'size-7 min-w-7 px-0',
                on,
                reason !== null && 'cursor-not-allowed opacity-40 hover:bg-transparent',
              )}
            >
              <Icon aria-hidden="true" />
            </ToggleGroupItem>
          );
          if (reason === null) return item;
          return (
            <Tooltip key={value}>
              <TooltipTrigger asChild>{item}</TooltipTrigger>
              <TooltipContent side="top">{reason}</TooltipContent>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </li>
  );
}
