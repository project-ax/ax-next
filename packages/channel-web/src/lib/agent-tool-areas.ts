/**
 * Presentation-only grouping and selection rules for the agent tool picker
 * (TASK-1214). Grouping lives here, not on the host: `ToolDescriptor` has no
 * `area` field, and adding one is a four-place descriptor change. See
 * .claude/memory/decisions/2026-11-23-TASK-1214.md.
 */
import type { AgentToolCatalog } from './admin';

export type ToolCatalogState =
  | { status: 'loading' }
  | { status: 'failed' }
  | ({ status: 'ok' } & AgentToolCatalog);

export type ToolAreaId = 'basics' | 'routines' | 'memory' | 'web' | 'sharing' | 'other';

export interface ToolArea {
  id: ToolAreaId;
  label: string;
  hint: string;
  tools: string[];
}

/**
 * Tools the orchestrator adds itself at session open, so picking one changes
 * nothing. From packages/chat-orchestrator/src/orchestrator.ts:
 * `ALWAYS_ON_BROKER_TOOLS` (search_catalog, request_capability, skill_propose,
 * connector_propose), `identityToolScope` (update_identity, complete_bootstrap)
 * and `ROUTINE_RUN_TOOLS` (routine_report, routine_read_update). Never offered,
 * but they count as known, so they are never flagged or dropped.
 */
export const AUTOMATIC_TOOLS: ReadonlySet<string> = new Set([
  'search_catalog',
  'request_capability',
  'skill_propose',
  'connector_propose',
  'update_identity',
  'complete_bootstrap',
  'routine_report',
  'routine_read_update',
]);

const AREAS: ReadonlyArray<{
  id: ToolAreaId;
  label: string;
  hint: string;
  match: (name: string) => boolean;
}> = [
  {
    id: 'routines',
    label: 'Routines',
    hint: 'Set up, change and run routines.',
    match: (n) => n.startsWith('routine_'),
  },
  {
    id: 'memory',
    label: 'Memory',
    hint: 'Look things up in its memory and save notes there.',
    match: (n) => n.startsWith('memory_'),
  },
  {
    id: 'web',
    label: 'Web',
    hint: 'Search the web and read web pages.',
    match: (n) => n.startsWith('web_'),
  },
  {
    id: 'sharing',
    label: 'Sharing what it makes',
    hint: 'Publish files and show charts and visuals in the chat.',
    match: (n) => n.startsWith('artifact_') || n === 'show_visual',
  },
];

export function groupAgentTools(catalog: AgentToolCatalog): ToolArea[] {
  const builtins = [...new Set(catalog.builtins)];
  const builtinSet = new Set(builtins);
  const names = [...new Set(catalog.tools)].filter(
    (n) => !AUTOMATIC_TOOLS.has(n) && !builtinSet.has(n),
  );
  const out: ToolArea[] = [];
  if (builtins.length > 0) {
    out.push({
      id: 'basics',
      label: 'Files and commands',
      hint: 'Work with its own files and run commands. Ticking these adds nothing new — tick them if this agent needs none of the tools below.',
      tools: builtins,
    });
  }
  const claimed = new Set<string>();
  for (const area of AREAS) {
    const tools = names.filter((n) => !claimed.has(n) && area.match(n));
    tools.forEach((n) => claimed.add(n));
    if (tools.length > 0) out.push({ id: area.id, label: area.label, hint: area.hint, tools });
  }
  const rest = names.filter((n) => !claimed.has(n));
  if (rest.length > 0) {
    out.push({
      id: 'other',
      label: 'Other tools',
      hint: 'Tools that don’t fit a group above.',
      tools: rest,
    });
  }
  return out;
}

/**
 * Selected names found in neither list. Proves nothing unless the read
 * succeeded, and even then only that the name is missing from THIS boot
 * (`@ax/web-tools`, for one, loads only when a key is set), so these are
 * flagged for the owner to remove, never dropped on save.
 */
export function unknownTools(selected: readonly string[], catalog: ToolCatalogState): string[] {
  if (catalog.status !== 'ok') return [];
  const known = new Set<string>([...catalog.tools, ...catalog.builtins, ...AUTOMATIC_TOOLS]);
  return [...new Set(selected.filter((n) => !known.has(n)))];
}

export function setTools(
  selected: readonly string[],
  names: readonly string[],
  on: boolean,
): string[] {
  if (!on) {
    const off = new Set(names);
    return selected.filter((n) => !off.has(n));
  }
  const out = [...selected];
  for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}
