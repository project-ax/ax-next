/**
 * The connectors rail's Add subview (TASK-740, connectors-rail slice 7).
 *
 * "‹ Connectors", "Add a connector", one line of intro, a search box, then
 * "Available <n>" — the connectors this person may use that the agent doesn't
 * have yet. A row is the connector's NAME and one action (product owner's
 * call: no icon tiles, no subtitles):
 *
 *   - **Sign in** — opens the provider's sign-in. While it is open the row
 *     shows a spinner and **Cancel**.
 *   - **Add key** — the same key dialog Settings › Connectors uses.
 *   - **Add** — nothing to set up; attaches straight away.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: the connector is attached to the agent
 * ONLY after its sign-in / key has succeeded. A cancelled or failed sign-in,
 * or a key dialog closed early, attaches nothing. If the attach itself fails
 * after a good sign-in, the row says so and offers Retry — the sign-in stays
 * saved, and it grants this agent nothing until the attach lands.
 *
 * A team agent's sign-in is stored ON THE AGENT, so everyone using it acts as
 * the person who signed in. That gets the same consent line the agent editor
 * shows before the sign-in starts. When we can't tell whether the agent is a
 * team agent, we ask anyway.
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Loader2, Search } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import { ConnectorConnectDialog } from '@/components/settings/ConnectorConnectDialog';
import {
  addActionFor,
  availableConnectors,
  matchesQuery,
  type AddAction,
} from '@/lib/add-connector';
import { listChatAgents } from '@/lib/agents';
import {
  getConnector,
  listConnectors,
  type ConnectorSummary,
} from '@/lib/connectors';
import { adminCredentials, myCredentials, type CredentialMeta } from '@/lib/credentials';
import { HttpError, logRequestFailure } from '@/lib/http';
import { useOAuthPopup } from '@/lib/use-oauth-popup';
import { useUser } from '@/lib/user-context';
import { workspaceApi } from '@/lib/workspace-api';

interface Props {
  agentId: string;
  /** The agent's display name. */
  name: string;
  /** "‹ Connectors". */
  onBack: () => void;
  /** A connector was attached. The parent returns to the list and re-reads. */
  onAttached: () => void;
}

type RowAction = AddAction | 'checking';

interface RowProblem {
  text: string;
  /** Retry the attach (the sign-in / key is already done). */
  retry: boolean;
}

export function AddConnector({ agentId, name, onBack, onAttached }: Props) {
  const isAdmin = useUser()?.role === 'admin';
  const [query, setQuery] = useState('');
  const [load, setLoad] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [available, setAvailable] = useState<ConnectorSummary[]>([]);
  const [actions, setActions] = useState<Record<string, RowAction>>({});
  const [problems, setProblems] = useState<Record<string, RowProblem>>({});
  const [attaching, setAttaching] = useState<ReadonlySet<string>>(new Set());
  const [keying, setKeying] = useState<ConnectorSummary | null>(null);
  const [teamAgent, setTeamAgent] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // Only the newest load lands, and nothing lands after unmount.
  const scope = useRef(0);

  const readCreds = useCallback(async (): Promise<{
    user: CredentialMeta[];
    global: CredentialMeta[];
  }> => {
    // Presence only. A failed read reads as "absent", which can only ask for
    // a key that is already there — never attach one that isn't.
    const user = await myCredentials.list().catch(() => []);
    const global = isAdmin ? await adminCredentials.list().catch(() => []) : [];
    return { user, global };
  }, [isAdmin]);

  /** Work out one row's action from a fresh read. */
  const actionFor = useCallback(
    async (id: string, signedIn = false): Promise<AddAction> => {
      const [full, creds] = await Promise.all([
        getConnector(id, isAdmin ? '/admin/connectors' : '/settings/connectors'),
        readCreds(),
      ]);
      return addActionFor(full, {
        agentId,
        userCreds: creds.user,
        globalCreds: creds.global,
        signedIn,
      });
    },
    [agentId, isAdmin, readCreds],
  );

  useEffect(() => {
    const id = ++scope.current;
    setLoad('loading');
    setActions({});
    setProblems({});
    void (async () => {
      try {
        const [catalog, effective] = await Promise.all([
          listConnectors(isAdmin ? '/admin/connectors' : '/settings/connectors'),
          workspaceApi.connectors(agentId),
        ]);
        if (scope.current !== id) return;
        const list = availableConnectors(
          catalog,
          new Set(effective.connectors.map((c) => c.id)),
          isAdmin,
        );
        setAvailable(list);
        setActions(Object.fromEntries(list.map((c) => [c.id, 'checking' as const])));
        setLoad('ok');
        await Promise.all(
          list.map(async (c) => {
            let action: AddAction;
            try {
              action = await actionFor(c.id);
            } catch {
              // The full record didn't load. "Add key" opens the key dialog,
              // which re-reads it and says plainly if it still can't — it
              // never attaches on its own.
              action = 'key';
            }
            if (scope.current !== id) return;
            setActions((prev) => ({ ...prev, [c.id]: action }));
          }),
        );
      } catch (e) {
        if (scope.current !== id) return;
        logRequestFailure(e, 'add-connector');
        setLoad('failed');
      }
    })();
    void listChatAgents()
      .then((agents) => {
        if (scope.current !== id) return;
        const me = agents.find((a) => a.agentId === agentId);
        // Unknown counts as team: asking once too often beats a silent share.
        setTeamAgent(me === undefined || me.visibility === 'team');
      })
      .catch(() => {
        if (scope.current === id) setTeamAgent(true);
      });
    return () => {
      scope.current += 1;
    };
  }, [agentId, isAdmin, actionFor, attempt]);

  const setProblem = (id: string, problem: RowProblem | null) =>
    setProblems((prev) => {
      const next = { ...prev };
      if (problem === null) delete next[id];
      else next[id] = problem;
      return next;
    });

  /** The ONLY place this subview attaches anything. */
  const attach = useCallback(
    async (c: ConnectorSummary) => {
      setProblem(c.id, null);
      setAttaching((prev) => new Set(prev).add(c.id));
      try {
        await workspaceApi.attachConnector(agentId, c.id);
        onAttached();
      } catch (e) {
        logRequestFailure(e, 'add-connector');
        setProblem(
          c.id,
          e instanceof HttpError && e.status === 403
            ? { text: `Only a workspace admin can add ${c.name} to ${name}.`, retry: false }
            : {
                text: `We couldn’t add ${c.name} to ${name} just now. What you set up is saved — ${name} just can’t use it until it’s added.`,
                retry: true,
              },
        );
      } finally {
        setAttaching((prev) => {
          const next = new Set(prev);
          next.delete(c.id);
          return next;
        });
      }
    },
    [agentId, name, onAttached],
  );

  /**
   * A sign-in or key just succeeded: re-read what the connector still needs,
   * then do the next step. Attach only when nothing is left.
   */
  const advance = useCallback(
    async (c: ConnectorSummary, signedIn: boolean) => {
      let next: AddAction;
      try {
        next = await actionFor(c.id, signedIn);
      } catch {
        setProblem(c.id, {
          text: `We couldn’t check ${c.name} just now. Please try again.`,
          retry: false,
        });
        return;
      }
      setActions((prev) => ({ ...prev, [c.id]: next }));
      if (next === 'add') {
        setKeying(null);
        await attach(c);
      } else if (next === 'key') {
        setKeying(c);
      }
    },
    [actionFor, attach],
  );

  const shown = useMemo(
    () => available.filter((c) => matchesQuery(c, query)),
    [available, query],
  );

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="-ml-2 mb-2 h-7 gap-1 px-2 text-[13px] text-muted-foreground"
      >
        <ChevronLeft aria-hidden="true" />
        Connectors
      </Button>
      <h3 className="text-[15px] font-semibold">Add a connector</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        Pick one your workspace offers. If it needs a sign-in, we add it to {name} once
        you’ve signed in.
      </p>
      <InputGroup className="mt-4">
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          placeholder="Search connectors"
          aria-label="Search connectors"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </InputGroup>
      <h4 className="mb-2.5 mt-5 flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
        Available
        {load === 'ok' && <span className="tabular-nums">{shown.length}</span>}
      </h4>
      {load === 'loading' && (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}
      {load === 'failed' && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            We couldn’t load what your workspace offers just now.
          </p>
          <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}
      {load === 'ok' && shown.length === 0 && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {available.length === 0
            ? `${name} already has every connector you can add.`
            : 'Nothing matches that search.'}
        </p>
      )}
      {/* Every available row stays MOUNTED and a search only hides it: a row
          owns its in-flight sign-in, and unmounting it would quietly cancel
          one the person is still finishing in the popup. */}
      {load === 'ok' && available.length > 0 && (
        <Card
          className="divide-y divide-border overflow-hidden shadow-none"
          hidden={shown.length === 0}
        >
          {available.map((c) => (
            <AvailableRow
              key={c.id}
              hidden={!matchesQuery(c, query)}
              connector={c}
              agentId={agentId}
              agentName={name}
              action={actions[c.id] ?? 'checking'}
              attaching={attaching.has(c.id)}
              problem={problems[c.id] ?? null}
              teamAgent={teamAgent}
              onSignedIn={() => void advance(c, true)}
              onAddKey={() => {
                setProblem(c.id, null);
                setKeying(c);
              }}
              onAdd={() => void attach(c)}
            />
          ))}
        </Card>
      )}
      <ConnectorAccessNotice kind="attach" className="mt-4" />
      <p className="mt-4 text-[12px] leading-relaxed text-muted-foreground">
        Don’t see the one you need? Ask a workspace admin to set it up.
      </p>
      {keying !== null && (
        <ConnectorConnectDialog
          connectorId={keying.id}
          connectorName={keying.name}
          isAdmin={isAdmin}
          open
          onOpenChange={(open) => {
            if (!open) setKeying(null);
          }}
          // A key was saved. Attach only once EVERY key it needs is there —
          // a multi-key connector calls this once per key.
          onConnected={() => void advance(keying, false)}
        />
      )}
    </>
  );
}

function AvailableRow({
  hidden,
  connector,
  agentId,
  agentName,
  action,
  attaching,
  problem,
  teamAgent,
  onSignedIn,
  onAddKey,
  onAdd,
}: {
  hidden: boolean;
  connector: ConnectorSummary;
  agentId: string;
  agentName: string;
  action: RowAction;
  attaching: boolean;
  problem: RowProblem | null;
  teamAgent: boolean;
  onSignedIn: () => void;
  onAddKey: () => void;
  onAdd: () => void;
}) {
  const [consenting, setConsenting] = useState(false);
  const signIn = useOAuthPopup({
    connectorId: connector.id,
    agentId,
    serviceName: connector.name,
    onConnected: onSignedIn,
  });
  const pending = signIn.busy;

  let control: React.ReactNode;
  if (pending) {
    control = (
      <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[12px]" onClick={signIn.cancel}>
        Cancel
      </Button>
    );
  } else if (attaching) {
    control = (
      <Loader2
        className="mr-2 size-4 animate-spin text-muted-foreground"
        aria-label={`Adding ${connector.name}`}
      />
    );
  } else if (problem?.retry === true) {
    control = (
      <Button variant="outline" size="sm" className="h-7 px-2.5 text-[12px]" onClick={onAdd}>
        Retry
      </Button>
    );
  } else if (action === 'checking') {
    control = <Skeleton className="mr-1 h-7 w-16" aria-label="Checking" />;
  } else {
    const label = action === 'sign-in' ? 'Sign in' : action === 'key' ? 'Add key' : 'Add';
    control = (
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-[12px]"
        aria-label={`${label} — ${connector.name}`}
        disabled={consenting}
        onClick={() => {
          if (action === 'sign-in') {
            if (teamAgent) setConsenting(true);
            else void signIn.start();
          } else if (action === 'key') onAddKey();
          else onAdd();
        }}
      >
        {label}
      </Button>
    );
  }

  const message = problem?.text ?? signIn.error;
  return (
    <div hidden={hidden} className={pending ? 'bg-primary-soft' : undefined}>
      <div className="flex h-11 items-center gap-2 pl-3 pr-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{connector.name}</span>
          {pending && (
            <Loader2
              className="size-3.5 shrink-0 animate-spin text-muted-foreground"
              aria-label="Waiting for sign-in"
            />
          )}
        </span>
        {control}
      </div>
      {consenting && !pending && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <Alert>
            <AlertDescription className="text-[12px]">
              {`Signing in here lets anyone who uses ${agentName} act as you on ${connector.name}. Only people already on this agent are affected.`}
            </AlertDescription>
          </Alert>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConsenting(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConsenting(false);
                void signIn.start();
              }}
            >
              Continue
            </Button>
          </div>
        </div>
      )}
      {message !== null && (
        <Alert variant="destructive" className="mx-3 mb-3 w-auto">
          <AlertDescription className="text-[12px]">{message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
