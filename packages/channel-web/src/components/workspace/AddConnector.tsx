/**
 * The connectors rail's Add subview (TASK-740, connectors-rail slice 7).
 *
 * "‹ Connectors", "Add a connector", one line of intro, a search box, then
 * "Available <n>" — the connectors this person may use that the agent doesn't
 * have yet. A row is the connector's NAME and one action, **Add** (product
 * owner's call: no icon tiles, no subtitles).
 *
 * THE RULE THIS FILE EXISTS TO KEEP (slice 3): Add is one step that either
 * fully happens or leaves nothing. What it does depends on the connector's
 * kind (`addActionFor`), never on anybody's saved keys or sign-ins:
 *
 *   - **Sign-in connector** — Add opens the provider's sign-in popup straight
 *     away (`mode:'add'`). The server's callback saves the sign-in on the agent
 *     AND attaches the connector, or neither, so on success this view only
 *     re-reads (`onAttached`) and never attaches anything itself. While the
 *     popup is open the row shows a spinner and **Cancel**. A failure shows
 *     fixed copy for its reason (`oauthFailureMessage`) and the row stays.
 *   - **Per-agent key connector** — Add opens the key form (`AddKeyDialog`);
 *     saving sends every key WITH the attach, in one request.
 *   - **Shared-key or no-auth connector** — Add attaches straight away, with
 *     no keys in the request at all.
 *
 * A team agent's sign-in is stored ON THE AGENT, so everyone using it acts as
 * the person who signed in. That gets the same consent line the rail's Sign in
 * again shows before the sign-in starts. Whether the agent is a team agent
 * comes from the server, on the same read as its connector list (`shared`,
 * the flag Sign in again uses too — TASK-741).
 *
 * Only an admin of the team that owns a team agent may put a sign-in or a key
 * ON it (TASK-813, `sharedCredentials` on the same read). For anyone else a
 * sign-in row says "Ask the agent’s owner to sign in" and a key row "Ask the
 * agent’s owner to add its key" instead of a button. A plain Add is unchanged.
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
import {
  addActionFor,
  availableConnectors,
  matchesQuery,
  type AddAction,
} from '@/lib/add-connector';
import {
  getConnector,
  listConnectors,
  type Connector,
  type ConnectorSummary,
} from '@/lib/connectors';
import { HttpError, logRequestFailure } from '@/lib/http';
import { useOAuthPopup } from '@/lib/use-oauth-popup';
import { useUser } from '@/lib/user-context';
import { AttachConnectorError, workspaceApi, type AgentConnectorKey } from '@/lib/workspace-api';
import { AddKeyDialog } from './AddKeyDialog';

interface Props {
  agentId: string;
  /** The agent's display name. */
  name: string;
  /** "‹ Connectors". */
  onBack: () => void;
  /** A connector was added. The parent returns to the list and re-reads. */
  onAttached: () => void;
}

/** `checking` until the connector's details load; `unloaded` if they didn't. */
type RowAction = AddAction | 'checking' | 'unloaded';

interface RowProblem {
  text: string;
  /** Offer a plain Retry of the same Add (a network or server hiccup only). */
  retry: boolean;
}

/** A sign-in / key row on a team agent this person may not put an account on. */
const ASK_OWNER_SIGN_IN = 'Ask the agent’s owner to sign in';
const ASK_OWNER_KEY = 'Ask the agent’s owner to add its key';

/** A fresh read that the connector's details couldn't load. */
const UNLOADED = 'Couldn’t load it';

/**
 * Fixed copy for a refused Add. Only the status and a known code are read —
 * never the server's text. `null` code: anything we don't word specially.
 */
function refusalCopy(
  e: unknown,
  c: ConnectorSummary,
  agentName: string,
  opts: { isAdmin: boolean; withKeys: boolean },
): RowProblem {
  const status = e instanceof HttpError ? e.status : -1;
  const code = e instanceof AttachConnectorError ? e.code : undefined;
  if (code === 'already-attached') {
    return {
      text: `${c.name} is already on ${agentName}. To change its key, remove it and add it again.`,
      retry: false,
    };
  }
  if (code === 'connector-needs-sign-in') {
    return { text: `${c.name} is added by signing in. Go back and open Add again.`, retry: false };
  }
  if (code === 'keys-not-accepted') {
    // Its definition changed since the list was read: it no longer takes a
    // key of the agent's own.
    return { text: `${c.name} doesn’t take a key any more. Go back and open Add again.`, retry: false };
  }
  if (code === 'connector-needs-key') {
    return {
      text: opts.withKeys
        ? `${c.name} needs every key filled in before it can be added.`
        : `${c.name} needs a key first. Go back and open Add again.`,
      retry: false,
    };
  }
  if (code === 'connector-needs-shared-key') {
    // TASK-827 — the shared key is the workspace's. No Retry: it would meet
    // the same refusal until an admin adds the key.
    return {
      text: opts.isAdmin
        ? `${c.name} doesn’t have its shared key yet. Add it in Admin › Connectors, then try again.`
        : `${c.name} doesn’t have its shared key yet. Ask a workspace admin to add it.`,
      retry: false,
    };
  }
  if (status === 403) {
    return opts.withKeys
      ? { text: `You can’t add keys to ${agentName}. Ask the agent’s owner.`, retry: false }
      : { text: `Only a workspace admin can add ${c.name} to ${agentName}.`, retry: false };
  }
  // A network failure (status 0), a server error, or a refusal we don't word:
  // nothing was saved, and trying the same Add again is safe.
  return {
    text: `We couldn’t add ${c.name} to ${agentName} just now. Nothing was saved — please try again.`,
    retry: status === 0 || status >= 500,
  };
}

export function AddConnector({ agentId, name, onBack, onAttached }: Props) {
  const isAdmin = useUser()?.role === 'admin';
  const [query, setQuery] = useState('');
  const [load, setLoad] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [available, setAvailable] = useState<ConnectorSummary[]>([]);
  const [actions, setActions] = useState<Record<string, RowAction>>({});
  // Each row's full record, once loaded: the key form needs its slots.
  const [details, setDetails] = useState<Record<string, Connector>>({});
  const [problems, setProblems] = useState<Record<string, RowProblem>>({});
  const [attaching, setAttaching] = useState<ReadonlySet<string>>(new Set());
  const [keying, setKeying] = useState<Connector | null>(null);
  // Until the read lands no row is drawn, so this default is never shown;
  // it errs on asking.
  const [teamAgent, setTeamAgent] = useState(true);
  // TASK-813 — may put a sign-in or key ON this (team) agent. Errs on not offering.
  const [sharedCredentials, setSharedCredentials] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Only the newest load lands, and nothing lands after unmount.
  const scope = useRef(0);

  useEffect(() => {
    const id = ++scope.current;
    const base = isAdmin ? '/admin/connectors' : '/settings/connectors';
    setLoad('loading');
    setActions({});
    setDetails({});
    setProblems({});
    void (async () => {
      try {
        const [catalog, effective] = await Promise.all([
          listConnectors(base),
          workspaceApi.connectors(agentId),
        ]);
        if (scope.current !== id) return;
        const list = availableConnectors(
          catalog,
          new Set(effective.connectors.map((c) => c.id)),
        );
        setTeamAgent(effective.shared !== false);
        setSharedCredentials(effective.sharedCredentials === true);
        setAvailable(list);
        setActions(Object.fromEntries(list.map((c) => [c.id, 'checking' as const])));
        setLoad('ok');
        await Promise.all(
          list.map(async (c) => {
            let action: RowAction;
            try {
              const full = await getConnector(c.id, base);
              if (scope.current !== id) return;
              setDetails((prev) => ({ ...prev, [c.id]: full }));
              action = addActionFor(full);
            } catch (e) {
              // Never a guess: without its details we can't tell a sign-in
              // from a key from a plain Add, so the row offers nothing.
              logRequestFailure(e, 'add-connector');
              action = 'unloaded';
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
    return () => {
      scope.current += 1;
    };
  }, [agentId, isAdmin, attempt]);

  const setProblem = (id: string, problem: RowProblem | null) =>
    setProblems((prev) => {
      const next = { ...prev };
      if (problem === null) delete next[id];
      else next[id] = problem;
      return next;
    });

  /** A shared-key or no-auth Add: attach, with no keys in the request. */
  const attach = useCallback(
    async (c: ConnectorSummary) => {
      setProblem(c.id, null);
      setAttaching((prev) => new Set(prev).add(c.id));
      try {
        await workspaceApi.attachConnector(agentId, c.id);
        onAttached();
      } catch (e) {
        logRequestFailure(e, 'add-connector');
        setProblem(c.id, refusalCopy(e, c, name, { isAdmin, withKeys: false }));
      } finally {
        setAttaching((prev) => {
          const next = new Set(prev);
          next.delete(c.id);
          return next;
        });
      }
    },
    [agentId, name, onAttached, isAdmin],
  );

  /** A per-agent key Add: the keys ride with the attach. Throws copy on refusal. */
  const attachWithKeys = useCallback(
    async (c: Connector, keys: AgentConnectorKey[]) => {
      try {
        await workspaceApi.attachConnector(agentId, c.id, keys);
      } catch (e) {
        logRequestFailure(e, 'add-connector');
        throw new Error(refusalCopy(e, c, name, { isAdmin, withKeys: true }).text);
      }
      setKeying(null);
      onAttached();
    },
    [agentId, name, onAttached, isAdmin],
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
        Pick one your workspace offers. If it needs a sign-in or a key, we add it to {name}{' '}
        once that’s done.
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
              canSetCredential={!teamAgent || sharedCredentials}
              // The callback already added it: re-read, never attach here.
              onSignedIn={onAttached}
              onAddKey={() => {
                const full = details[c.id];
                if (full === undefined) return;
                setProblem(c.id, null);
                setKeying(full);
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
        <AddKeyDialog
          connector={keying}
          agentName={name}
          teamAgent={teamAgent}
          open
          onOpenChange={(open) => {
            if (!open) setKeying(null);
          }}
          onSave={(keys) => attachWithKeys(keying, keys)}
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
  canSetCredential,
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
  /** TASK-813 — false: a team agent this person may not put a sign-in or key on. */
  canSetCredential: boolean;
  onSignedIn: () => void;
  onAddKey: () => void;
  onAdd: () => void;
}) {
  const [consenting, setConsenting] = useState(false);
  const signIn = useOAuthPopup({
    connectorId: connector.id,
    agentId,
    mode: 'add',
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
  } else if (problem !== null && problem.retry) {
    // A plain Retry of the same Add — only ever a no-keys Add (a key Add's
    // failure stays in its form).
    control = (
      <Button variant="outline" size="sm" className="h-7 px-2.5 text-[12px]" onClick={onAdd}>
        Retry
      </Button>
    );
  } else if (action === 'checking') {
    control = <Skeleton className="mr-1 h-7 w-16" aria-label="Checking" />;
  } else if (action === 'unloaded') {
    control = (
      <span className="mr-1.5 shrink-0 text-[12px] text-muted-foreground">{UNLOADED}</span>
    );
  } else if ((action === 'sign-in' || action === 'key') && !canSetCredential) {
    control = (
      <span className="mr-1.5 shrink-0 text-[12px] text-muted-foreground">
        {action === 'sign-in' ? ASK_OWNER_SIGN_IN : ASK_OWNER_KEY}
      </span>
    );
  } else {
    control = (
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-[12px]"
        aria-label={`Add — ${connector.name}`}
        disabled={consenting}
        onClick={() => {
          if (action === 'sign-in') {
            if (teamAgent) setConsenting(true);
            else void signIn.start();
          } else if (action === 'key') onAddKey();
          else onAdd();
        }}
      >
        Add
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
