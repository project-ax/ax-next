/**
 * An agent's Apps section in its settings: the apps on an external apps
 * platform that use this agent, what each may use, and — for the people who
 * manage the agent — linking a new app with a one-time code, giving an app a
 * connector's tools, and taking either away. Anyone who can see the agent sees
 * the list; only its managers get the controls (the server decides again on
 * every write).
 *
 * Below that, the person's own yeses: apps using this agent's sign-ins as
 * them, each with Revoke. Only the person's own are ever sent.
 *
 * Claude-simple on purpose: an app is its name, a connector is its name, and
 * the only plumbing shown is the app's id in small print, so two apps with the
 * same name can be told apart. App names, connector names and tool names are
 * untrusted text and are rendered as text only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, Plus } from 'lucide-react';
import type { AgentAppsRead, AppGrant, AppLink, LinkCodeResponse, ViewerApproval } from '@ax/apps-bridge-contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  agentAppsErrorCopy,
  agentAppsStale,
  fetchAgentApps,
  mintLinkCode,
  removeGrant,
  revokeApproval,
  unlinkApp,
} from '@/lib/agent-apps';
import { logRequestFailure } from '@/lib/http';
import { APP_MODE_COPY, AppGrantEditor, type AppGrantEditorTarget } from './AppGrantEditor';
import { AppLinkCodeDialog } from './AppLinkCodeDialog';

type Enabled = Extract<AgentAppsRead, { enabled: true }>;
type Load = { status: 'loading' } | { status: 'failed' } | { status: 'off' } | { status: 'ok'; read: Enabled };

export interface AgentAppsProps {
  agentId: string;
  agentName: string;
}

export function AgentApps({ agentId, agentName }: AgentAppsProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // Only the newest read lands (switching agents quickly).
  const scope = useRef(0);

  const read = useCallback(
    (quiet = false) => {
      const id = ++scope.current;
      if (!quiet) setLoad({ status: 'loading' });
      void (async () => {
        try {
          const out = await fetchAgentApps(agentId);
          if (scope.current !== id) return;
          setLoad(out === 'unavailable' || !out.enabled ? { status: 'off' } : { status: 'ok', read: out });
        } catch (e) {
          logRequestFailure(e, 'agent-apps');
          if (scope.current === id) setLoad({ status: 'failed' });
        }
      })();
    },
    [agentId],
  );

  useEffect(() => {
    read();
    return () => {
      scope.current += 1;
    };
  }, [read]);

  switch (load.status) {
    case 'loading':
      return (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">Loading apps…</span>
          <Skeleton className="h-14 w-full" aria-hidden="true" />
          <Skeleton className="h-14 w-full" aria-hidden="true" />
        </div>
      );
    case 'failed':
      return (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>We couldn&apos;t load the apps for {agentName}.</p>
            <Button variant="outline" size="sm" onClick={() => read()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      );
    case 'off':
      return (
        <Empty className="border border-border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-primary-soft text-primary">
              <AppWindow aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>The apps platform isn&apos;t set up on this AX</EmptyTitle>
            <EmptyDescription>
              Once an admin connects one, apps built there can use {agentName} and its connectors.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    case 'ok':
      return <AppsBody agentId={agentId} agentName={agentName} data={load.read} onReread={() => read(true)} />;
  }
}

function AppsBody({
  agentId,
  agentName,
  data,
  onReread,
}: {
  agentId: string;
  agentName: string;
  data: Enabled;
  onReread: () => void;
}) {
  const { canManage, links, approvals } = data;
  const [notice, setNotice] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<LinkCodeResponse | null>(null);
  const [editing, setEditing] = useState<AppGrantEditorTarget | null>(null);
  const [unlinking, setUnlinking] = useState<AppLink | null>(null);
  // Rows with a write in flight, keyed `<appId>` or `<appId>:<connectorId>`.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const mark = (k: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });

  /** One sentence for a failed write; a stale page is read again. */
  const refuse = (err: unknown) => {
    logRequestFailure(err, 'agent-apps');
    setNotice(agentAppsErrorCopy(err));
    if (agentAppsStale(err)) onReread();
  };

  async function run(k: string, write: () => Promise<void>) {
    mark(k, true);
    setNotice(null);
    try {
      await write();
      onReread();
    } catch (err) {
      refuse(err);
    } finally {
      mark(k, false);
    }
  }

  async function linkApp() {
    setMinting(true);
    setNotice(null);
    try {
      setMinted(await mintLinkCode(agentId));
    } catch (err) {
      refuse(err);
    } finally {
      setMinting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {notice !== null && (
        <Alert variant="destructive">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="apps-linked" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="apps-linked" className="text-[14px] font-semibold">
            Apps that use this agent
          </h3>
          {canManage && (
            <Button size="sm" onClick={() => void linkApp()} disabled={minting}>
              {minting ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : (
                <Plus data-icon="inline-start" aria-hidden="true" />
              )}
              Link an app
            </Button>
          )}
        </div>
        {links.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {canManage
              ? `No apps use ${agentName} yet. Link one to let it use ${agentName}'s connectors.`
              : `No apps use ${agentName} yet.`}
          </p>
        ) : (
          <Card className="overflow-hidden p-0 shadow-none">
            <CardContent className="p-0">
              <ul aria-labelledby="apps-linked" className="m-0 list-none divide-y divide-border p-0">
                {links.map((link) => (
                  <LinkRow
                    key={link.appId}
                    link={link}
                    canManage={canManage}
                    busy={busy}
                    onAdd={() => setEditing({ link, grant: null })}
                    onEdit={(grant) => setEditing({ link, grant })}
                    onRemove={(grant) =>
                      void run(`${link.appId}:${grant.connectorId}`, () =>
                        removeGrant(agentId, link.appId, grant.connectorId),
                      )
                    }
                    onUnlink={() => setUnlinking(link)}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      {approvals.length > 0 && (
        <section aria-labelledby="apps-approvals" className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h3 id="apps-approvals" className="text-[14px] font-semibold">
              Apps using this agent&apos;s sign-ins as you
            </h3>
            <p className="text-[12.5px] text-muted-foreground">
              You said yes to these. Revoke one and it stops at once.
            </p>
          </div>
          <Card className="overflow-hidden p-0 shadow-none">
            <CardContent className="p-0">
              <ul aria-labelledby="apps-approvals" className="m-0 list-none divide-y divide-border p-0">
                {approvals.map((ap) => (
                  <ApprovalRow
                    key={`${ap.appId}:${ap.connectorId}`}
                    approval={ap}
                    busy={busy.has(`approval:${ap.appId}:${ap.connectorId}`)}
                    onRevoke={() =>
                      void run(`approval:${ap.appId}:${ap.connectorId}`, () =>
                        revokeApproval(agentId, ap.appId, ap.connectorId),
                      )
                    }
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      )}

      <AppLinkCodeDialog
        minted={minted}
        onDone={() => {
          // Shown once: the code goes with the dialog.
          setMinted(null);
          onReread();
        }}
      />
      <AppGrantEditor
        agentId={agentId}
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          onReread();
        }}
        onStale={onReread}
      />
      <UnlinkDialog
        link={unlinking}
        agentName={agentName}
        busy={unlinking !== null && busy.has(unlinking.appId)}
        onCancel={() => setUnlinking(null)}
        onConfirm={(link) =>
          // Closed either way: a refusal's sentence shows on the page, not behind the dialog.
          void run(link.appId, () => unlinkApp(agentId, link.appId)).finally(() => setUnlinking(null))
        }
      />
    </div>
  );
}

function LinkRow({
  link,
  canManage,
  busy,
  onAdd,
  onEdit,
  onRemove,
  onUnlink,
}: {
  link: AppLink;
  canManage: boolean;
  busy: ReadonlySet<string>;
  onAdd: () => void;
  onEdit: (grant: AppGrant) => void;
  onRemove: (grant: AppGrant) => void;
  onUnlink: () => void;
}) {
  const nameId = `app-${link.appId}-name`;
  return (
    <li aria-labelledby={nameId} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span id={nameId} className="break-words text-[14px] font-medium">
            {link.appName}
          </span>
          <span className="truncate font-mono text-[12px] text-muted-foreground">{link.appId}</span>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="sm" onClick={onAdd} aria-label={`Add a connector to ${link.appName}`}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add a connector
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy.has(link.appId)}
              onClick={onUnlink}
              aria-label={`Unlink ${link.appName}`}
            >
              Unlink
            </Button>
          </div>
        )}
      </div>
      {link.grants.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          {canManage ? 'It can’t use any connectors yet. Add one to get it going.' : 'It can’t use any connectors yet.'}
        </p>
      ) : (
        <ul aria-label={`What ${link.appName} can use`} className="m-0 flex list-none flex-col gap-2 p-0">
          {link.grants.map((grant) => {
            const rowBusy = busy.has(`${link.appId}:${grant.connectorId}`);
            return (
              <li key={grant.connectorId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{grant.connectorName}</span>
                    <Badge variant="secondary" size="compact">
                      {APP_MODE_COPY[grant.mode].badge}
                    </Badge>
                  </div>
                  <span className="break-all font-mono text-[12px] text-muted-foreground">
                    {grant.tools.map((t) => t.name).join(', ')}
                  </span>
                </div>
                {canManage && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={rowBusy}
                      onClick={() => onEdit(grant)}
                      aria-label={`Edit ${grant.connectorName} for ${link.appName}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={rowBusy}
                      onClick={() => onRemove(grant)}
                      aria-label={`Remove ${grant.connectorName} from ${link.appName}`}
                    >
                      {rowBusy && <Spinner data-icon="inline-start" aria-hidden="true" />}
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function ApprovalRow({
  approval,
  busy,
  onRevoke,
}: {
  approval: ViewerApproval;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="break-words text-[14px] font-medium">{approval.appName}</span>
        <span className="text-[12.5px] text-muted-foreground">Uses {approval.connectorName} as you</span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onRevoke}
        aria-label={`Revoke ${approval.appName} using ${approval.connectorName}`}
      >
        {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
        Revoke
      </Button>
    </li>
  );
}

function UnlinkDialog({
  link,
  agentName,
  busy,
  onCancel,
  onConfirm,
}: {
  link: AppLink | null;
  agentName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (link: AppLink) => void;
}) {
  return (
    <Dialog open={link !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlink {link?.appName}?</DialogTitle>
          <DialogDescription>
            It stops using {agentName} straight away, along with every connector you gave it. To use it again,
            link it with a new code.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => link !== null && onConfirm(link)}>
            {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Unlink
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
