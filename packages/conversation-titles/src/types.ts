import type { ContentBlock } from '@ax/ipc-protocol';

/**
 * Locally-mirrored type shapes from `@ax/conversations`.
 *
 * Cross-plugin imports are forbidden (CLAUDE.md invariant 2 / I2). Plugins
 * communicate through the hook bus only; even types-only imports between
 * plugin packages are a no-go because eslint's no-restricted-imports
 * allowlist (see `eslint.config.mjs`) doesn't carve out a pure-types
 * exception. Precedent: `packages/conversations/src/store.ts:42-47`
 * mirrors `@ax/agents`'s validators rather than importing them.
 *
 * Keep these in lockstep with the source of truth. When the
 * `@ax/conversations` shapes change, mirror the change here. Drift is
 * caught at runtime via the bus payload contract — but we'd rather
 * notice it at code-review time.
 */

// Mirrored from @ax/conversations (`packages/conversations/src/types.ts:32`).
// Cross-plugin imports are forbidden (CLAUDE.md invariant 2). Keep in
// lockstep with the source.
export type TurnRole = 'user' | 'assistant' | 'tool';

// Mirrored from @ax/conversations (`packages/conversations/src/types.ts:34-47`).
// Cross-plugin imports are forbidden (CLAUDE.md invariant 2). Keep in
// lockstep with the source. Only the fields we read are required here —
// the bus payload may carry more; we ignore the rest.
export interface Turn {
  turnId: string;
  turnIndex: number;
  role: TurnRole;
  contentBlocks: ContentBlock[];
  /** ISO-8601 string. */
  createdAt: string;
}

// Mirrored from @ax/conversations (`packages/conversations/src/types.ts:49-88`).
// Cross-plugin imports are forbidden (CLAUDE.md invariant 2). Keep in
// lockstep with the source. We only read `title`; the actual payload
// carries every Conversation field, but we declare just what we read so
// any drift on unread fields is invisible to us.
export interface Conversation {
  title: string | null;
}

// Mirrored from @ax/conversations (`packages/conversations/src/types.ts:106-120`).
// Cross-plugin imports are forbidden (CLAUDE.md invariant 2). Keep in
// lockstep with the source.
export interface GetInput {
  conversationId: string;
  userId: string;
  includeThinking?: boolean;
}
export interface GetOutput {
  conversation: Conversation;
  turns: Turn[];
}

// Mirrored from @ax/conversations (`packages/conversations/src/types.ts:283-303`).
// Cross-plugin imports are forbidden (CLAUDE.md invariant 2). Keep in
// lockstep with the source.
export interface SetTitleInput {
  conversationId: string;
  userId: string;
  title: string;
  ifNull?: boolean;
}
export interface SetTitleOutput {
  updated: boolean;
}
