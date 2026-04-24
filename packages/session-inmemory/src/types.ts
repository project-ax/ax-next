import type { ChatMessage } from '@ax/core';

// ---------------------------------------------------------------------------
// Inbox entry + claim result
//
// These are the shapes the long-poll inbox stores and returns. `InboxEntry` is
// what producers queue; `ClaimResult` is what the long-poll claim resolves to.
//
// Cursor semantics (matches @ax/ipc-protocol SessionNextMessageResponseSchema):
//   - `user-message` / `cancel`: returned `cursor` is the NEXT cursor the
//     caller should request (delivered-index + 1).
//   - `timeout`: returned `cursor` echoes the input cursor (no advancement).
// ---------------------------------------------------------------------------

export type InboxEntry =
  | { type: 'user-message'; payload: ChatMessage }
  | { type: 'cancel' };

export type ClaimResult =
  | { type: 'user-message'; payload: ChatMessage; cursor: number }
  | { type: 'cancel'; cursor: number }
  | { type: 'timeout'; cursor: number };

// ---------------------------------------------------------------------------
// Service hook I/O shapes
//
// Kept as plain interfaces — no Zod here. The IPC server validates wire
// payloads separately; in-process hook calls rely on TypeScript at compile
// time plus a small runtime shape-check inside the hook handlers.
// ---------------------------------------------------------------------------

export interface SessionCreateInput {
  sessionId: string;
  workspaceRoot: string;
}

export interface SessionCreateOutput {
  sessionId: string;
  token: string;
}

export interface SessionResolveTokenInput {
  token: string;
}

export type SessionResolveTokenOutput =
  | { sessionId: string; workspaceRoot: string }
  | null;

export interface SessionQueueWorkInput {
  sessionId: string;
  entry: InboxEntry;
}

export interface SessionQueueWorkOutput {
  cursor: number;
}

export interface SessionClaimWorkInput {
  sessionId: string;
  cursor: number;
  timeoutMs: number;
}

export type SessionClaimWorkOutput = ClaimResult;

export interface SessionTerminateInput {
  sessionId: string;
}

// Empty-object return — idempotent terminate. Declared as an interface (not
// `{}`) so future additions are type-safe if we ever need to return anything.
export type SessionTerminateOutput = Record<string, never>;
