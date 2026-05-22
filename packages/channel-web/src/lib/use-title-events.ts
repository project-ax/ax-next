import { useEffect } from 'react';
import { subscribeTitleEvents } from './title-events.js';
import { sessionStoreActions } from './session-store.js';

/**
 * Opens the long-lived title-events SSE for the duration of the
 * authenticated shell. Each frame updates the matching sidebar row in
 * place; each (re)connect triggers a list() resync (via bumpVersion) so a
 * title that landed while disconnected isn't missed.
 */
export function useTitleEvents(): void {
  useEffect(() => {
    const stop = subscribeTitleEvents({
      onOpen: () => sessionStoreActions.bumpVersion(),
      onTitle: ({ conversationId, title }) =>
        sessionStoreActions.applyTitle(conversationId, title),
    });
    return stop;
  }, []);
}
