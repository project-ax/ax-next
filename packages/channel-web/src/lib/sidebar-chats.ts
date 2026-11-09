import type { AgentDetail } from './workspace-api';
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
  /** Every chat, newest first, each by its title. */
  chats: PastConversation[];
  /**
   * Which chat is on screen. Only meaningful while the agent's view is
   * mounted; the shell's own read reports `null` and the sidebar draws no row
   * as selected off the agent route.
   */
  openId: string | null;
  /** A turn is streaming or settling — chat switches wait until it lands. */
  busy: boolean;
}

/**
 * The detail's chats as one list: the most recent one, then the rest.
 *
 * A server that predates `latest` still names the current chat by id; it
 * gets the same "Untitled conversation" label rather than vanishing.
 */
export function chatsFromDetail(d: Pick<AgentDetail, 'conversationId' | 'past' | 'latest'>): PastConversation[] {
  const latest =
    d.latest !== undefined
      ? d.latest
      : d.conversationId !== null && !d.past.some((p) => p.id === d.conversationId)
        ? { id: d.conversationId, title: 'Untitled conversation', lastActivityAt: new Date(0).toISOString() }
        : null;
  return latest === null ? [...d.past] : [latest, ...d.past.filter((p) => p.id !== latest.id)];
}

/**
 * Something the sidebar asked the agent's view to do. A request rather than a
 * call because the view may not be mounted yet: picking a chat from Today
 * navigates to the agent first, and the fresh view consumes this once its
 * detail has loaded. `nonce` makes two identical asks two distinct requests.
 */
export type SidebarChatCommand =
  /** Show a chat; `null` is the agent's most recent one. */
  | { nonce: number; agentId: string; kind: 'open'; conversationId: string | null }
  /** An empty chat to type into; the first send creates it. */
  | { nonce: number; agentId: string; kind: 'new' };

/** Title-only, case-insensitive. Full-text search across chats comes later. */
export function filterChatsByTitle(
  chats: readonly PastConversation[],
  query: string,
): PastConversation[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === '') return [...chats];
  return chats.filter((c) => c.title.toLocaleLowerCase().includes(q));
}
