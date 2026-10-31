import type { AgentContext, HookBus } from '@ax/core';
import type { IpcErrorCode } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// Handler result shape
//
// Every action handler is a pure function that returns a success body, an
// IpcErrorEnvelope-shaped error with an HTTP status, or (for the one binary
// action) a raw-bytes body. The dispatcher serializes and writes; handlers
// never touch the `res` object directly. Keeps I9 (no token echo) trivially
// auditable — only the sanitized message fields ever reach the writer.
// ---------------------------------------------------------------------------

export interface HandlerOk {
  status: number;
  body: unknown;
}

export interface HandlerErr {
  status: number;
  body: { error: { code: IpcErrorCode; message: string } };
}

// A raw-binary success response. Used by `blob.get` (a stored blob) and
// `session.get-transcript` (the joined resume transcript), whose bodies can be
// far larger than the 4 MiB JSON response cap — base64-in-JSON would inflate
// them ~33% and force whole-buffer reads under that cap (the failure that first
// produced this shape, BUG-W3). `binary` is the body; the dispatcher writes it
// with `contentType` and no JSON envelope. Distinguished from HandlerOk by the
// presence of `binary` (HandlerOk has `body`, HandlerErr has `body.error`).
export interface HandlerBinary {
  status: number;
  binary: Buffer;
  contentType: string;
}

export type HandlerResult = HandlerOk | HandlerErr | HandlerBinary;

export type ActionHandler = (
  payload: unknown,
  ctx: AgentContext,
  bus: HookBus,
) => Promise<HandlerResult>;
