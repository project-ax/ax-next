import type { PastConversation } from './workspace-types';

/**
 * The chats the sidebar lists under the agent switcher.
 *
 * ONE SHAPE, TWO PRODUCERS. While an agent's conversation is on screen,
 * `AgentView` publishes this from the detail it already holds — so a chat the
 * person just started, renamed or opened shows in the list the moment the
 * thread does, with no second read racing the first. Anywhere else (Today,
 * Tasks) nothing is mounted to publish it, so the shell reads the selected
 * agent's detail itself. The sidebar cannot tell which one it got, and should
 * not need to.
 */
export interface SidebarChatList {
  agentId: string;
  /** The live conversation's id; `null` before the agent has one. */
  conversationId: string | null;
  past: PastConversation[];
  /**
   * Which past conversation is open, `null` for the live one. Only meaningful
   * while the agent's view is on screen; the shell's own read reports `null`
   * and the sidebar draws no row as selected off the agent route.
   */
  openPastId: string | null;
  /** A turn is streaming or settling — chat switches wait until it lands. */
  busy: boolean;
}

/**
 * Something the sidebar asked the agent's view to do. A request rather than a
 * call because the view may not be mounted yet: picking a chat from Today
 * navigates to the agent first, and the fresh view consumes this once its
 * detail has loaded. `nonce` makes two identical asks two distinct requests.
 */
export type SidebarChatCommand =
  | { nonce: number; agentId: string; kind: 'open'; pastId: string | null }
  /** Show a chat the shell has just created. */
  | { nonce: number; agentId: string; kind: 'new'; conversationId: string };

/** Title-only, case-insensitive. Full-text search across chats comes later. */
export function filterChatsByTitle(
  past: readonly PastConversation[],
  query: string,
): PastConversation[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === '') return [...past];
  return past.filter((c) => c.title.toLocaleLowerCase().includes(q));
}
