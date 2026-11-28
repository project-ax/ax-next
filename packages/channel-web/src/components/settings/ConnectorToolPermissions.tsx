/**
 * "Tool permissions" — per-tool defaults in the connector editor (TASK-737).
 *
 * Agents copy these defaults when the connector is attached and may only make
 * them stricter. The section is controlled: `useToolPermissions` lives in the
 * editor so its Save can write the changed rows.
 *
 * Always visible, never collapsed: a prefilled choice (read-only → Allow,
 * anything else → Ask first) is written on Save, so it must be on screen first.
 * Until then each such row carries a "Suggested" badge (TASK-764): the choice
 * came from the server's own, unchecked, description of the tool.
 *
 * SECURITY — tool titles and descriptions are written by the connector's
 * server, not by us. They render as React text only (never markup), the
 * description is clamped, and it sits behind a popover that says whose words
 * they are.
 */
import { Ban, Check, Hand, Info, type LucideIcon } from 'lucide-react';
import {
  clampDescription,
  groupTools,
  toolRows,
  type InventoryTool,
  type ToolPermissions,
  type ToolVerdict,
} from '@/lib/connector-tool-permissions';
import type { ToolPermissionsState } from '@/lib/use-tool-permissions';
import { cn } from '@/lib/utils';
import { AsyncState, InsetBlock, List, ListRow, Notice, StatusBadge } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import { FieldDescription, FieldSet, FieldLegend } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** Shared with the rail's connector details view (TASK-742): one look for the three choices. */
export const TOOL_VERDICT_OPTIONS: { value: ToolVerdict; label: string; Icon: LucideIcon; on: string }[] = [
  {
    value: 'allow',
    label: 'Allow',
    Icon: Check,
    on: 'data-[state=on]:bg-primary-soft data-[state=on]:text-primary',
  },
  {
    value: 'hold',
    label: 'Ask first',
    Icon: Hand,
    on: 'data-[state=on]:bg-warning-soft data-[state=on]:text-warning',
  },
  {
    value: 'deny',
    label: 'Deny',
    Icon: Ban,
    on: 'data-[state=on]:bg-destructive-soft data-[state=on]:text-destructive',
  },
];

const STILL_SAVES =
  'Everything else still saves. Until you choose, agents ask before using any of its tools.';

function displayTitle(tool: InventoryTool): string {
  return tool.title.trim() || tool.name.trim() || tool.toolKey;
}

function TheirDescription({
  connectorName,
  title,
  description,
}: {
  connectorName: string;
  title: string;
  description: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label={`What ${connectorName} says ${title} does`}
        >
          <Info />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="text-xs font-medium text-muted-foreground">
          What {connectorName} says it does
        </p>
        <InsetBlock>
          <blockquote className="m-0 whitespace-pre-line break-words text-sm italic text-muted-foreground">
            {clampDescription(description)}
          </blockquote>
        </InsetBlock>
        <p className="mt-2.5 text-xs text-muted-foreground">
          Those are their words, not ours. We haven’t checked them.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function ToolRow({
  tool,
  verdict,
  suggested,
  connectorName,
  onChange,
}: {
  tool: InventoryTool;
  verdict: ToolVerdict | undefined;
  /** The choice is our untouched prefill, not a saved one. */
  suggested: boolean;
  connectorName: string;
  onChange: (verdict: ToolVerdict) => void;
}) {
  const title = displayTitle(tool);
  return (
    <ListRow
      title={title}
      {...(suggested ? { meta: <StatusBadge tone="neutral">Suggested</StatusBadge> } : {})}
      trailing={<>
        {tool.description.trim() && (
          <TheirDescription
            connectorName={connectorName}
            title={title}
            description={tool.description}
          />
        )}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label={`Permission for ${title}`}
          value={verdict ?? ''}
          onValueChange={(value) => {
            // A single toggle group lets you click the selected item off; a tool
            // always has exactly one choice, so ignore the empty value.
            if (value) onChange(value as ToolVerdict);
          }}
        >
          {TOOL_VERDICT_OPTIONS.map(({ value, label, Icon, on }) => (
            <ToggleGroupItem key={value} value={value} aria-label={label} className={cn(on)}>
              <Icon />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </>}
    />
  );
}

function ToolGroup({
  label,
  caption,
  tools,
  state,
  connectorName,
}: {
  label: string;
  caption?: string | undefined;
  tools: InventoryTool[];
  state: ToolPermissionsState;
  connectorName: string;
}) {
  if (!tools.length) return null;
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">{label}</h4>
        {caption && <span className="text-xs text-muted-foreground">{caption}</span>}
      </div>
      <List label={`${label} tool permissions`} density="compact">
        {tools.map((tool) => (
          <ToolRow
            key={tool.toolKey}
            tool={tool}
            verdict={state.verdicts.get(tool.toolKey)}
            suggested={state.suggested.has(tool.toolKey)}
            connectorName={connectorName}
            onChange={(v) => state.setVerdict(tool.toolKey, v)}
          />
        ))}
      </List>
    </section>
  );
}

function unavailableMessage(data: ToolPermissions): string {
  switch (data.status) {
    case 'needs-auth':
      return 'Sign in to this connector to see its tools.';
    case 'unreachable':
      return 'We couldn’t reach this connector to list its tools.';
    case 'unknown':
      return 'We can’t list this connector’s tools right now.';
    case 'ok':
      return data.defaults.length > 0
        ? 'This connector didn’t list any tools this time. The ones you set before are below.'
        : 'This connector didn’t list any tools.';
  }
}

export function ConnectorToolPermissions({
  state,
  connectorName,
  isNew,
}: {
  state: ToolPermissionsState;
  connectorName: string;
  /** A connector that hasn't been saved yet has no tools to configure. */
  isNew: boolean;
}) {
  if (isNew)
    return (
      <p className="text-sm text-muted-foreground">
        Once it’s saved, you can choose what each of its tools may do.
      </p>
    );
  const { load } = state;
  if (load.kind === 'hidden') return null;

  let body;
  if (load.kind === 'loading') {
    body = <AsyncState status="loading" skeleton="rows" loadingLabel="Looking up this connector’s tools" />;
  } else if (load.kind === 'error') {
    body = (
      <Notice tone="danger" action={{ label: 'Try again', onClick: () => state.reload() }}>
        We couldn’t load tool permissions. Everything else still saves.
      </Notice>
    );
  } else {
    const { data } = load;
    const unavailable = data.status !== 'ok' || data.tools.length === 0;
    const failedRead = data.status === 'unreachable' || data.status === 'unknown';
    const groups = groupTools(toolRows(data));
    body = (
      <>
        {state.suggested.size > 0 && (
          // A suggestion comes from how each tool describes ITSELF, which we
          // can't check. Save writes every choice on screen, suggestions
          // included (TASK-764), so say so before the person presses Save.
          <p data-testid="tool-permission-suggestions" className="text-sm text-muted-foreground">
            Suggestions come from how the connector describes its tools — check them
            before saving.
          </p>
        )}
        {unavailable && (
          // Couldn't reach it (or couldn't list) is a failed read, so it offers
          // a retry; needing sign-in or an honestly empty list is just news.
          <Notice
            tone={failedRead ? 'danger' : 'info'}
            {...(failedRead
              ? { action: { label: 'Try again', onClick: () => state.reload(true) } }
              : {})}
          >
            {unavailableMessage(data)} {STILL_SAVES}
          </Notice>
        )}
        <ToolGroup
          label="Looks things up"
          tools={groups.looksUp}
          state={state}
          connectorName={connectorName}
        />
        <ToolGroup
          label="Makes changes"
          caption={
            groups.makesChanges.some((t) => t.outward === true)
              ? 'Others may see these'
              : undefined
          }
          tools={groups.makesChanges}
          state={state}
          connectorName={connectorName}
        />
      </>
    );
  }

  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label" className="mb-0">
        Tool permissions
      </FieldLegend>
      <FieldDescription>
        Choose what agents may do with each tool. People can make these stricter
        for their own agent, never looser.
      </FieldDescription>
      <ul
        aria-label="What each choice means"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      >
        {TOOL_VERDICT_OPTIONS.map(({ value, label, Icon }) => (
          <li key={value} className="flex items-center gap-1">
            <Icon aria-hidden="true" className="size-3.5" />
            {label}
          </li>
        ))}
      </ul>
      {body}
    </FieldSet>
  );
}
