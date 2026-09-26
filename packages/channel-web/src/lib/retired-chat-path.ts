/**
 * `/chat` and `/chat/*` land on `/` (TASK-360).
 *
 * The chat screen was deleted in the release that added this. A redirect is
 * not a deprecation window — it is the difference between a bookmark that
 * lands somewhere and one that shows nothing useful.
 *
 * Nothing from the old path is carried over — not a segment, not the query,
 * not the hash. A chat conversation id is not a workspace route, and guessing
 * an agent from one would be worse than landing on Today.
 *
 * A REPLACE, never a push: a push would leave the dead address one Back away.
 * (`WorkspaceShell` then canonicalises `/` to `/workspace`, also a replace.)
 */
export function redirectRetiredChatPath(
  location: Pick<Location, 'pathname'>,
  history: Pick<History, 'replaceState'>,
): boolean {
  const p = location.pathname;
  if (p !== '/chat' && !p.startsWith('/chat/')) return false;
  history.replaceState(null, '', '/');
  return true;
}
