/**
 * Read the current conversation id from the AxChatTransport. Returns null
 * before the first POST /api/chat/messages mints one (welcome state).
 *
 * Wired against the same `conversationRef` the runtime hook (lib/runtime.tsx)
 * holds. Exposed via a tiny module-level subscription so deep components
 * (AttachmentChip / ArtifactChip) don't have to prop-drill it.
 *
 * Uses `useSyncExternalStore` so React 18 concurrent rendering tears
 * correctly and components re-render when the active conversation flips.
 */
import { useSyncExternalStore } from 'react';

let current: string | null = null;
const subscribers = new Set<() => void>();

export function setActiveConversationId(id: string | null): void {
  if (current === id) return;
  current = id;
  for (const sub of subscribers) sub();
}

export function useConversationId(): string | null {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => current,
    () => null,
  );
}
