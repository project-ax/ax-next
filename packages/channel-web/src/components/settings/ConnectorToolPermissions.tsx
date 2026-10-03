/**
 * "Tool permissions" — per-tool defaults in the connector editor (TASK-737).
 *
 * Agents copy these defaults when the connector is attached and may only make
 * them stricter. The section is controlled: `useToolPermissions` lives in the
 * editor so its Save can write the changed rows.
 *
 * Always visible, never collapsed: a prefilled choice (read-only → Allow,
 * anything else → Ask first) is written on Save, so it must be on screen first.
 *
 * SECURITY — tool titles and descriptions are written by the connector's
 * server, not by us. They render as React text only (never markup), the
 * description is clamped, and it sits behind a popover that says whose words
 * they are.
 */
import { Ban, Check, Hand, Info, Loader2, type LucideIcon } from 'lucide-react';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldDescription, FieldSet, FieldLegend } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const OPTIONS: { value: ToolVerdict; label: string; Icon: LucideIcon; on: string }[] = [
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
        <blockquote className="mt-1.5 whitespace-pre-line break-words border-l-2 border-border pl-2.5 text-sm italic text-muted-foreground">
          {clampDescription(description)}
        </blockquote>
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
  connectorName,
  onChange,
}: {
  tool: InventoryTool;
  verdict: ToolVerdict | undefined;
  connectorName: string;
  onChange: (verdict: ToolVerdict) => void;
}) {
  const title = displayTitle(tool);
  return (
    <li className="flex min-h-10 items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm" title={title}>
        {title}
      </span>
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
        {OPTIONS.map(({ value, label, Icon, on }) => (
          <ToggleGroupItem key={value} value={value} aria-label={label} className={cn(on)}>
            <Icon />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </li>
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
      <ul className="flex flex-col gap-1">
        {tools.map((tool) => (
          <ToolRow
            key={tool.toolKey}
            tool={tool}
            verdict={state.verdicts.get(tool.toolKey)}
            connectorName={connectorName}
            onChange={(v) => state.setVerdict(tool.toolKey, v)}
          />
        ))}
      </ul>
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
      return 'This connector didn’t list any tools.';
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
    body = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        Looking up this connector’s tools…
      </p>
    );
  } else if (load.kind === 'error') {
    body = (
      <Alert>
        <AlertDescription className="flex flex-col gap-3">
          <p>We couldn’t load tool permissions. Everything else still saves.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => state.reload()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else {
    const { data } = load;
    const unavailable = data.status !== 'ok' || data.tools.length === 0;
    const groups = groupTools(toolRows(data));
    body = (
      <>
        {unavailable && (
          <Alert>
            <AlertDescription className="flex flex-col gap-3">
              <p>
                {unavailableMessage(data)} {STILL_SAVES}
              </p>
              {data.status === 'unreachable' && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => state.reload(true)}
                >
                  Check again
                </Button>
              )}
            </AlertDescription>
          </Alert>
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
        {OPTIONS.map(({ value, label, Icon }) => (
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
