/** The agent settings Connectors section, including its built-in ability controls. */
import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  Globe,
  Link as LinkIcon,
  Terminal,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field';
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
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAgentAbilities } from '@/lib/agent-abilities';
import type { AgentRailData, GrantRow } from '@/lib/workspace-api';
import type { AgentAbility } from '@/lib/workspace-types';
import { AddConnector } from './AddConnector';
import { AgentConnectors } from './AgentConnectors';
import { GrantLine, PermissionLine, ReadFailure } from './bits';

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * What ON means for Read web pages (TASK-763, owner decision 2026-10-03).
 * Its built-in rule is Ask first (`web_extract` holds for a site nobody has
 * cleared yet), and this switch can only turn that OFF. ON never means
 * "reads without asking", so the row says so — only while it is ON
 * (TASK-769): an off switch reads no pages, so it claims nothing about
 * asking. No "On:" prefix (TASK-789, owner decision 2026-10-03): the note
 * only ever shows while the switch is on, so the prefix said nothing.
 */
export const READ_PAGES_ASKS_FIRST = 'Asks you before opening a new site';

/**
 * Run code's one caveat. The design gave it a help line; the product owner
 * removed every ability subtitle (a same-row hint is not a subtitle), so it
 * lives where it is needed instead: in the confirmation before switching it
 * off, and as the row's note while it IS off.
 */
export const RUN_CODE_OFF_WARNING = "Some skills won't work.";

/**
 * A row's note (TASK-789): ONE rule per row and state, so a sighted user and
 * a screen-reader user always get the same claim. `hint` is the few muted
 * words on the label's own row (never a subtitle line — the rail is too
 * narrow for the full sentence); `description` is that same claim as a
 * sentence, read as the switch's description. Both or neither, never one.
 */
interface RowNote {
  hint: string;
  description: string;
}

/** Product words in, in the order the Figma frame draws them. */
const ABILITY_ROWS: ReadonlyArray<{
  ability: AgentAbility;
  label: string;
  Icon: typeof Globe;
  /** The row's note for the switch's current state, or none. */
  note: (on: boolean) => RowNote | undefined;
}> = [
  { ability: 'webSearch', label: 'Web search', Icon: Globe, note: () => undefined },
  {
    ability: 'readPages',
    label: 'Read web pages',
    Icon: LinkIcon,
    note: (on) =>
      on ? { hint: '· asks first', description: READ_PAGES_ASKS_FIRST } : undefined,
  },
  {
    ability: 'runCode',
    label: 'Run code',
    Icon: Terminal,
    note: (on) =>
      on ? undefined : { hint: '· skills limited', description: RUN_CODE_OFF_WARNING },
  },
];

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
  const [viewing, setViewing] = useState<string | null>(null);
  const [listed, setListed] = useState<ReadonlySet<string> | null>(null);
  const onListed = useCallback((ids: ReadonlySet<string> | null) => setListed(ids), []);
  // Another agent's rail never opens on this one's connector.
  useEffect(() => setViewing(null), [agentId]);
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
  const allGrants = rail?.grants.status === 'ok' ? rail.grants.rows : [];
  const ownGrants = (rows: GrantRow[]) =>
    rows.filter((g) => !hasDetailsHome(g, listed));
  const grantCount =
    rail?.grants.status === 'ok' ? ownGrants(rail.grants.rows).length : null;
  const connectors = (
    <AgentConnectors
      agentId={agentId}
      name={name}
      {...(onConnectorsChanged !== undefined ? { onChanged: onConnectorsChanged } : {})}
      onAdd={() => setAddingFor(agentId)}
      viewing={viewing}
      onView={setViewing}
      grants={allGrants}
      // TASK-757 — a rail that never arrived, or whose grants read failed,
      // is "unknown", not "none": the details view must not just go quiet.
      grantsFailed={!loading && (rail === null || rail.grants.status === 'failed')}
      revoking={revoking}
      onRevoke={onRevoke}
      onListed={onListed}
    />
  );
  if (viewing !== null) return connectors;
  return (
    <>
      {connectors}
      <FieldSet className="mt-8" aria-labelledby="agent-abilities-heading">
        <div>
          <h3 id="agent-abilities-heading" className="text-[15px] font-semibold">What {name} can do</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Built-in abilities. Turn off anything {name} doesn't need. Fewer abilities means less that can go wrong.
          </p>
        </div>
        <OtherAbilities agentId={agentId} name={name} />
      </FieldSet>
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
            filter={ownGrants}
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
      <Card className="overflow-hidden p-0 shadow-none">
        <CardContent className="p-0">
        <FieldGroup className="gap-0">
        {ABILITY_ROWS.map(({ ability, label, Icon, note }, i) => {
          const id = `ability-${ability}`;
          const on = abilities[ability];
          // One rule feeds both, so the row never shows what it doesn't say.
          const rowNote = note(on);
          const shownHint = rowNote?.hint;
          const description = rowNote?.description;
          const descriptionId = description ? `${id}-description` : undefined;
          return (
            <Fragment key={ability}>
              {i > 0 && <Separator />}
              <Field orientation="horizontal" data-disabled={pending.has(ability)} className="min-h-14 gap-2.5 px-4 py-3">
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <FieldLabel
                  htmlFor={id}
                  className="flex-1 text-[13px] font-normal"
                >
                  {label}
                  {shownHint && (
                    // Hidden from the accessible NAME on purpose: the switch
                    // keeps its plain label, and a screen reader hears the
                    // fuller sentence as its description instead (below).
                    <span aria-hidden="true" className="ml-1 text-muted-foreground">
                      {shownHint}
                    </span>
                  )}
                </FieldLabel>
                <Switch
                  id={id}
                  checked={on}
                  disabled={pending.has(ability)}
                  aria-describedby={descriptionId}
                  onCheckedChange={(next) => {
                    if (ability === 'runCode' && !next) {
                      setConfirmRunCodeOff(true);
                      return;
                    }
                    void change(ability, next);
                  }}
                />
                {description && (
                  // TASK-768 — aria-describedby, not aria-description: the
                  // latter is read unevenly (VoiceOver). `hidden` keeps the
                  // sentence out of browse-mode reading (no echo after the
                  // row) while the switch's description still resolves it.
                  <span id={descriptionId} hidden>
                    {description}
                  </span>
                )}
              </Field>
            </Fragment>
          );
        })}
        </FieldGroup>
        </CardContent>
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
  filter,
  loading,
  revoking,
  notice,
  onRevoke,
}: {
  rail: AgentRailData | null;
  /** Drops the rows that live in a connector's details view instead. */
  filter: (rows: GrantRow[]) => GrantRow[];
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
  const { status, incomplete } = rail.grants;
  if (status !== 'ok') {
    return (
      <ReadFailure status={status} what="a record of what you've granted" />
    );
  }
  const rows = filter(rail.grants.rows);
  const moved = rail.grants.rows.length - rows.length;
  return (
    <div className="flex flex-col">
      {rows.length === 0 && moved === 0 && (
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
      {moved > 0 && (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Access you approved for a connector is in that connector&apos;s
          details.
        </p>
      )}
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

/** A grant made for a connector this agent's list currently shows: its
 *  Revoke lives in that connector's details view. */
function hasDetailsHome(g: GrantRow, listed: ReadonlySet<string> | null): boolean {
  return listed !== null && g.grantedFor?.kind === 'connection' && listed.has(g.grantedFor.id);
}
