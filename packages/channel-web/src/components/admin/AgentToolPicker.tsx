/**
 * The "Allowed tools" picker for the agent form (TASK-1214). Offers only tool
 * names this deployment really has, grouped by area; ticking an area ticks
 * everything in it. A saved name the list doesn't have is called out with a
 * Remove button; a plain save keeps it, because a successful read only proves
 * it is missing from this boot. Names are the host's own words; rendered as text.
 */
import { useId } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  AUTOMATIC_TOOLS,
  groupAgentTools,
  setTools,
  unknownTools,
  type ToolCatalogState,
} from '@/lib/agent-tool-areas';

export interface AgentToolPickerProps {
  catalog: ToolCatalogState;
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** An existing agent saved with no tools (the wildcard) and still nothing picked. */
  unrestricted: boolean;
}

function unknownMessage(names: readonly string[]): string {
  const quoted = names.map((n) => `“${n}”`);
  return names.length === 1
    ? `${quoted[0]} isn’t available here, so listing it does nothing right now. It may be a tool this deployment doesn’t run, or one this list doesn’t control.`
    : `These aren’t available here, so listing them does nothing right now: ${quoted.join(', ')}. They may be tools this deployment doesn’t run, or ones this list doesn’t control.`;
}

export function AgentToolPicker({
  catalog,
  selected,
  onChange,
  unrestricted,
}: AgentToolPickerProps) {
  const baseId = useId();
  // Display only: the tools AX adds itself are plumbing, so the failed-read
  // line leaves them out. The saved list still carries them unchanged.
  const kept = selected.filter((n) => !AUTOMATIC_TOOLS.has(n));

  return (
    <FieldSet>
      <FieldLegend variant="label">Allowed tools</FieldLegend>
      <FieldDescription>Pick what this agent can use.</FieldDescription>
      {unrestricted && (
        <FieldDescription>
          Right now this agent can use every tool, because none are picked. Picking any limits it
          to just those.
        </FieldDescription>
      )}
      {catalog.status === 'loading' ? (
        <FieldDescription>Loading the list of tools…</FieldDescription>
      ) : catalog.status === 'failed' ? (
        <FieldDescription>
          {kept.length > 0
            ? `We couldn’t load the list of tools, so this agent keeps the ones it has: ${kept.join(', ')}. Close and reopen this form to try again.`
            : 'We couldn’t load the list of tools. Close and reopen this form to try again.'}
        </FieldDescription>
      ) : (
        <PickerBody
          catalog={catalog}
          selected={selected}
          onChange={onChange}
          baseId={baseId}
        />
      )}
    </FieldSet>
  );
}

function PickerBody({
  catalog,
  selected,
  onChange,
  baseId,
}: {
  catalog: Extract<ToolCatalogState, { status: 'ok' }>;
  selected: readonly string[];
  onChange: (next: string[]) => void;
  baseId: string;
}) {
  const unknown = unknownTools(selected, catalog);
  const areas = groupAgentTools(catalog);
  return (
    <>
      {unknown.length > 0 && (
        <Alert>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{unknownMessage(unknown)}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(setTools(selected, unknown, false))}
            >
              {unknown.length === 1 ? 'Remove it' : 'Remove them'}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {areas.map((area) => {
        const picked = area.tools.filter((t) => selected.includes(t)).length;
        const allOn = picked === area.tools.length;
        const areaId = `${baseId}-area-${area.id}`;
        return (
          <div key={area.id} className="flex flex-col gap-2">
            <Field orientation="horizontal">
              <Checkbox
                id={areaId}
                checked={allOn}
                onCheckedChange={() => onChange(setTools(selected, area.tools, !allOn))}
              />
              <FieldContent>
                <FieldLabel htmlFor={areaId}>{area.label}</FieldLabel>
                <FieldDescription>{area.hint}</FieldDescription>
                {picked > 0 && !allOn && (
                  <FieldDescription>{`${picked} of ${area.tools.length} picked`}</FieldDescription>
                )}
              </FieldContent>
            </Field>
            <ul
              aria-label={`${area.label} tools`}
              className="m-0 grid list-none grid-cols-2 gap-2 p-0 pl-6 sm:grid-cols-3"
            >
              {area.tools.map((name) => {
                const id = `${baseId}-tool-${name}`;
                return (
                  <li key={name}>
                    <Field orientation="horizontal">
                      <Checkbox
                        id={id}
                        checked={selected.includes(name)}
                        onCheckedChange={(on) => onChange(setTools(selected, [name], on === true))}
                      />
                      <FieldLabel
                        htmlFor={id}
                        className="break-all font-mono text-xs text-muted-foreground"
                      >
                        {name}
                      </FieldLabel>
                    </Field>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}
