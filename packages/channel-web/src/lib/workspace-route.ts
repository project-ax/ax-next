/**
 * The workspace's URL contract — what a path means, and what a view is called.
 *
 * The shell used to hold its route in component state with no URL sync, so a
 * reload always landed on Today, nothing was linkable, and Back skipped the
 * whole workspace in one jump. That was fine while the workspace was an
 * opt-in preview at a URL you had to know; TASK-324 made it the landing
 * surface, at which point every reload became a context loss.
 *
 * Kept pure and separate from the shell on purpose: the grammar is the part
 * worth pinning, and pinning it here needs no React and no history stub.
 * `WorkspaceShell` owns the history calls; this owns the translation.
 *
 * Parsing is deliberately lenient — the deepest prefix we understand wins,
 * and a tail we don't understand is dropped. A link with a typo in the tab
 * should still open the right agent. The one thing it is strict about is the
 * agent id: see `parseAgentId`.
 */

/** The tabs an agent view offers, in the order they appear. */
export const WORKSPACE_AGENT_TABS = ['chat', 'files', 'activity'] as const;

export type AgentTab = (typeof WORKSPACE_AGENT_TABS)[number];

/**
 * The tab an agent URL means when it names no tab. Serializing omits it, so
 * `/workspace/agents/<id>` is the short "open this agent" link.
 */
const DEFAULT_TAB: AgentTab = 'chat';

/**
 * The sections of an agent's settings page, in the order its nav lists them
 * (TASK-888). A full page rather than a dialog on purpose: connector sign-in
 * round-trips need a real URL to come back to.
 */
export const AGENT_SETTINGS_SECTIONS = [
  'instructions',
  'model',
  'connectors',
  'memory',
  'skills',
  'routines',
] as const;

export type AgentSettingsSection = (typeof AGENT_SETTINGS_SECTIONS)[number];

/**
 * The section `/settings` means when it names none, or names one we do not
 * know. Unlike the default TAB, serializing always spells it out: each section
 * has exactly one address, so a bare `/settings` canonicalizes onto
 * `/settings/instructions` rather than being a second spelling of it.
 */
export const DEFAULT_SETTINGS_SECTION: AgentSettingsSection = 'instructions';

export type WorkspaceRoute =
  | { kind: 'today' }
  | { kind: 'activity' }
  | { kind: 'projects' }
  | { kind: 'project'; id: string }
  /**
   * A project's files (W3b): the browser at `path` in the project's folder,
   * `''` for the folder root. `path` is the RAW key, slashes and all; the URL
   * spells it one encoded segment per folder.
   */
  | { kind: 'project-files'; id: string; path: string }
  | { kind: 'agent'; id: string; tab: AgentTab }
  | { kind: 'agent-settings'; id: string; section: AgentSettingsSection };

/**
 * The agent a route is ABOUT, on either of its two pages, or `null`.
 *
 * The settings page and the chat are one mounted agent view (the shell keeps
 * it mounted across the switch so a conversation in flight survives), so
 * anything asking "which agent is open" asks this rather than `kind`.
 */
export function routeAgentId(route: WorkspaceRoute): string | null {
  return route.kind === 'agent' || route.kind === 'agent-settings' ? route.id : null;
}

/** Where the workspace lives. `/` is an alias the shell canonicalizes away. */
export const WORKSPACE_ROOT_PATH = '/workspace';

const TODAY: WorkspaceRoute = { kind: 'today' };

function isSettingsSection(segment: string): segment is AgentSettingsSection {
  return (AGENT_SETTINGS_SECTIONS as readonly string[]).includes(segment);
}

function isAgentTab(segment: string): segment is AgentTab {
  return (WORKSPACE_AGENT_TABS as readonly string[]).includes(segment);
}

/**
 * Decode one path segment into an agent (or project) id, or `null` if it can't be one.
 *
 * Two refusals, both about a link someone else wrote:
 *
 * - A malformed escape (`%E0%A4%A`) makes `decodeURIComponent` throw, and an
 *   uncaught URIError here would blank the whole shell.
 * - A dot-segment is refused because this id is interpolated into
 *   `/api/workspace/agents/<id>/...` by `workspace-api`, and
 *   `encodeURIComponent('..')` returns `'..'` unchanged — so the browser
 *   would normalize the request onto a DIFFERENT endpoint before sending it.
 *   A slash needs no such guard: it encodes to `%2F` and stays one segment.
 */
function parseAgentId(segment: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (id.length === 0) return null;
  if (id === '.' || id === '..') return null;
  return id;
}

/**
 * Decode the segments after `/files` into a raw folder path, or `null` if any
 * one of them can't be part of one.
 *
 * Each segment is decoded ONCE — the server decodes the path once too, so a
 * second decode here would let `%252e%252e` arrive as `..`. A decoded `.` or
 * `..` is refused (the browser would normalize the API request onto another
 * path), as are a slash smuggled in as `%2F` (it would silently split one name
 * into two folders), NUL, and a malformed escape.
 */
function parseFilePath(segments: readonly string[]): string | null {
  const parts: string[] = [];
  for (const segment of segments) {
    let part: string;
    try {
      part = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (part.length === 0 || part === '.' || part === '..') return null;
    if (part.includes('/') || part.includes('\0')) return null;
    parts.push(part);
  }
  return parts.join('/');
}

/** Read a browser pathname as a workspace route. Never throws. */
export function parseWorkspaceRoute(pathname: string): WorkspaceRoute {
  const segments = pathname.split('/').filter((s) => s.length > 0);

  // `/` — App.tsx renders the workspace there when the flag is on.
  if (segments.length === 0) return TODAY;
  if (segments[0] !== 'workspace') return TODAY;

  const [, section, third, fourth, fifth] = segments;
  if (section === undefined) return TODAY;
  if (section === 'activity') return { kind: 'activity' };
  if (section === 'projects') {
    if (third === undefined) return { kind: 'projects' };
    // Same refusals as an agent id: the project id is interpolated into
    // `/api/workspace/projects/<id>` the same way. A malformed one falls
    // back to the list, not Today — the person was clearly after projects.
    const projectId = parseAgentId(third);
    if (projectId === null) return { kind: 'projects' };
    if (fourth === 'files') {
      // A path we won't follow still opens the project — the person was
      // clearly after it — rather than a browser at a path we made up.
      const path = parseFilePath(segments.slice(4));
      return path === null
        ? { kind: 'project', id: projectId }
        : { kind: 'project-files', id: projectId, path };
    }
    return { kind: 'project', id: projectId };
  }
  if (section !== 'agents' || third === undefined) return TODAY;

  const id = parseAgentId(third);
  if (id === null) return TODAY;

  if (fourth === 'settings') {
    const settingsSection =
      fifth !== undefined && isSettingsSection(fifth) ? fifth : DEFAULT_SETTINGS_SECTION;
    return { kind: 'agent-settings', id, section: settingsSection };
  }

  // Bookmarks for the old permissions panel and its replacement connector
  // rail both land on the full settings section (TASK-889).
  if (fourth === 'connectors' || fourth === 'rules') {
    return { kind: 'agent-settings', id, section: 'connectors' };
  }

  if (fourth === 'memory') {
    return { kind: 'agent-settings', id, section: 'memory' };
  }

  // Preserve links to the two panels now combined into Activity.
  const tab = fourth === 'now' || fourth === 'did'
    ? 'activity'
    : fourth !== undefined && isAgentTab(fourth) ? fourth : DEFAULT_TAB;
  return { kind: 'agent', id, tab };
}

/** The canonical path for a route — one URL per view, so links are stable. */
export function workspaceRoutePath(route: WorkspaceRoute): string {
  switch (route.kind) {
    case 'today':
      return WORKSPACE_ROOT_PATH;
    case 'activity':
      return `${WORKSPACE_ROOT_PATH}/activity`;
    case 'projects':
      return `${WORKSPACE_ROOT_PATH}/projects`;
    case 'project':
      return `${WORKSPACE_ROOT_PATH}/projects/${encodeURIComponent(route.id)}`;
    case 'project-files': {
      const base = `${WORKSPACE_ROOT_PATH}/projects/${encodeURIComponent(route.id)}/files`;
      if (route.path === '') return base;
      return `${base}/${route.path.split('/').map(encodeURIComponent).join('/')}`;
    }
    case 'agent': {
      const base = `${WORKSPACE_ROOT_PATH}/agents/${encodeURIComponent(route.id)}`;
      return route.tab === DEFAULT_TAB ? base : `${base}/${route.tab}`;
    }
    case 'agent-settings':
      return `${WORKSPACE_ROOT_PATH}/agents/${encodeURIComponent(route.id)}/settings/${route.section}`;
  }
}

/**
 * Should a click on a workspace LINK navigate in place? Only a plain primary
 * click: a middle click or a modifier is the reader asking their browser for
 * a new tab or window, and the `href` is there to answer it.
 */
export function isPlainClick(e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
