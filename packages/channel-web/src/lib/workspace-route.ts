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
export const WORKSPACE_AGENT_TABS = ['chat', 'did', 'files', 'memory'] as const;

export type AgentTab = (typeof WORKSPACE_AGENT_TABS)[number];

/**
 * The tab an agent URL means when it names no tab. Serializing omits it, so
 * `/workspace/agents/<id>` is the short "open this agent" link.
 */
const DEFAULT_TAB: AgentTab = 'chat';

export type WorkspaceRoute =
  | { kind: 'today' }
  | { kind: 'activity' }
  | { kind: 'agent'; id: string; tab: AgentTab };

/** Where the workspace lives. `/` is an alias the shell canonicalizes away. */
export const WORKSPACE_ROOT_PATH = '/workspace';

const TODAY: WorkspaceRoute = { kind: 'today' };

function isAgentTab(segment: string): segment is AgentTab {
  return (WORKSPACE_AGENT_TABS as readonly string[]).includes(segment);
}

/**
 * Decode one path segment into an agent id, or `null` if it can't be one.
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

/** Read a browser pathname as a workspace route. Never throws. */
export function parseWorkspaceRoute(pathname: string): WorkspaceRoute {
  const segments = pathname.split('/').filter((s) => s.length > 0);

  // `/` — App.tsx renders the workspace there when the preview is on.
  if (segments.length === 0) return TODAY;
  if (segments[0] !== 'workspace') return TODAY;

  const [, section, third, fourth] = segments;
  if (section === undefined) return TODAY;
  if (section === 'activity') return { kind: 'activity' };
  if (section !== 'agents' || third === undefined) return TODAY;

  const id = parseAgentId(third);
  if (id === null) return TODAY;

  const tab = fourth !== undefined && isAgentTab(fourth) ? fourth : DEFAULT_TAB;
  return { kind: 'agent', id, tab };
}

/** The canonical path for a route — one URL per view, so links are stable. */
export function workspaceRoutePath(route: WorkspaceRoute): string {
  switch (route.kind) {
    case 'today':
      return WORKSPACE_ROOT_PATH;
    case 'activity':
      return `${WORKSPACE_ROOT_PATH}/activity`;
    case 'agent': {
      const base = `${WORKSPACE_ROOT_PATH}/agents/${encodeURIComponent(route.id)}`;
      return route.tab === DEFAULT_TAB ? base : `${base}/${route.tab}`;
    }
  }
}
