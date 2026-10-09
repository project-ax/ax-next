/** Agent connector management in Settings: list, details, sign-in, keys and removal. */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  CircleAlert,
  KeyRound,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Trash2,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  DropdownMenuLabel,
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
import { ConnectorOAuthConnect } from '@/components/settings/ConnectorOAuthConnect';
import { useAgentConnectors } from '@/lib/agent-connectors';
import { useUser } from '@/lib/user-context';
import type { GrantRow } from '@/lib/workspace-api';
import { cn } from '@/lib/utils';
import type {
  AgentConnectorHealth,
  AgentConnectorRow,
} from '@/lib/workspace-types';
import { AgentKeyDialog } from './AgentKeyDialog';
import {
  ConnectorDetails,
  ConnectorsUnsupported,
  SETUP_REASON,
  SETUP_UNKNOWN_REASON,
} from './ConnectorDetails';

/** Why a row wears the error icon — its accessible name and its tooltip. */
const HEALTH_REASON: Record<
  Exclude<AgentConnectorHealth, 'ok' | 'not-loaded' | 'needs-sign-in'>,
  string
> = {
  'needs-reconnect': 'Sign-in expired',
  unreachable: 'Can’t reach it',
};

/** Slice 3 — an expired sign-in, for someone who can't choose the agent's account. */
const EXPIRED_ASK_OWNER = 'Sign-in expired. Ask the agent’s owner to sign in again.';

function healthReason(
  row: AgentConnectorRow,
  canSetAccount: boolean,
  isAdmin: boolean,
): string {
  if (row.health === 'needs-sign-in') {
    return row.setup !== undefined ? SETUP_REASON[row.setup] : SETUP_UNKNOWN_REASON;
  }
  if (row.health === 'not-loaded') {
    return isAdmin
      ? 'Couldn’t load it. Fix it in Admin › Connectors.'
      : 'Couldn’t load it. Ask a workspace admin to fix it.';
  }
  if (row.health === 'needs-reconnect') {
    if (!canSetAccount) return EXPIRED_ASK_OWNER;
    // TASK-756 — a team agent's shared sign-in is the team's, not this person's.
    if (row.sharedSignIn === true) return 'Team sign-in expired';
  }
  return row.health === 'ok' ? '' : HEALTH_REASON[row.health];
}

/** Slice 3 — the row's sign-in expired or is missing: Sign in again fixes it. */
function needsSignIn(row: AgentConnectorRow): boolean {
  return (
    row.health === 'needs-reconnect' ||
    (row.health === 'needs-sign-in' && row.setup === 'sign-in')
  );
}

/**
 * Ruling (slice 3): a row that was never signed in says "Sign in"; only an
 * expired sign-in says "Sign in again". Menu item and dialog title alike.
 */
function signInLabelFor(row: AgentConnectorRow): 'Sign in' | 'Sign in again' {
  return row.health === 'needs-reconnect' ? 'Sign in again' : 'Sign in';
}

/** Slice 3 — the row's agent key is missing: Add key fixes it. */
function needsKey(row: AgentConnectorRow): boolean {
  return row.health === 'needs-sign-in' && row.setup === 'add-key';
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
    canSetAccount,
    connectorsSupported,
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
    { tone: 'error' | 'note'; text: ReactNode } | null
  >(null);
  const [signingIn, setSigningIn] = useState<AgentConnectorRow | null>(null);
  const [addingKey, setAddingKey] = useState<AgentConnectorRow | null>(null);

  function onSignInAgain(row: AgentConnectorRow) {
    setNotice(null);
    setSigningIn(row);
  }

  function onAddKey(row: AgentConnectorRow) {
    setNotice(null);
    setAddingKey(row);
  }

  /** The details view's setup button: the same fix the `⋯` menu leads with. */
  function onSetUp(row: AgentConnectorRow) {
    if (needsSignIn(row)) onSignInAgain(row);
    else if (needsKey(row)) onAddKey(row);
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
        // Neutral: the step that failed may be approved access, or this
        // agent's sign-in or key for it.
        text: `Removed ${row.name}. Some of ${row.name}’s details couldn’t be cleaned up.`,
      });
    }
    onChanged?.();
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
      busy={removing.has(row.id)}
      {...(canSetAccount && needsSignIn(row)
        ? { onSignInAgain: () => onSignInAgain(row), signInLabel: signInLabelFor(row) }
        : {})}
      {...(canSetAccount && needsKey(row) ? { onAddKey: () => onAddKey(row) } : {})}
      {...(withView && onView !== undefined
        ? { onView: () => onView(row.id) }
        : {})}
      {...(withView && row.signedIn?.account != null ? { account: row.signedIn.account } : {})}
      {...(row.removable ? { onRemove: () => setConfirming(row) } : {})}
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
          onRemove={() => setConfirming(open)}
          {...(canSetAccount ? { onSetUp: () => onSetUp(open) } : {})}
          onHealthStale={refresh}
        />
      ) : (
      <>
      <ConnectorsHeader name={name} count={count} onAdd={addable} />
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
        <Card className="overflow-hidden p-0 shadow-none">
          <CardContent className="p-0">
          {connectors.map((row, i) => (
            <Fragment key={row.id}>
              {i > 0 && <Separator />}
              <div className="flex items-center gap-2 px-3 py-2">
                <AccountTooltip account={row.signedIn?.account ?? null}>
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={`Edit ${row.name}`}
                  aria-describedby={row.signedIn?.account ? `connector-account-${row.id}` : undefined}
                  onClick={() => onView?.(row.id)}
                  disabled={onView === undefined}
                  className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-3 whitespace-normal px-1 py-2 text-left"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Plug aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <ConnectorName id={row.id} name={row.name} account={row.signedIn?.account ?? null} />
                    <span className="truncate text-[12px] text-muted-foreground">
                      {row.health === 'ok' ? 'Ready to use' : healthReason(row, canSetAccount, isAdmin)}
                    </span>
                  </span>
                  <ChevronRight data-icon="inline-end" aria-hidden="true" />
                </Button>
                </AccountTooltip>
                {row.health !== 'ok' && (
                  <HealthIcon
                    reason={healthReason(row, canSetAccount, isAdmin)}
                    tone={row.health === 'needs-sign-in' ? 'neutral' : 'error'}
                  />
                )}
                {canSetAccount && needsSignIn(row) && (
                  <Button variant="outline" size="sm" onClick={() => onSignInAgain(row)} className="min-h-11 shrink-0">
                    {signInLabelFor(row)}
                  </Button>
                )}
                {menuFor(row, true)}
              </div>
            </Fragment>
          ))}
          </CardContent>
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
              This removes {confirming?.name} from {name}, including its sign-in
              and keys, and anything you approved for it here. The connector
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
        open={signingIn !== null}
        onOpenChange={(open) => {
          if (!open) setSigningIn(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {signingIn !== null && signInLabelFor(signingIn) === 'Sign in'
                ? `Sign in to ${signingIn.name}`
                : `Sign in to ${signingIn?.name ?? ''} again`}
            </DialogTitle>
            <DialogDescription>
              {shared
                ? `Sign in, and ${name} will use your ${signingIn?.name ?? ''} account for everyone who uses this agent.`
                : signingIn !== null && signInLabelFor(signingIn) === 'Sign in'
                  ? `Sign in and ${name} can use ${signingIn.name}.`
                  : `Sign in and ${name} can keep using ${signingIn?.name ?? ''}.`}
            </DialogDescription>
          </DialogHeader>
          {/* What signing in hands the assistant — drawn here, in the file that
              starts the sign-in, so the TASK-700 coverage scan sees it. */}
          <ConnectorAccessNotice kind="sign-in" />
          {signingIn !== null && (
            <ConnectorOAuthConnect
              connectorId={signingIn.id}
              serviceName={signingIn.name}
              agentId={agentId}
              // Already on the agent: this replaces its sign-in, nothing else.
              mode="sign-in-again"
              requiresConsent={shared}
              showAccessNotice={false}
              onConnected={() => {
                const before = signingIn;
                setSigningIn(null);
                // Slice 4 — compare against the rows THIS re-read returned,
                // not whatever the list holds when some effect next runs.
                void refresh().then((rows) => {
                  const after = rows?.find((r) => r.id === before.id);
                  const text = accountChanged(
                    before.signedIn?.account ?? null,
                    after?.signedIn?.account ?? null,
                  );
                  if (text !== null) setNotice({ tone: 'note', text });
                });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {addingKey !== null && (
        <AgentKeyDialog
          // A different connector is a different form: start it fresh.
          key={addingKey.id}
          agentId={agentId}
          agentName={name}
          teamAgent={shared}
          connectorId={addingKey.id}
          connectorName={addingKey.name}
          isAdmin={isAdmin}
          onOpenChange={(open) => {
            if (!open) setAddingKey(null);
          }}
          onSaved={() => {
            setAddingKey(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

/**
 * Slice 4 — "Now b@x (was a@x)" after Sign in again landed on a different
 * account; `null` (say nothing) when it's the same one, or when either side
 * is unknown: a sign-in from before slice 4 recorded no account, and a
 * provider may report none. Each account is provider text in its own `<bdi>`,
 * so a right-to-left one can't reorder the sentence.
 */
function accountChanged(was: string | null, now: string | null): ReactNode {
  if (was === null || now === null || was === now) return null;
  return (
    <>
      Now <bdi>{now}</bdi> (was <bdi>{was}</bdi>)
    </>
  );
}

/** Visible section guidance and its primary action. The page owns the heading. */
function ConnectorsHeader({
  name,
  count,
  onAdd,
}: {
  name: string;
  count: number | null;
  onAdd: (() => void) | undefined;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-[65ch] flex-1 text-[13px] leading-relaxed text-muted-foreground">
        Tools {name} can work in for you. Open one to choose which actions it can take on its own.
      </p>
      {onAdd !== undefined && count !== null && count > 0 && (
        <Button type="button" size="sm" onClick={onAdd} className="min-h-11 shrink-0">
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add connector
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
/**
 * A row's name (slice 4). Which account the agent signed in as stays off the
 * row so the list is easy to scan: the bare account shows in a tooltip on
 * hover or keyboard focus of the row button (and atop the row menu), and screen readers hear
 * ", signed in as …" with the name. A row with no recorded
 * account is plain text with no tooltip; the details button remains keyboard reachable.
 * Provider text: text nodes only, never markup; `bdi` so a right-to-left
 * account can't reorder what's around it.
 */
function AccountTooltip({ account, children }: { account: string | null; children: React.ReactElement }) {
  if (account === null) return children;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="top"><bdi>{account}</bdi></TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ConnectorName({ id, name, account }: { id: string; name: string; account: string | null }) {
  return (
    <span data-testid={`connector-name-${id}`} className="min-w-0 truncate text-[13px] font-medium">
      {name}
      {account !== null && (
        <span id={`connector-account-${id}`} className="sr-only">
          , signed in as <bdi>{account}</bdi>
        </span>
      )}
    </span>
  );
}

/**
 * The agent's account atop a row menu: smaller and lighter than the actions,
 * since it is context, not something to pick. A long account is clipped and
 * faded out at the right edge rather than ellipsized; the fade is added only
 * when the text really overflows, so a short account keeps every letter
 * crisp. The fade matches the conversation list's (14px). The whole account
 * stays in `title`.
 * Provider text: a text node only; `bdi` keeps an RTL account from reordering.
 */
function AccountLabel({ account }: { account: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null) setOverflow(el.scrollWidth > el.clientWidth);
  }, [account]);
  return (
    <DropdownMenuLabel
      ref={ref}
      data-testid="row-menu-account"
      {...(overflow ? { 'data-overflow': 'true' } : {})}
      className="max-w-64 overflow-hidden whitespace-nowrap text-xs font-normal text-muted-foreground data-[overflow=true]:[mask-image:linear-gradient(to_right,black_calc(100%-14px),transparent)]"
      title={account}
    >
      <bdi>{account}</bdi>
    </DropdownMenuLabel>
  );
}

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

/**
 * One row's `⋯` menu (slice 3): each item is present only when its handler
 * is — Sign in (again), Add key, Edit, Remove.
 * Hidden, never drawn disabled.
 */
function RowMenu({
  row,
  agentName,
  busy,
  onSignInAgain,
  onAddKey,
  onView,
  signInLabel = 'Sign in again',
  onRemove,
  account,
}: {
  row: AgentConnectorRow;
  /** The account the agent signed in as, shown atop the menu. The list's
   *  menu only: the details view already says it. */
  account?: string;
  agentName: string;
  busy: boolean;
  /** The sign-in expired or is missing, and this person may redo it. */
  onSignInAgain?: () => void;
  /** "Sign in" for a row never signed in; "Sign in again" when it expired. */
  signInLabel?: 'Sign in' | 'Sign in again';
  /** The agent key is missing, and this person may add it. */
  onAddKey?: () => void;
  /** Absent inside the details view itself: it already is the details. */
  onView?: () => void;
  /** TASK-798 — absent for anyone who may not remove it. */
  onRemove?: () => void;
}) {
  // One group per kind of action, separated — only the groups this row has.
  const groups: { key: string; item: ReactNode }[] = [];
  if (onSignInAgain !== undefined) {
    groups.push({
      key: 'sign-in',
      item: (
        <DropdownMenuItem onSelect={onSignInAgain}>
          <LogIn aria-hidden="true" />
          {signInLabel}
        </DropdownMenuItem>
      ),
    });
  }
  if (onAddKey !== undefined) {
    groups.push({
      key: 'add-key',
      item: (
        <DropdownMenuItem onSelect={onAddKey}>
          <KeyRound aria-hidden="true" />
          Add key
        </DropdownMenuItem>
      ),
    });
  }
  if (onView !== undefined) {
    groups.push({
      key: 'view',
      item: (
        <DropdownMenuItem onSelect={onView}>
          <Pencil aria-hidden="true" />
          Edit
        </DropdownMenuItem>
      ),
    });
  }
  if (onRemove !== undefined) {
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
        {account !== undefined && (
          <>
            <AccountLabel account={account} />
            <DropdownMenuSeparator />
          </>
        )}
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
