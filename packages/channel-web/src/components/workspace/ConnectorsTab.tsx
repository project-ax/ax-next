/**
 * The Connectors tab (TASK-738, connectors-rail slice 5).
 *
 * Replaces "What it may do alone". This slice draws the tab shell and the
 * part that is fully wired today:
 *
 *   - **Other abilities** — three switches (Web search, Read web pages, Run
 *     code). Each one writes a tighten-only per-agent override through
 *     `PUT /api/workspace/agents/:id/abilities`: off = deny, on = cleared back
 *     to the deployment's own rules. Never optimistic (see `agent-abilities`).
 *   - **"See everything it can do"** — the old permissions list, moved into a
 *     Dialog rather than dropped. It is still the honest answer to "what can
 *     this agent reach", including the unrestricted-tools warning.
 *   - **Granted by you** — the grants a person made, with Revoke. Moved, not
 *     dropped: until connectors-rail slice 9 gives connection grants a home in
 *     the connector details view, this is the ONLY place any of them can be
 *     taken back, so every row stays here for now.
 *
 * The connector list (slice 6, TASK-739) sits above "Other abilities" — see
 * `AgentConnectors`. Its "+ Add" swaps the whole tab for the Add subview
 * (`AddConnector`, slice 7) until the person goes back or a connector is
 * attached.
 */
import { Fragment, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Globe,
  Link as LinkIcon,
  Terminal,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAgentAbilities } from '@/lib/agent-abilities';
import type { AgentRailData, GrantRow } from '@/lib/workspace-api';
import type { AgentAbility } from '@/lib/workspace-types';
import { AddConnector } from './AddConnector';
import { AgentConnectors } from './AgentConnectors';
import { GrantLine, PermissionLine, ReadFailure, SectionLabel } from './bits';

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

/** Product words in, in the order the Figma frame draws them. */
const ABILITY_ROWS: ReadonlyArray<{
  ability: AgentAbility;
  label: string;
  Icon: typeof Globe;
}> = [
  { ability: 'webSearch', label: 'Web search', Icon: Globe },
  { ability: 'readPages', label: 'Read web pages', Icon: LinkIcon },
  { ability: 'runCode', label: 'Run code', Icon: Terminal },
];

/**
 * Run code's one caveat. The design gave it a help line; the product owner
 * removed every ability subtitle, so it lives where it is needed instead: in
 * the confirmation before switching it off, and as the switch's description
 * for a screen reader while it IS off.
 */
export const RUN_CODE_OFF_WARNING = "Some skills won't work.";

interface Props {
  agentId: string;
  name: string;
  rail: AgentRailData | null;
  loading: boolean;
  error: string | null;
  revoking: ReadonlySet<string>;
  notice: string | null;
  onRevoke: (row: GrantRow) => void;
  /** Re-read the rail after a connector is removed (its grants went too). */
  onConnectorsChanged?: () => void;
}

export function ConnectorsTab({
  agentId,
  name,
  rail,
  loading,
  error,
  revoking,
  notice,
  onRevoke,
  onConnectorsChanged,
}: Props) {
  const [everything, setEverything] = useState(false);
  // Keyed by agent, so switching agents never lands on another one's Add view.
  const [addingFor, setAddingFor] = useState<string | null>(null);
  if (addingFor === agentId) {
    return (
      <AddConnector
        agentId={agentId}
        name={name}
        onBack={() => setAddingFor(null)}
        onAttached={() => {
          setAddingFor(null);
          onConnectorsChanged?.();
        }}
      />
    );
  }
  const grantCount =
    rail?.grants.status === 'ok' ? rail.grants.rows.length : null;
  return (
    <>
      <AgentConnectors
        agentId={agentId}
        name={name}
        {...(onConnectorsChanged !== undefined ? { onChanged: onConnectorsChanged } : {})}
        onAdd={() => setAddingFor(agentId)}
      />
      <SectionLabel>Other abilities</SectionLabel>
      <OtherAbilities agentId={agentId} name={name} />
      <p className="mt-3 text-[12px] text-muted-foreground">
        Changes apply to {name} only.{' '}
        <Button
          type="button"
          variant="link"
          onClick={() => setEverything(true)}
          className="h-auto p-0 text-[12px]"
        >
          See everything it can do
        </Button>
      </p>
      {/*
        The reach list lives behind the link now, so a rail that would not load
        has to say so HERE too — otherwise the tab reads as complete when the
        one record of what this agent can reach never arrived.
      */}
      {rail === null && !loading && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          We couldn’t read what {name} can reach just now. Treat it as unknown
          rather than empty.
        </p>
      )}
      <Collapsible className="mt-6">
        <h3 className="text-[11.5px] font-medium text-muted-foreground">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group -ml-2 h-7 gap-1 px-2 text-[11.5px] font-medium text-muted-foreground"
            >
              <ChevronRight
                data-icon="inline-start"
                aria-hidden="true"
                className="transition-transform group-data-[state=open]:rotate-90"
              />
              Granted by you
              {grantCount !== null && (
                <span className="tabular-nums">{grantCount}</span>
              )}
            </Button>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="pt-2">
          <Grants
            rail={rail}
            loading={loading}
            revoking={revoking}
            notice={notice}
            onRevoke={onRevoke}
          />
        </CollapsibleContent>
      </Collapsible>
      <Dialog open={everything} onOpenChange={setEverything}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Everything {name} can do</DialogTitle>
            <DialogDescription>
              Rules guide it. They don’t limit which tools it can reach.
            </DialogDescription>
          </DialogHeader>
          <Permissions
            name={name}
            rail={rail}
            loading={loading}
            error={error}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function OtherAbilities({ agentId, name }: { agentId: string; name: string }) {
  const { abilities, status, pending, set } = useAgentAbilities(agentId);
  const [failed, setFailed] = useState(false);
  const [confirmRunCodeOff, setConfirmRunCodeOff] = useState(false);

  async function change(ability: AgentAbility, enabled: boolean) {
    setFailed(false);
    const ok = await set(ability, enabled);
    if (!ok) setFailed(true);
  }

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (status !== 'ok' || abilities === null) {
    return (
      <Note>
        {status === 'unavailable'
          ? 'This workspace can’t switch these on or off yet.'
          : 'We couldn’t read these just now.'}
      </Note>
    );
  }
  return (
    <>
      <Card className="shadow-none">
        {ABILITY_ROWS.map(({ ability, label, Icon }, i) => {
          const id = `ability-${ability}`;
          const on = abilities[ability];
          return (
            <Fragment key={ability}>
              {i > 0 && <Separator />}
              <div className="flex h-11 items-center gap-2.5 px-3">
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <Label
                  htmlFor={id}
                  className="flex-1 text-[13px] font-normal"
                >
                  {label}
                </Label>
                <Switch
                  id={id}
                  checked={on}
                  disabled={pending.has(ability)}
                  aria-description={
                    ability === 'runCode' && !on
                      ? RUN_CODE_OFF_WARNING
                      : undefined
                  }
                  onCheckedChange={(next) => {
                    if (ability === 'runCode' && !next) {
                      setConfirmRunCodeOff(true);
                      return;
                    }
                    void change(ability, next);
                  }}
                />
              </div>
            </Fragment>
          );
        })}
      </Card>
      {failed && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>
            We couldn’t change that just now. Nothing changed.
          </AlertDescription>
        </Alert>
      )}
      <Dialog open={confirmRunCodeOff} onOpenChange={setConfirmRunCodeOff}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off Run code for {name}?</DialogTitle>
            <DialogDescription>
              {RUN_CODE_OFF_WARNING} Anything that needs to run a script will
              stop at that step. You can turn it back on any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRunCodeOff(false)}
            >
              Keep it on
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRunCodeOff(false);
                void change('runCode', false);
              }}
            >
              Turn off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The security claim: what this agent may reach. Never drawn as an empty list
 * when we could not read it — an agent with no list shown is not an agent
 * with no reach (design H4).
 */
function Permissions({
  name,
  rail,
  loading,
  error,
}: {
  name: string;
  rail: AgentRailData | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading && rail === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }
  if (rail === null) {
    return (
      <Note>
        {error === null
          ? 'We can’t show this yet.'
          : 'We couldn’t read this just now.'}{' '}
        Until it loads, treat what {name} may do as unknown rather than empty.
      </Note>
    );
  }
  const { status, rows, incomplete, unrestrictedTools } = rail.permissions;
  if (status !== 'ok') {
    return (
      <Note>
        {status === 'unavailable'
          ? `This deployment doesn’t publish the rules that govern ${name}.`
          : `We couldn’t read the rules that govern ${name} just now.`}{' '}
        Treat this as unknown rather than empty — an agent with no list shown is
        not an agent with no reach.
      </Note>
    );
  }
  return (
    <div className="flex flex-col">
      {rows.length === 0 && (
        <Note>
          Nothing here describes {name}&apos;s reach yet. That means we
          can&apos;t tell you — not that there isn&apos;t any.
        </Note>
      )}
      {rows.length > 0 && (
        <div className="flex flex-col">
          {rows.map((row, i) => (
            <Fragment key={`${row.source}#${String(i)}`}>
              {/*
                  A rule from the group above ends here. Twenty rows separated
                  only by a small coloured glyph is a list nobody scans; a
                  hairline between "can", "asks first" and "never" makes the
                  three blocks findable without adding three headings that
                  repeat what each row already says.
                */}
              {i > 0 && rows[i - 1]?.verdict !== row.verdict && (
                <Separator className="my-2" />
              )}
              <PermissionLine row={row} />
            </Fragment>
          ))}
        </div>
      )}
      {unrestrictedTools && (
        <Alert className="mt-3">
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>
            Nothing limits which tools {name} can use — it can reach anything
            installed here, now or later. The rules above are what&apos;s
            installed today, not a boundary.
          </AlertDescription>
        </Alert>
      )}
      {incomplete && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          One of the places we look didn&apos;t answer, so the rules above may
          be missing something. It is not a complete list of what {name} cannot
          do.
        </p>
      )}
    </div>
  );
}

/**
 * "Granted by you" — the group a person can act on, and the one they are most
 * likely to have forgotten they created (design §4.3.4).
 */
/*
  No `error` prop any more (TASK-288). It existed only to glue the raw thrown
  message into the sentence below; `rail === null && !loading` already says
  everything this group can act on, and the cause is a console line now.
*/
function Grants({
  rail,
  loading,
  revoking,
  notice,
  onRevoke,
}: {
  rail: AgentRailData | null;
  loading: boolean;
  revoking: ReadonlySet<string>;
  notice: string | null;
  onRevoke: (row: GrantRow) => void;
}) {
  if (rail === null) {
    if (loading) return <Note>Reading what you&apos;ve granted…</Note>;
    return (
      <Note>
        {/*
          The raw detail used to ride in a parenthetical here — `We couldn't
          read this just now (workspace /agents/ag_… → 401).` A request path
          inside a sentence is the one shape a grep for a raw status never
          finds. `workspace-rail.ts` logs it now (TASK-288).
        */}
        We couldn&apos;t read this just now.
      </Note>
    );
  }
  const { status, rows, incomplete } = rail.grants;
  if (status !== 'ok') {
    return (
      <ReadFailure status={status} what="a record of what you've granted" />
    );
  }
  return (
    <div className="flex flex-col">
      {rows.length === 0 && (
        <Note>
          Nothing yet — you haven&apos;t granted anything beyond the rules
          above.
        </Note>
      )}
      {rows.map((row, i) => (
        <GrantLine
          key={`${row.source}#${String(i)}`}
          row={row}
          busy={revoking.has(row.source)}
          onRevoke={onRevoke}
        />
      ))}
      {incomplete && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          One of the places we look didn&apos;t answer, so there may be more
          than this.
        </p>
      )}
      {notice !== null && (
        <p className="mt-2 text-[11.5px] text-muted-foreground">{notice}</p>
      )}
    </div>
  );
}
