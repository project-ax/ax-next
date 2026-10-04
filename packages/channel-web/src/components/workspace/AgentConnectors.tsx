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
 * Who may change a TEAM agent's connectors (TASK-798): only the agent's owner
 * (a team admin) or a workspace admin may add or remove one. The server
 * answers `manageable` (and each row's `removable`, the same answer) and
 * enforces it; for everyone else the rail simply does not offer those actions
 * — no "+ Add", no "Add connector", no Remove.
 *
 * Who may put a credential ON a team agent (TASK-813) is narrower: only an
 * admin of the team that owns it (`sharedCredentials`) — a workspace admin
 * who is not one may still add and remove connectors, but not sign in for the
 * team. Everyone else gets no Sign in (the row's setup is `ask-owner`: "Ask
 * the agent’s owner to sign in") and no Reconnect for the team's shared
 * sign-in ("Team sign-in expired. Ask the agent’s owner to sign in again.").
 * The team's admins also get **Add team key** on a row that says `teamKey`: a
 * key stored on the agent that everyone using it uses unless they've added
 * their own (`TeamKeyDialog`). What stays everyone's: Add key (it stores their
 * own key), Sign in again for their own expired sign-in, Retry, View details,
 * and Edit for a connector they may edit.
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
 * On a team agent, Reconnect is the fix for the agent's SHARED sign-in (the
 * one every member uses — "Team sign-in expired"). When the sign-in that
 * expired is this member's OWN personal one (TASK-774: no `sharedSignIn` on
 * the row), Reconnect would sign in for the team and leave theirs expired —
 * their personal sign-in is reached first — so the menu offers **Sign in
 * again** instead, which runs a personal sign-in (no agent, so it is stored
 * for this person only). A personal agent's sign-in is always personal, and
 * its Reconnect already signs in that way, so it keeps Reconnect.
 *
 * A connector nobody has set up yet (TASK-795, health `needs-sign-in`: no
 * sign-in or key this person's use of the agent would reach) is not broken,
 * so its icon is the same `CircleAlert` in muted grey, never red. The row's
 * `setup` picks the reason and the fix: "Not signed in yet" → **Sign in** (a
 * dialog around the OAuth widget, on THIS agent — on a team agent it says
 * everyone will use it as the signer, and the widget asks first); "No key
 * added yet" → **Add key** (the Settings key dialog); "Needs a key from a
 * workspace admin" → nothing to click. Sign in / Add key lead the `⋯` menu,
 * and the details view offers the same button beside the same word. Neither
 * Retry nor Reconnect is offered: there is nothing to retry or reconnect.
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
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  CircleAlert,
  Info,
  KeyRound,
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
import { ConnectorConnectDialog } from '@/components/settings/ConnectorConnectDialog';
import { ConnectorEditDialog } from '@/components/settings/ConnectorEditDialog';
import { ConnectorOAuthConnect } from '@/components/settings/ConnectorOAuthConnect';
import { useAgentConnectors } from '@/lib/agent-connectors';
import { getConnector, type Connector } from '@/lib/connectors';
import { useUser } from '@/lib/user-context';
import type { GrantRow } from '@/lib/workspace-api';
import { cn } from '@/lib/utils';
import type {
  AgentConnectorHealth,
  AgentConnectorRow,
} from '@/lib/workspace-types';
import {
  ConnectorDetails,
  ConnectorsUnsupported,
  SETUP_REASON,
  SETUP_UNKNOWN_REASON,
} from './ConnectorDetails';
import { TeamKeyDialog } from './TeamKeyDialog';

/** Why a row wears the error icon — its accessible name and its tooltip. */
const HEALTH_REASON: Record<
  Exclude<AgentConnectorHealth, 'ok' | 'not-loaded' | 'needs-sign-in'>,
  string
> = {
  'needs-reconnect': 'Your sign-in expired',
  unreachable: 'Can’t reach it',
};

/** TASK-798 — a team agent's shared sign-in, for someone who can't redo it. */
const TEAM_SIGN_IN_ASK_OWNER = 'Team sign-in expired. Ask the agent’s owner to sign in again.';

function healthReason(row: AgentConnectorRow, sharedCredentials: boolean): string {
  if (row.health === 'needs-sign-in') {
    return row.setup !== undefined ? SETUP_REASON[row.setup] : SETUP_UNKNOWN_REASON;
  }
  if (row.health === 'not-loaded') {
    return row.editable
      ? 'Couldn’t load it. Choose Edit connector to fix it.'
      : 'Couldn’t load it. Ask a workspace admin to fix it.';
  }
  // TASK-756 — a team agent's shared sign-in is the team's, not this person's.
  // TASK-813 — only the team's admins may redo it.
  if (row.health === 'needs-reconnect' && row.sharedSignIn === true) {
    return sharedCredentials ? 'Team sign-in expired' : TEAM_SIGN_IN_ASK_OWNER;
  }
  return row.health === 'ok' ? '' : HEALTH_REASON[row.health];
}

/**
 * TASK-774 — a team agent's row whose expired sign-in is this person's OWN.
 * Its fix is a personal sign-in ("Sign in again"), never Reconnect.
 */
function personalExpiry(row: AgentConnectorRow, teamAgent: boolean): boolean {
  return teamAgent && row.health === 'needs-reconnect' && row.sharedSignIn !== true;
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
    manageable,
    sharedCredentials,
    connectorsSupported,
    retrying,
    retry,
    refresh,
  } = useAgentConnectors(agentId);
  // TASK-761 — an agent whose model gets no connector tools (a runner that
  // doesn't load connectors — an allow-list in `runnerLoadsConnectors`) is not
  // offered Add: setting up access it can't use would only mislead.
  // TASK-798 — nor is anyone who may not add to this agent.
  const addable = connectorsSupported && manageable ? onAdd : undefined;
  const isAdmin = useUser()?.role === 'admin';
  const [confirming, setConfirming] = useState<AgentConnectorRow | null>(null);
  const [notice, setNotice] = useState<
    { tone: 'error' | 'note'; text: string } | null
  >(null);
  const [editing, setEditing] = useState<Connector | null>(null);
  const [reconnecting, setReconnecting] = useState<AgentConnectorRow | null>(null);
  // TASK-774 — a team-agent member re-signing in for themselves only.
  const [signingIn, setSigningIn] = useState<AgentConnectorRow | null>(null);
  // TASK-795 — first-time setup of a `needs-sign-in` row: an OAuth sign-in on
  // this agent, or the Settings key dialog.
  const [firstSignIn, setFirstSignIn] = useState<AgentConnectorRow | null>(null);
  const [addingKey, setAddingKey] = useState<AgentConnectorRow | null>(null);
  // TASK-813 — a team admin adding the key everyone on this agent uses.
  const [addingTeamKey, setAddingTeamKey] = useState<AgentConnectorRow | null>(null);

  /** The row's first-time setup, from the menu or the details view. */
  function onSetUp(row: AgentConnectorRow) {
    setNotice(null);
    if (row.setup === 'sign-in') setFirstSignIn(row);
    else if (row.setup === 'add-key') setAddingKey(row);
  }

  async function onRetry(row: AgentConnectorRow) {
    setNotice(null);
    const { outcome, sharedSignIn, setup } = await retry(row.id);
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
        text:
          shared && !sharedSignIn
            ? `${row.name} is reachable, but your sign-in expired. Choose Sign in again to fix it.`
            : sharedSignIn && !sharedCredentials
              ? `${row.name} is reachable, but its team sign-in expired. Ask the agent’s owner to sign in again.`
              : `${row.name} is reachable, but its sign-in expired. Choose Reconnect to sign in again.`,
      });
      return;
    }
    if (outcome === 'needs-sign-in') {
      setNotice({
        tone: 'note',
        text:
          setup === 'sign-in'
            ? `${row.name} is reachable, but nobody has signed in yet. Choose Sign in to set it up.`
            : setup === 'add-key'
              ? `${row.name} is reachable, but no key has been added yet. Choose Add key to set it up.`
              : setup === 'ask-owner'
                ? `${row.name} is reachable, but nobody has signed in yet. Ask the agent’s owner to sign in.`
                : setup === 'ask-admin'
                  ? `${row.name} is reachable, but it needs a key from a workspace admin.`
                  : `${row.name} is reachable, but it isn’t set up yet.`,
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
      personalSignIn={personalExpiry(row, shared)}
      canReconnect={sharedCredentials || row.sharedSignIn !== true}
      onReconnect={() => {
        setNotice(null);
        setReconnecting(row);
      }}
      onAddTeamKey={() => {
        setNotice(null);
        setAddingTeamKey(row);
      }}
      onSignInAgain={() => {
        setNotice(null);
        setSigningIn(row);
      }}
      onRetry={() => void onRetry(row)}
      onSetUp={() => onSetUp(row)}
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
          onSetUp={() => onSetUp(open)}
          onHealthStale={refresh}
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
        <NoConnectors name={name} onAdd={addable} manageable={manageable} />
      )}
      {status === 'ok' && connectors !== null && connectors.length > 0 && (
        <Card className="shadow-none">
          {connectors.map((row, i) => (
            <Fragment key={row.id}>
              {i > 0 && <Separator />}
              <div className="flex h-11 items-center gap-2 pl-3 pr-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="min-w-0 truncate text-[13px]">{row.name}</span>
                  {row.health !== 'ok' && (
                    <HealthIcon
                      reason={healthReason(row, sharedCredentials)}
                      tone={row.health === 'needs-sign-in' ? 'neutral' : 'error'}
                    />
                  )}
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
      <Dialog
        open={signingIn !== null}
        onOpenChange={(open) => {
          if (!open) setSigningIn(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in to {signingIn?.name} again</DialogTitle>
            <DialogDescription>
              Your sign-in to {signingIn?.name} expired. Sign in again and {name} can
              keep using it for you. This only affects you — everyone else on {name}{' '}
              stays as they are.
            </DialogDescription>
          </DialogHeader>
          {/* What signing in hands the assistant — drawn here, in the file that
              starts the sign-in, so the TASK-700 coverage scan sees it. */}
          <ConnectorAccessNotice kind="sign-in" />
          {signingIn !== null && (
            // No agentId on purpose: the flow is then personal (stored for this
            // person only), which is the sign-in their use of this team agent
            // reaches first. With the agent it would sign in for the team.
            // No shared-agent consent either — nobody else acts as them.
            <ConnectorOAuthConnect
              connectorId={signingIn.id}
              serviceName={signingIn.name}
              showAccessNotice={false}
              reconnectLabel="Sign in again"
              onConnected={() => {
                setSigningIn(null);
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={firstSignIn !== null}
        onOpenChange={(open) => {
          if (!open) setFirstSignIn(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in to {firstSignIn?.name}</DialogTitle>
            <DialogDescription>
              {shared
                ? `Signing in here lets everyone using ${name} use ${firstSignIn?.name ?? ''} as you.`
                : `Sign in and ${name} can use ${firstSignIn?.name ?? ''} for you.`}
            </DialogDescription>
          </DialogHeader>
          {/* What signing in hands the assistant — drawn here, in the file that
              starts the sign-in, so the TASK-700 coverage scan sees it. */}
          <ConnectorAccessNotice kind="sign-in" />
          {firstSignIn !== null && (
            <ConnectorOAuthConnect
              connectorId={firstSignIn.id}
              serviceName={firstSignIn.name}
              agentId={agentId}
              requiresConsent={shared}
              showAccessNotice={false}
              onConnected={() => {
                setFirstSignIn(null);
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {addingKey !== null && (
        <ConnectorConnectDialog
          connectorId={addingKey.id}
          connectorName={addingKey.name}
          isAdmin={isAdmin}
          open
          onOpenChange={(open) => {
            if (!open) setAddingKey(null);
          }}
          onConnected={() => {
            setAddingKey(null);
            refresh();
          }}
        />
      )}
      {addingTeamKey !== null && (
        <TeamKeyDialog
          agentId={agentId}
          agentName={name}
          connectorId={addingTeamKey.id}
          connectorName={addingTeamKey.name}
          isAdmin={isAdmin}
          open
          onOpenChange={(open) => {
            if (!open) setAddingTeamKey(null);
          }}
          onSaved={() => {
            setAddingTeamKey(null);
            refresh();
          }}
        />
      )}
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
  manageable,
}: {
  name: string;
  onAdd: (() => void) | undefined;
  /** TASK-798 — false: this person can't add one, so don't tell them to. */
  manageable: boolean;
}) {
  return (
    <Empty className="border border-dashed p-5 md:p-5">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Plug aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-[13px]">No connectors yet</EmptyTitle>
        <EmptyDescription className="text-[12px]">
          {manageable
            ? `Connect a tool like Linear or Gmail and ${name} can work in it for you.`
            : `Ask the agent’s owner to connect a tool like Linear or Gmail, and ${name} can work in it for you.`}
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
 * The icon after a row's name when its health is not ok. A real `<button>` so
 * keyboard users reach it and the tooltip opens on focus as well as hover; its
 * accessible name IS the reason, so a screen reader hears it without the
 * tooltip. Clicking it does nothing on its own — the fix lives in the `⋯`
 * menu. Standard tooltip colours (product owner's call); only the icon is
 * coloured: red for an error, muted for `neutral` (TASK-795 — not set up yet,
 * which is nothing broken).
 */
function HealthIcon({ reason, tone }: { reason: string; tone: 'error' | 'neutral' }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={reason}
            className={cn(
              'inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
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
  personalSignIn,
  canReconnect,
  onReconnect,
  onAddTeamKey,
  onSignInAgain,
  onRetry,
  onSetUp,
  onView,
  onEdit,
  onRemove,
}: {
  row: AgentConnectorRow;
  agentName: string;
  busy: boolean;
  /** TASK-774 — the fix is this person's own sign-in, not Reconnect. */
  personalSignIn: boolean;
  /**
   * TASK-798 / TASK-813 — false for a team agent's shared sign-in when this
   * person may not sign in on the agent (not the team's admin): the server
   * would refuse, so it isn't offered.
   */
  canReconnect: boolean;
  onReconnect: () => void;
  /** TASK-813 — "Add team key", on a row that says `teamKey`. */
  onAddTeamKey: () => void;
  onSignInAgain: () => void;
  onRetry: () => void;
  /** TASK-795 — Sign in / Add key on a `needs-sign-in` row. */
  onSetUp: () => void;
  /** Absent inside the details view itself. */
  onView?: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  // One group per kind of action, separated — only the groups this row has.
  const groups: { key: string; item: ReactNode }[] = [];
  if (row.health === 'needs-sign-in' && (row.setup === 'sign-in' || row.setup === 'add-key')) {
    groups.push({
      key: 'setup',
      item: (
        <DropdownMenuItem onSelect={onSetUp}>
          {row.setup === 'sign-in' ? <LogIn aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
          {row.setup === 'sign-in' ? 'Sign in' : 'Add key'}
        </DropdownMenuItem>
      ),
    });
  }
  if (row.health === 'needs-reconnect' && personalSignIn) {
    groups.push({
      key: 'fix',
      item: (
        <DropdownMenuItem onSelect={onSignInAgain}>
          <LogIn aria-hidden="true" />
          Sign in again
        </DropdownMenuItem>
      ),
    });
  } else if (row.health === 'needs-reconnect' && canReconnect) {
    groups.push({
      key: 'fix',
      item: (
        <DropdownMenuItem onSelect={onReconnect}>
          <LogIn aria-hidden="true" />
          Reconnect
        </DropdownMenuItem>
      ),
    });
  } else if (row.health === 'unreachable') {
    groups.push({
      key: 'fix',
      item: (
        <DropdownMenuItem onSelect={onRetry}>
          <RotateCw aria-hidden="true" />
          Retry
        </DropdownMenuItem>
      ),
    });
  }
  if (onView !== undefined) {
    groups.push({
      key: 'view',
      item: (
        <DropdownMenuItem onSelect={onView}>
          <Info aria-hidden="true" />
          View details
        </DropdownMenuItem>
      ),
    });
  }
  if (row.editable) {
    groups.push({
      key: 'edit',
      item: (
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil aria-hidden="true" />
          Edit connector
        </DropdownMenuItem>
      ),
    });
  }
  // TASK-813 — only the team's admins see it; the server decides again.
  if (row.teamKey === true) {
    groups.push({
      key: 'team-key',
      item: (
        <DropdownMenuItem onSelect={onAddTeamKey}>
          <KeyRound aria-hidden="true" />
          Add team key
        </DropdownMenuItem>
      ),
    });
  }
  // TASK-798 — hidden, not drawn disabled, for anyone who may not remove it.
  if (row.removable) {
    groups.push({
      key: 'remove',
      item: (
        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onRemove}>
          <Trash2 aria-hidden="true" />
          Remove from {agentName}
        </DropdownMenuItem>
      ),
    });
  }
  // Nothing to offer (the details view of a row this person can only look
  // at): no `⋯` that opens onto an empty menu.
  if (groups.length === 0) return null;
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
        {groups.map(({ key, item }, i) => (
          <Fragment key={key}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>{item}</DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
