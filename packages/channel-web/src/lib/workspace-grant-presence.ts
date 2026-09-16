/**
 * Presence — is the human actually there, and where (TASK-351).
 *
 * A capability grant has two render sites: the Today queue, which shows every
 * open grant, and the agent's own thread, which additionally shows the ones
 * raised by THAT agent while the person is sitting in front of it. The queue is
 * the DEFAULT and the thread is the EXCEPTION, because most grants are raised
 * by an agent working unattended with nobody watching.
 *
 * WHAT THIS IS NOT. It is not a partition and it does not move a grant out of
 * the queue. The queue keeps it either way, which is the whole point of the
 * decision: "a human who walks away mid-grant finds it waiting in the queue
 * rather than orphaned in a thread nobody is reading" (design doc, 2026-09-12).
 * All this decides is whether the thread ALSO draws it, close to hand, when the
 * person is demonstrably reading that thread. Both sites render rows out of the
 * one store, so there is one grant and one answer however many places draw it.
 *
 * "IN A THREAD WITH THAT AGENT" is decided (2026-09-12) and deliberately cheap:
 * that agent's chat tab is the open route, and the tab is visible. Everything
 * else — another agent's thread, another tab of the same agent, Today, Activity,
 * a backgrounded tab, a closed laptop — is the queue alone. Visibility, not
 * focus: a visible but unfocused tab still has a human in front of it.
 *
 * It is re-evaluated on every render, and the hook below re-renders on
 * `visibilitychange`, so presence is CONTINUOUS rather than sampled once when
 * the grant arrived. Walking away takes the card out of the thread; coming back
 * puts it there again.
 *
 * Pure except for the hook, and separate from both the store and the route
 * grammar, because the rule is the part worth pinning and pinning it here needs
 * no React and no history stub.
 */
import { useEffect, useState } from 'react';
import type { WorkspaceGrant } from './workspace-grant-store';
import type { WorkspaceRoute } from './workspace-route';

/** Everything the rule needs: which view is open, and whether anyone can see it. */
export interface GrantPresence {
  /** The open view. The shell's own route state — the URL, already parsed. */
  route: WorkspaceRoute;
  /** `document.visibilityState === 'visible'`. See `useDocumentVisible`. */
  visible: boolean;
}

/**
 * Should this agent's thread draw this grant, as well as the queue?
 *
 * The `tab` check matters as much as the id: on `/workspace/agents/A/files`
 * the route names agent A but the thread is not on screen, so a card "above
 * the composer" would be above a composer that is not there.
 */
export function grantBelongsInThread(
  grant: WorkspaceGrant,
  { route, visible }: GrantPresence,
): boolean {
  if (!visible) return false;
  if (route.kind !== 'agent') return false;
  if (route.tab !== 'chat') return false;
  return route.id === grant.agentId;
}

/**
 * The grants the open thread should draw — a FILTER of the queue's array, never
 * a copy of it.
 *
 * Returns the very same row objects, so the card in the thread and the row in
 * the queue are one object with one identity: `resolve(key)` on either drops
 * the one row and both sites lose it. A renderer that mapped these into its own
 * shape, or a hook that cached them in state, would be the second live copy
 * invariant 4 forbids.
 */
export function threadGrants(
  grants: readonly WorkspaceGrant[],
  presence: GrantPresence,
): readonly WorkspaceGrant[] {
  return grants.filter((g) => grantBelongsInThread(g, presence));
}

/** `document.visibilityState`, without assuming a document exists. */
function documentIsVisible(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible';
}

/**
 * Is this tab visible, right now?
 *
 * Tracked rather than read once, because presence is continuous: a person who
 * switches tabs mid-grant has left, and the thread must stop being the place
 * that card lives. `visibilitychange` is the one event that says so — it fires
 * for a backgrounded tab, a minimised window and a locked screen alike, and
 * unlike `focus`/`blur` it does NOT fire when someone merely clicks into
 * another window while still looking at ours.
 *
 * The state is re-read inside the effect as well as in the initializer: React
 * can commit a render before the listener is attached, and a tab hidden in that
 * window would otherwise read as visible until the next change.
 *
 * With no `document` at all this answers "not visible" — the fail-safe
 * direction, since the queue keeps the grant regardless and a thread nobody can
 * see is the worse place for it.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(documentIsVisible);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => setVisible(documentIsVisible());
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  return visible;
}
