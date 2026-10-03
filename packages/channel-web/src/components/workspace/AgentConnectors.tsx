/**
 * The agent's connector list (TASK-739, connectors-rail slice 6).
 *
 * "Connectors <n>", then one card of rows. A row is the connector's name and a
 * `⋯` menu — nothing else (product owner's call: no icon tiles, no tool-count
 * subtitle). The menu holds what is wired today:
 *
 *   - **Edit connector** — the same editor Settings › Connectors opens, for a
 *     connector this person may edit. Hidden otherwise rather than drawn and
 *     refused.
 *   - **Remove from <agent>** — destructive, behind a confirmation. Removing
 *     touches THIS agent only: the connector, and every other agent using it,
 *     stay as they are.
 *     A workspace default on a team agent is the owner's or an admin's to
 *     remove (TASK-765): for anyone else the server says `removable: false`
 *     and the item stays, disabled, with the reason on hover and focus.
 *
 * Connector health (TASK-741, slice 8): a row whose sign-in was rejected or
 * whose server could not be reached gets ONE red `CircleAlert` right after its
 * name — no inline error text (product owner's call). The reason ("Sign-in
 * expired" / "Can’t reach it") is the icon's accessible name and its tooltip,
 * which opens on hover AND keyboard focus. The fix sits at the top of the
 * `⋯` menu, on errored rows only: **Reconnect** (sign in again, in a dialog
 * around the same OAuth widget Settings uses) or **Retry** (one fresh check).
 * Health is read from stored state; drawing the list never probes anything.
 *
 * A connector a session cannot fully load (TASK-745 — e.g. two of its servers
 * share a name) wears the same icon, reason "Couldn’t load it". Reconnect and
 * Retry cannot fix that, so neither is offered; the tooltip points at the fix
 * this person has: Edit connector, or asking a workspace admin.
 *
 * "+ Add" and the empty state's "Add connector" (TASK-740) open the Add
 * subview (`AddConnector`); the Connectors tab swaps it in for this list.
 *
 * **View details** (TASK-742) opens the in-rail details subview with per-tool
 * Allow / Ask first / Deny (`ConnectorDetails`). Which connector is open is
 * the tab's state (`viewing`), because the subview replaces the whole tab,
 * "Other abilities" included. The subview's `⋯` is this same menu (minus View
 * details), so Reconnect / Retry are there too — and the dialogs stay mounted
 * across the switch, so a sign-in started from either view is never cut off.
 */
import { Fragment, useEffect, useId, useState } from 'react';
import {
  CircleAlert,
  Info,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import { ConnectorEditDialog } from '@/components/settings/ConnectorEditDialog';
import { ConnectorOAuthConnect } from '@/components/settings/ConnectorOAuthConnect';
import { useAgentConnectors } from '@/lib/agent-connectors';
import { getConnector, type Connector } from '@/lib/connectors';
import { useUser } from '@/lib/user-context';
import type { GrantRow } from '@/lib/workspace-api';
import type { AgentConnectorHealth, AgentConnectorRow } from '@/lib/workspace-types';
import { ConnectorDetails, ConnectorsUnsupported, REMOVE_REFUSED_REASON } from './ConnectorDetails';

/** Why a row wears the error icon — its accessible name and its tooltip. */
const HEALTH_REASON: Record<Exclude<AgentConnectorHealth, 'ok' | 'not-loaded'>, string> = {
  'needs-reconnect': 'Your sign-in expired',
  unreachable: 'Can’t reach it',
};

function healthReason(row: AgentConnectorRow): string {
  if (row.health === 'not-loaded') {
    return row.editable
      ? 'Couldn’t load it. Choose Edit connector to fix it.'
      : 'Couldn’t load it. Ask a workspace admin to fix it.';
  }
  // TASK-756 — a team agent's shared sign-in is the team's, not this person's.
  if (row.health === 'needs-reconnect' && row.sharedSignIn === true) return 'Team sign-in expired';
  return row.health === 'ok' ? '' : HEALTH_REASON[row.health];
}

interface Props {
  agentId: string;
  /** The agent's display name — "Remove from <agent>". */
  name: string;
  /** Called after a remove lands, so the rest of the rail re-reads. */
  onChanged?: () => void;
  /** "+ Add" / "Add connector" — open the Add subview (TASK-740). */
  onAdd?: () => void;
  /** The connector whose details are open, or null for the list (TASK-742). */
  viewing?: string | null;
  onView?: (connectorId: string | null) => void;
  /** Approved-access rows; the details view shows the ones for its connector. */
  grants?: GrantRow[];
  /**
   * TASK-757 — the approved-access read failed, so `grants` is empty for
   * want of an answer, not because there is none. The details view says so.
   */
  grantsFailed?: boolean;
  revoking?: ReadonlySet<string>;
  onRevoke?: (row: GrantRow) => void;
  /** The ids currently listed, or null while unknown — so the tab can tell
   *  which approved access has a details view to live in. */
  onListed?: (ids: ReadonlySet<string> | null) => void;
}

const NO_GRANTS: GrantRow[] = [];
const NOTHING: ReadonlySet<string> = new Set();

export function AgentConnectors({
  agentId,
  name,
  onChanged,
  onAdd,
  viewing = null,
  onView,
  grants = NO_GRANTS,
  grantsFailed = false,
  revoking = NOTHING,
  onRevoke,
  onListed,
}: Props) {
  const {
    connectors,
    status,
    removing,
    remove,
    shared,
    connectorsSupported,
    retrying,
    retry,
    refresh,
  } = useAgentConnectors(agentId);
  // TASK-761 — an agent whose model gets no connector tools (aisdk) is not
  // offered Add: setting up access it can't use would only mislead.
  const addable = connectorsSupported ? onAdd : undefined;
  const isAdmin = useUser()?.role === 'admin';
  const [confirming, setConfirming] = useState<AgentConnectorRow | null>(null);
  const [notice, setNotice] = useState<
    { tone: 'error' | 'note'; text: string } | null
  >(null);
  const [editing, setEditing] = useState<Connector | null>(null);
  const [reconnecting, setReconnecting] = useState<AgentConnectorRow | null>(null);

  async function onRetry(row: AgentConnectorRow) {
    setNotice(null);
    const outcome = await retry(row.id);
    if (outcome === 'failed') {
      setNotice({
        tone: 'error',
        text: `We couldn’t check ${row.name} just now. Please try again.`,
      });
      return;
    }
    if (outcome === 'unreachable') {
      setNotice({
        tone: 'note',
        text: `Still can’t reach ${row.name}. It may be down for a bit — try again later.`,
      });
      return;
    }
    if (outcome === 'needs-reconnect') {
      setNotice({
        tone: 'note',
        text: `${row.name} is reachable, but its sign-in expired. Choose Reconnect to sign in again.`,
      });
    }
  }

  async function onRemove(row: AgentConnectorRow) {
    setConfirming(null);
    setNotice(null);
    const outcome = await remove(row.id);
    if (outcome === 'failed') {
      setNotice({
        tone: 'error',
        text: `We couldn’t remove ${row.name} just now. Nothing changed.`,
      });
      return;
    }
    if (outcome === 'removed-partial') {
      setNotice({
        tone: 'note',
        text: `Removed ${row.name}. Some of what you’d approved for it couldn’t be cleared just now — it no longer applies while ${row.name} is off this agent.`,
      });
    }
    onChanged?.();
  }

  async function onEdit(row: AgentConnectorRow) {
    setNotice(null);
    try {
      setEditing(
        await getConnector(row.id, isAdmin ? '/admin/connectors' : '/settings/connectors'),
      );
    } catch {
      setNotice({
        tone: 'error',
        text: `We couldn’t open ${row.name} just now. Please try again.`,
      });
    }
  }

  const count = status === 'ok' && connectors !== null ? connectors.length : null;

  useEffect(() => {
    onListed?.(
      status === 'ok' && connectors !== null ? new Set(connectors.map((c) => c.id)) : null,
    );
  }, [status, connectors, onListed]);

  // The open connector, once the list has it. A connector that left the list
  // (removed here, or elsewhere) closes its details rather than showing a
  // view of something the agent no longer has.
  const open =
    viewing === null || connectors === null
      ? null
      : (connectors.find((c) => c.id === viewing) ?? null);
  const gone = viewing !== null && status === 'ok' && connectors !== null && open === null;
  useEffect(() => {
    if (gone) onView?.(null);
  }, [gone, onView]);

  /** One row's `⋯` menu — the list's and the details view's are the same. */
  const menuFor = (row: AgentConnectorRow, withView: boolean) => (
    <RowMenu
      row={row}
      agentName={name}
      busy={removing.has(row.id) || retrying.has(row.id)}
      onReconnect={() => {
        setNotice(null);
        setReconnecting(row);
      }}
      onRetry={() => void onRetry(row)}
      {...(withView && onView !== undefined ? { onView: () => onView(row.id) } : {})}
      onEdit={() => void onEdit(row)}
      onRemove={() => setConfirming(row)}
    />
  );

  return (
    <>
      {open !== null ? (
        <ConnectorDetails
          // A different connector is a different view: start it fresh.
          key={open.id}
          agentId={agentId}
          agentName={name}
          row={open}
          grants={grants.filter(
            (g) => g.grantedFor?.kind === 'connection' && g.grantedFor.id === open.id,
          )}
          grantsFailed={grantsFailed}
          revoking={revoking}
          onRevoke={(g) => onRevoke?.(g)}
          busy={removing.has(open.id)}
          menu={menuFor(open, false)}
          {...(connectorsSupported ? {} : { unsupported: true })}
          onBack={() => onView?.(null)}
          onEdit={() => void onEdit(open)}
          onRemove={() => setConfirming(open)}
        />
      ) : (
      <>
      <ConnectorsHeader count={count} onAdd={addable} />
      {status === 'ok' && !connectorsSupported && <ConnectorsUnsupported name={name} />}
      {status === 'loading' && (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}
      {(status === 'failed' || status === 'unavailable') && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {status === 'unavailable'
            ? 'This workspace can’t list connectors yet.'
            : `We couldn’t read ${name}’s connectors just now. Treat them as unknown rather than none.`}
        </p>
      )}
      {status === 'ok' && connectorsSupported && connectors !== null && connectors.length === 0 && (
        <NoConnectors name={name} onAdd={addable} />
      )}
      {status === 'ok' && connectors !== null && connectors.length > 0 && (
        <Card className="shadow-none">
          {connectors.map((row, i) => (
            <Fragment key={row.id}>
              {i > 0 && <Separator />}
              <div className="flex h-11 items-center gap-2 pl-3 pr-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="min-w-0 truncate text-[13px]">{row.name}</span>
                  {row.health !== 'ok' && <HealthIcon reason={healthReason(row)} />}
                </div>
                {menuFor(row, true)}
              </div>
            </Fragment>
          ))}
        </Card>
      )}
      </>
      )}
      {notice !== null && (
        notice.tone === 'error' ? (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        ) : (
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            {notice.text}
          </p>
        )
      )}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Remove {confirming?.name} from {name}?
            </DialogTitle>
            <DialogDescription>
              {name} won’t be able to use {confirming?.name} any more, and
              anything you approved for it here is taken back. The connector
              itself stays, and so do your other agents that use it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirming !== null) void onRemove(confirming);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={reconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setReconnecting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconnect {reconnecting?.name}</DialogTitle>
            <DialogDescription>
              {reconnecting?.sharedSignIn === true ? (
                <>
                  The team sign-in to {reconnecting.name} expired. Sign in again and
                  everyone using {name} can keep using it.
                </>
              ) : (
                <>
                  Your sign-in to {reconnecting?.name} expired. Sign in again and{' '}
                  {name} can keep using it.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {/* What signing in hands the assistant — drawn here, in the file that
              starts the sign-in, so the TASK-700 coverage scan sees it. */}
          <ConnectorAccessNotice kind="sign-in" />
          {reconnecting !== null && (
            <ConnectorOAuthConnect
              connectorId={reconnecting.id}
              serviceName={reconnecting.name}
              agentId={agentId}
              requiresConsent={shared}
              showAccessNotice={false}
              onConnected={() => {
                setReconnecting(null);
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {editing !== null && (
        <ConnectorEditDialog
          target={editing}
          open
          isAdmin={isAdmin}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

/** "Connectors <n>" and "+ Add" (TASK-740). */
function ConnectorsHeader({
  count,
  onAdd,
}: {
  count: number | null;
  onAdd: (() => void) | undefined;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-1.5">
      <h3 className="flex flex-1 items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
        Connectors
        {count !== null && count > 0 && (
          <span className="tabular-nums">{count}</span>
        )}
      </h3>
      {onAdd !== undefined && count !== null && count > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onAdd}
          className="-my-1 h-7 gap-1 px-2 text-[12px]"
        >
          <Plus aria-hidden="true" />
          Add
        </Button>
      )}
    </div>
  );
}

function NoConnectors({
  name,
  onAdd,
}: {
  name: string;
  onAdd: (() => void) | undefined;
}) {
  return (
    <Empty className="border border-dashed p-5 md:p-5">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Plug aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-[13px]">No connectors yet</EmptyTitle>
        <EmptyDescription className="text-[12px]">
          Connect a tool like Linear or Gmail and {name} can work in it for you.
        </EmptyDescription>
      </EmptyHeader>
      {onAdd !== undefined && (
        <EmptyContent>
          <Button type="button" size="sm" onClick={onAdd}>
            Add connector
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

/**
 * The error icon after an errored row's name. A real `<button>` so keyboard
 * users reach it and the tooltip opens on focus as well as hover; its
 * accessible name IS the reason, so a screen reader hears it without the
 * tooltip. Clicking it does nothing on its own — the fix lives in the `⋯`
 * menu. Standard tooltip colours (product owner's call); only the icon is red.
 */
function HealthIcon({ reason }: { reason: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={reason}
            className="inline-flex shrink-0 rounded-sm text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CircleAlert aria-hidden="true" className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function RowMenu({
  row,
  agentName,
  busy,
  onReconnect,
  onRetry,
  onView,
  onEdit,
  onRemove,
}: {
  row: AgentConnectorRow;
  agentName: string;
  busy: boolean;
  onReconnect: () => void;
  onRetry: () => void;
  /** Absent inside the details view itself. */
  onView?: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const refusedReasonId = useId();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={busy}
          aria-label={`Actions for ${row.name}`}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="shadow-popover">
        {(row.health === 'needs-reconnect' || row.health === 'unreachable') && (
          <>
            <DropdownMenuGroup>
              {row.health === 'needs-reconnect' ? (
                <DropdownMenuItem onSelect={onReconnect}>
                  <LogIn aria-hidden="true" />
                  Reconnect
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={onRetry}>
                  <RotateCw aria-hidden="true" />
                  Retry
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {onView !== undefined && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={onView}>
                <Info aria-hidden="true" />
                View details
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {!row.editable && <DropdownMenuSeparator />}
          </>
        )}
        {row.editable && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil aria-hidden="true" />
                Edit connector
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          {row.removable ? (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={onRemove}
            >
              <Trash2 aria-hidden="true" />
              Remove from {agentName}
            </DropdownMenuItem>
          ) : (
            // TASK-765 — not Radix's `disabled`: that drops the item from
            // keyboard navigation and pointer events, so the reason could
            // never be reached. Focusable + aria-disabled + a no-op select.
            // TASK-768 — the reason is wired with aria-describedby to a
            // `hidden` node (aria-description is read unevenly by VoiceOver).
            <>
            <span id={refusedReasonId} hidden>
              {REMOVE_REFUSED_REASON}
            </span>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    aria-disabled="true"
                    aria-describedby={refusedReasonId}
                    className="cursor-not-allowed text-muted-foreground focus:text-muted-foreground"
                    onSelect={(e) => e.preventDefault()}
                  >
                    <Trash2 aria-hidden="true" />
                    Remove from {agentName}
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left">{REMOVE_REFUSED_REASON}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            </>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
