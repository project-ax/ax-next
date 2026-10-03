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
 * Deliberately NOT drawn yet, because nothing behind them is wired
 * (invariant 3 — no half-wired UI):
 *
 *   - "+ Add" and the empty state's "Add connector" — slice 7 (TASK-740)
 *     builds the Add subview and puts both buttons in.
 *   - "View details" — slice 9 (TASK-742).
 *
 * The seams those slices build on: `RowMenu` takes more items above
 * "Edit connector"; `ConnectorsHeader` has room for "+ Add".
 */
import { Fragment, useState } from 'react';
import { CircleAlert, LogIn, MoreHorizontal, Pencil, Plug, RotateCw, Trash2 } from 'lucide-react';
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
import type { AgentConnectorHealth, AgentConnectorRow } from '@/lib/workspace-types';

/** Why a row wears the error icon — its accessible name and its tooltip. */
const HEALTH_REASON: Record<Exclude<AgentConnectorHealth, 'ok'>, string> = {
  'needs-reconnect': 'Sign-in expired',
  unreachable: 'Can’t reach it',
};

interface Props {
  agentId: string;
  /** The agent's display name — "Remove from <agent>". */
  name: string;
  /** Called after a remove lands, so the rest of the rail re-reads. */
  onChanged?: () => void;
}

export function AgentConnectors({ agentId, name, onChanged }: Props) {
  const { connectors, status, removing, remove, shared, retrying, retry, refresh } =
    useAgentConnectors(agentId);
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

  return (
    <>
      <ConnectorsHeader count={count} />
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
      {status === 'ok' && connectors !== null && connectors.length === 0 && (
        <NoConnectors name={name} />
      )}
      {status === 'ok' && connectors !== null && connectors.length > 0 && (
        <Card className="shadow-none">
          {connectors.map((row, i) => (
            <Fragment key={row.id}>
              {i > 0 && <Separator />}
              <div className="flex h-11 items-center gap-2 pl-3 pr-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="min-w-0 truncate text-[13px]">{row.name}</span>
                  {row.health !== 'ok' && <HealthIcon health={row.health} />}
                </div>
                <RowMenu
                  row={row}
                  agentName={name}
                  busy={removing.has(row.id) || retrying.has(row.id)}
                  onReconnect={() => {
                    setNotice(null);
                    setReconnecting(row);
                  }}
                  onRetry={() => void onRetry(row)}
                  onEdit={() => void onEdit(row)}
                  onRemove={() => setConfirming(row)}
                />
              </div>
            </Fragment>
          ))}
        </Card>
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
              Your sign-in to {reconnecting?.name} expired. Sign in again and{' '}
              {name} can keep using it.
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

/** "Connectors <n>". "+ Add" joins it in slice 7 (TASK-740). */
function ConnectorsHeader({ count }: { count: number | null }) {
  return (
    <h3 className="mb-2.5 flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
      Connectors
      {count !== null && count > 0 && (
        <span className="tabular-nums">{count}</span>
      )}
    </h3>
  );
}

function NoConnectors({ name }: { name: string }) {
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
function HealthIcon({ health }: { health: Exclude<AgentConnectorHealth, 'ok'> }) {
  const reason = HEALTH_REASON[health];
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
  onEdit,
  onRemove,
}: {
  row: AgentConnectorRow;
  agentName: string;
  busy: boolean;
  onReconnect: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
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
        {row.health !== 'ok' && (
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
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onRemove}
          >
            <Trash2 aria-hidden="true" />
            Remove from {agentName}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
