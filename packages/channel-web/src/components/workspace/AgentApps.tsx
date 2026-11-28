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
import type { AgentAppsRead, AppLink, LinkCodeResponse } from '@ax/apps-bridge-contract';
import { AsyncState, Button as AxButton, Card, EmptyState, Notice } from '@project-ax/ui';
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
import { focusAfterRemoval } from '@/lib/focus-after-removal';
import { AppGrantEditor, type AppGrantEditorTarget } from './AppGrantEditor';
import { AppLinkCodeDialog } from './AppLinkCodeDialog';
import { ApprovalRow, LinkRow, UnlinkDialog } from './AgentAppsRows';

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
      return <AsyncState status="loading" skeleton="rows" loadingLabel="Loading apps" />;
    case 'failed':
      return (
        <AsyncState
          status="error"
          skeleton="rows"
          loadingLabel="Loading apps"
          error={{ message: `We couldn't load the apps for ${agentName}.`, onRetry: () => read() }}
        />
      );
    case 'off':
      return (
        <EmptyState
          icon={AppWindow}
          title="The apps platform isn't set up here"
          description={`Once an admin connects one, apps built there can use ${agentName} and its connectors.`}
        />
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

  /** A refusal is shown on the page, so the confirmation closes either way. */
  async function run(k: string, write: () => Promise<void>): Promise<void> {
    mark(k, true);
    setNotice(null);
    try {
      await write();
      onReread();
      // The row that opened the confirmation leaves with the write; park focus on the section's primary action.
      focusAfterRemoval('[data-return-focus="agent-apps"] button', '#apps-linked');
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
      {notice !== null && <Notice tone="danger">{notice}</Notice>}

      <section aria-labelledby="apps-linked" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="apps-linked" tabIndex={-1} className="text-[14px] font-semibold">
            Apps that use this agent
          </h3>
          {canManage && (
            <span data-return-focus="agent-apps">
              <AxButton intent="primary" size="sm" icon={Plus} busy={minting} onClick={() => void linkApp()}>
                Link an app
              </AxButton>
            </span>
          )}
        </div>
        {links.length === 0 ? (
          <EmptyState
            title={`No apps use ${agentName} yet.`}
            {...(canManage ? { description: `Link one to let it use ${agentName}'s connectors.` } : {})}
          />
        ) : (
          <Card flush>
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
                      run(`${link.appId}:${grant.connectorId}`, () =>
                        removeGrant(agentId, link.appId, grant.connectorId),
                      )
                    }
                    onUnlink={() => setUnlinking(link)}
                  />
                ))}
              </ul>
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
          <Card flush>
              <ul aria-labelledby="apps-approvals" className="m-0 list-none divide-y divide-border p-0">
                {approvals.map((ap) => (
                  <ApprovalRow
                    key={`${ap.appId}:${ap.connectorId}`}
                    approval={ap}
                    busy={busy.has(`approval:${ap.appId}:${ap.connectorId}`)}
                    onRevoke={() =>
                      run(`approval:${ap.appId}:${ap.connectorId}`, () =>
                        revokeApproval(agentId, ap.appId, ap.connectorId),
                      )
                    }
                  />
                ))}
              </ul>
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
        onCancel={() => setUnlinking(null)}
        // Closed either way: a refusal's sentence shows on the page, not behind the dialog.
        onConfirm={(link) => run(link.appId, () => unlinkApp(agentId, link.appId))}
      />
    </div>
  );
}
