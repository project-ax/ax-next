/**
 * What the model-proposed connector approval card says about WHO supplies the
 * connector's key (TASK-711).
 *
 * WHY THIS EXISTS. A proposal carries `keyMode`: `personal` (each person adds
 * their own key) or `workspace` (one shared company key). The approval card
 * used to show neither, so an admin could approve a workspace-keyed proposal
 * whose name matched a shared key the company had already saved, and never see
 * that the assistant would be handed that key. Two surfaces show the card (the
 * in-chat grant row and Settings › "Proposed by your assistant"), so the words
 * live here once.
 *
 * WHAT IS TRUE, AND WHAT THIS IS CAREFUL NOT TO CLAIM.
 *   - A workspace-keyed connector reads the company's shared key for its name
 *     when the person using it has no key of their own saved; that is what
 *     "may use that key" means. "May", because whether it does also depends on
 *     who owns the connector (an admin), which the card cannot promise.
 *   - The key typed on this card is saved for the person typing it (the card's
 *     own `KEY_SAFETY` line says where it goes). This copy does not repeat or
 *     contradict that.
 *   - NOT claimed: that a shared key exists, or that other people will use this
 *     connector. Neither is known when the card is drawn.
 *
 * No jokes (CLAUDE.md › Voice & Tone: this is about who holds a company key).
 * No "scope", "token" or "MCP" — same visible-text rule as connector-access-copy.
 */

export type ConnectorKeyMode = 'personal' | 'workspace';

export interface ConnectorKeyModeCopy {
  /** The point, in one sentence. */
  headline: string;
  /** Present only when the approver needs to stop and think. */
  details?: string;
}

const COPY: Record<ConnectorKeyMode, ConnectorKeyModeCopy> = {
  workspace: {
    headline: 'This connector uses a shared company key, not a key of your own.',
    details:
      'If your workspace already has a shared key saved under this name, your assistant may use that key here. Only approve this if you expected a shared key.',
  },
  personal: {
    headline: 'This connector uses a personal key. Each person who uses it adds their own.',
  },
};

/** The sentence(s) for a key mode, or null for a value the card should not describe. */
export function connectorKeyModeCopy(keyMode: unknown): ConnectorKeyModeCopy | null {
  return keyMode === 'workspace' || keyMode === 'personal' ? COPY[keyMode] : null;
}
