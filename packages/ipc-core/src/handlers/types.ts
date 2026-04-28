import type { AgentContext, HookBus } from '@ax/core';
import type { IpcErrorCode } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// Handler result shape
//
// Every action handler is a pure function that returns either a success body
// or an IpcErrorEnvelope-shaped error with an HTTP status. The dispatcher
// serializes and writes; handlers never touch the `res` object directly.
// Keeps I9 (no token echo) trivially auditable — only the sanitized message
// fields ever reach the writer.
// ---------------------------------------------------------------------------

export interface HandlerOk {
  status: number;
  body: unknown;
}

export interface HandlerErr {
  status: number;
  body: { error: { code: IpcErrorCode; message: string } };
}

export type HandlerResult = HandlerOk | HandlerErr;

export type ActionHandler = (
  payload: unknown,
  ctx: AgentContext,
  bus: HookBus,
) => Promise<HandlerResult>;
