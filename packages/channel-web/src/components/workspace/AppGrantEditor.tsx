/**
 * Give a linked app one connector's tools, or change what it has.
 *
 * Only tools set to Allow can be newly ticked. A connector's tools start at
 * Ask first, and an app has nobody to ask, so a call to one would always be
 * held: offering it here would be a grant that can never work. The rest say
 * why and where to change it. The server still checks the agent's policy on
 * every call, so a tool tightened after it was granted stops working at once.
 *
 * A tool the grant already holds stays ticked even when it is no longer
 * Allow, so saving some other change (the mode, say) never quietly narrows
 * the grant: it can be unticked, but not ticked again until it is Allow. A
 * granted tool the connector no longer offers can't be kept (the server
 * refuses a key the connector doesn't list), and its row says saving removes
 * it.
 *
 * Tool names and descriptions are the connector server's own words
 * (untrusted): rendered as text only.
 */
import { useEffect, useState } from 'react';
import type { AppGrant, AppLink, AppMode } from '@ax/apps-bridge-contract';
import { TOOL_KEY_RE } from '@ax/apps-bridge-contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useHeldThroughClose } from './use-held-through-close';
import { agentAppsErrorCopy, agentAppsStale, saveGrant } from '@/lib/agent-apps';
import { useAgentConnectors } from '@/lib/agent-connectors';
import { useConnectorTools } from '@/lib/agent-connector-tools';
import { logRequestFailure } from '@/lib/http';
import type { AgentConnectorTool } from '@/lib/workspace-types';

export const APP_MODE_COPY: Record<AppMode, { choice: string; badge: string }> = {
  builder: { choice: "This agent's sign-in", badge: "This agent's sign-in" },
  viewer: { choice: "Each viewer's own sign-in, after they say yes", badge: "Each viewer's sign-in" },
};

const WHY_NOT: Record<Exclude<AgentConnectorTool['verdict'], 'allow'>, string> = {
  hold: "Asks first, so apps can't use it. Set it to Allow under Connectors.",
  deny: "Set to Deny under Connectors, so apps can't use it.",
};

const STILL_GIVEN = "Still given to this app, but it won't work until it's set to Allow under Connectors.";

/** The tool's name as an app calls it: the last part of its key. */
function toolNameOf(toolKey: string): string {
  return TOOL_KEY_RE.exec(toolKey)?.[2] ?? toolKey;
}

export interface AppGrantEditorTarget {
  link: AppLink;
  /** The grant being changed, or null to add a connector. */
  grant: AppGrant | null;
}

export function AppGrantEditor({
  agentId,
  target,
  onClose,
  onSaved,
  onStale,
}: {
  agentId: string;
  /** What to edit; `null` keeps the dialog closed. */
  target: AppGrantEditorTarget | null;
  onClose: () => void;
  onSaved: () => void;
  /** The page showed something that has changed since: read it again. */
  onStale: () => void;
}) {
  // Drawn through the close animation; the body unmounts once the dialog has closed.
  const { held, release } = useHeldThroughClose(target);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" onCloseAutoFocus={release}>
        {held !== null && (
          <EditorBody
            key={`${held.link.appId}:${held.grant?.connectorId ?? ''}`}
            agentId={agentId}
            target={held}
            onClose={onClose}
            onSaved={onSaved}
            onStale={onStale}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({
  agentId,
  target,
  onClose,
  onSaved,
  onStale,
}: {
  agentId: string;
  target: AppGrantEditorTarget;
  onClose: () => void;
  onSaved: () => void;
  onStale: () => void;
}) {
  const { link, grant } = target;
  const connectors = useAgentConnectors(agentId);
  const [connectorId, setConnectorId] = useState<string | null>(grant?.connectorId ?? null);
  const [mode, setMode] = useState<AppMode>(grant?.mode ?? 'builder');
  // Starts from what the grant holds (see the header for which of those can stay).
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(grant?.tools.map((t) => t.toolKey) ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Allow tools, plus tools the grant holds that the connector still offers: what Save may send.
  const [savable, setSavable] = useState<ReadonlySet<string>>(new Set());

  // A connector this app already has is changed with its Edit, not added twice.
  const taken = new Set(link.grants.map((g) => g.connectorId));
  const options = (connectors.connectors ?? []).filter((c) => grant !== null || !taken.has(c.id));
  const chosen = [...picked].filter((k) => savable.has(k));
  const connectorsFailed = connectors.status === 'failed' || connectors.status === 'unavailable';

  async function save() {
    if (connectorId === null || chosen.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await saveGrant(agentId, { appId: link.appId, connectorId, mode, toolKeys: chosen });
      onSaved();
    } catch (err) {
      logRequestFailure(err, 'agent-apps');
      if (agentAppsStale(err)) onStale();
      setError(agentAppsErrorCopy(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{grant === null ? 'Add a connector' : `Edit ${grant.connectorName}`}</DialogTitle>
        <DialogDescription>
          What <span className="font-medium text-foreground">{link.appName}</span> can use, and whose sign-in it uses.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="app-grant-connector">Connector</FieldLabel>
          <Select
            value={connectorId ?? ''}
            disabled={grant !== null || saving}
            onValueChange={(next) => {
              setConnectorId(next);
              setPicked(new Set());
            }}
          >
            <SelectTrigger id="app-grant-connector">
              <SelectValue placeholder={connectors.status === 'loading' ? 'Loading connectors…' : 'Choose a connector'}>
                {grant !== null ? grant.connectorName : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {connectors.status === 'ok' && options.length === 0 && grant === null && (
            <FieldDescription>Every connector on this agent is already given to this app.</FieldDescription>
          )}
          {connectorsFailed && grant === null && (
            <FieldDescription className="flex flex-wrap items-center gap-2" role="alert">
              We couldn&apos;t load this agent&apos;s connectors.
              <Button variant="outline" size="sm" onClick={() => void connectors.refresh()}>
                Try again
              </Button>
            </FieldDescription>
          )}
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Whose sign-in it uses</FieldLegend>
          <RadioGroup
            value={mode}
            disabled={saving}
            onValueChange={(v) => {
              if (v === 'builder' || v === 'viewer') setMode(v);
            }}
          >
            {(['builder', 'viewer'] as const).map((m) => (
              <Field key={m} orientation="horizontal">
                <RadioGroupItem value={m} id={`app-grant-mode-${m}`} />
                <FieldLabel htmlFor={`app-grant-mode-${m}`}>{APP_MODE_COPY[m].choice}</FieldLabel>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        {connectorId !== null && (
          <ToolPicker
            agentId={agentId}
            connectorId={connectorId}
            granted={grant?.tools ?? []}
            picked={picked}
            disabled={saving}
            onSavable={setSavable}
            onToggle={(key, on) =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (on) next.add(key);
                else next.delete(key);
                return next;
              })
            }
          />
        )}
      </FieldGroup>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving || connectorId === null || chosen.length === 0}>
          {saving && <Spinner data-icon="inline-start" aria-hidden="true" />}
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

function ToolPicker({
  agentId,
  connectorId,
  granted,
  picked,
  disabled,
  onSavable,
  onToggle,
}: {
  agentId: string;
  connectorId: string;
  granted: AppGrant['tools'];
  picked: ReadonlySet<string>;
  disabled: boolean;
  /** The keys Save may send: Allow tools, and granted tools still offered. */
  onSavable: (keys: ReadonlySet<string>) => void;
  onToggle: (toolKey: string, on: boolean) => void;
}) {
  const { data, status, reload } = useConnectorTools(agentId, connectorId);
  const tools = data?.tools ?? [];
  const grantedKeys = new Set(granted.map((t) => t.toolKey));
  const savableKeys = tools.filter((t) => t.verdict === 'allow' || grantedKeys.has(t.toolKey)).map((t) => t.toolKey);
  // Tool names are printable ASCII without spaces, so a newline can't occur in a key.
  const savableSig = savableKeys.join('\n');
  useEffect(() => {
    // Tell the editor which keys can be saved, once per change in the list.
    onSavable(new Set(savableSig === '' ? [] : savableSig.split('\n')));
  }, [savableSig, onSavable]);

  const offered = new Set(tools.map((t) => t.toolKey));
  const gone = granted.filter((t) => !offered.has(t.toolKey));

  return (
    <FieldSet>
      <FieldLegend variant="label">Tools</FieldLegend>
      {status === 'loading' ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">Loading tools…</span>
          <Skeleton className="h-8 w-full" aria-hidden="true" />
          <Skeleton className="h-8 w-full" aria-hidden="true" />
        </div>
      ) : status !== 'ok' ? (
        <FieldDescription className="flex flex-wrap items-center gap-2" role="alert">
          We couldn&apos;t list this connector&apos;s tools just now.
          <Button variant="outline" size="sm" onClick={() => reload()}>
            Try again
          </Button>
        </FieldDescription>
      ) : tools.length === 0 && gone.length === 0 ? (
        <FieldDescription>This connector doesn&apos;t offer any tools right now.</FieldDescription>
      ) : (
        <ul aria-label="Tools" className="m-0 flex list-none flex-col gap-3 p-0">
          {tools.map((t) => {
            const name = toolNameOf(t.toolKey);
            const id = `app-grant-tool-${t.toolKey}`;
            const can = t.verdict === 'allow';
            const on = picked.has(t.toolKey);
            // A ticked tool that isn't Allow is one the grant already holds: it can be unticked, never re-ticked.
            const locked = disabled || (!can && !on);
            return (
              <li key={t.toolKey}>
                <Field orientation="horizontal" data-disabled={locked || undefined}>
                  <Checkbox
                    id={id}
                    checked={on}
                    disabled={locked}
                    onCheckedChange={(on) => onToggle(t.toolKey, on === true)}
                  />
                  <FieldContent className="min-w-0">
                    <FieldLabel htmlFor={id} className="break-all font-mono">
                      {name}
                    </FieldLabel>
                    {t.description !== '' && (
                      <FieldDescription className="line-clamp-2">{t.description}</FieldDescription>
                    )}
                    {t.verdict !== 'allow' && (
                      <FieldDescription>{on ? STILL_GIVEN : WHY_NOT[t.verdict]}</FieldDescription>
                    )}
                  </FieldContent>
                </Field>
              </li>
            );
          })}
          {gone.map((t) => (
            <li key={t.toolKey} className="flex flex-wrap items-baseline gap-x-2 pl-6">
              <span className="break-all font-mono text-sm text-muted-foreground">{t.name}</span>
              <span className="text-sm text-muted-foreground">No longer offered. Saving removes it.</span>
            </li>
          ))}
        </ul>
      )}
    </FieldSet>
  );
}
