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

// A raw-binary success response. Used by `workspace.materialize`, whose body
// is a `git bundle` that grows unbounded with workspace age — base64-in-JSON
// inflated it ~33% and forced whole-buffer reads under the 4 MiB response cap,
// crashing the runner on boot (BUG-W3). Streaming the raw bytes drops the tax
// and the cap. `binary` is the body; the dispatcher writes it with
// `contentType` and no JSON envelope. Distinguished from HandlerOk by the
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
