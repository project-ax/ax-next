import { INSTRUCTIONS_PATH, STATUS_PATH } from './block.js';

// ---------------------------------------------------------------------------
// The fixed top level of a project folder (W3 spec §6.2), and the one change
// list that writes it: `projects:create` seeds it, and the lazy layout sweep
// (`ensureLayout`) fills in what a W3a project is missing. Every entry is
// `ifAbsent`, so neither ever overwrites what a person or an agent wrote.
// ---------------------------------------------------------------------------

export const LOG_PATH = 'memory/log.md';
/** Read-only for people (W5 fills it with copies from connected sources). */
export const SOURCES_DIR = 'sources';
/** Can be edited, never deleted: the project block reads them every turn. */
export const PROTECTED_PATHS: ReadonlySet<string> = new Set([INSTRUCTIONS_PATH, STATUS_PATH]);
/** The root entries a laid-out project has. One missing → the sweep runs. */
export const LAYOUT_TOP_LEVEL: readonly string[] = ['instructions.md', 'memory', 'playbooks', SOURCES_DIR, 'work'];

/** The log line `ensureLayout` writes when a W3a project had no log yet. */
export const LAYOUT_SWEEP_LOG_LINE = 'Project folder set up';

/**
 * Mirrors the provider's change shape (`SharedFolderChange` in
 * `@ax/sandbox-mount-protocol`). Declared locally, like this plugin's other
 * peer slices: no dependency on the provider packages.
 */
export type LayoutChange =
  | { op: 'write'; path: string; content: Uint8Array; ifMatch?: string; ifAbsent?: true }
  | { op: 'mkdir'; path: string; ifAbsent?: true }
  | { op: 'delete'; path: string };

export function instructionsTemplate(name: string, description: string | null): string {
  const purpose = description === null ? '' : `${description}\n\n`;
  return `# ${name}\n\n## What this is for\n\n${purpose}## Who does what\n\n`;
}

export const STATUS_TEMPLATE = '# Status\n\nJust getting started.\n';

/** One line for memory/log.md: "Project created by <name>", or "Project created" with no usable name. */
export function createdLogLine(displayName: string | null | undefined): string {
  if (typeof displayName !== 'string') return 'Project created';
  const clean = displayName
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return clean === '' ? 'Project created' : `Project created by ${clean}`;
}

export function layoutChanges(seed: { name: string; description: string | null; logLine: string }): LayoutChange[] {
  const enc = new TextEncoder();
  return [
    {
      op: 'write',
      path: INSTRUCTIONS_PATH,
      content: enc.encode(instructionsTemplate(seed.name, seed.description)),
      ifAbsent: true,
    },
    { op: 'write', path: STATUS_PATH, content: enc.encode(STATUS_TEMPLATE), ifAbsent: true },
    { op: 'write', path: LOG_PATH, content: enc.encode(`${seed.logLine}\n`), ifAbsent: true },
    { op: 'mkdir', path: 'playbooks', ifAbsent: true },
    { op: 'mkdir', path: SOURCES_DIR, ifAbsent: true },
    { op: 'mkdir', path: 'work', ifAbsent: true },
  ];
}
