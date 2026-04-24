import type * as http from 'node:http';
import type { IpcErrorCode } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// Response helpers
//
// Writers for IpcErrorEnvelope bodies and plain JSON success bodies. The two
// writers are deliberately thin — we want every response in the dispatcher
// (Task 4) to look obviously right when read top-to-bottom, not hidden behind
// a builder. Content-Type is always application/json; the wire protocol has
// no other media types.
// ---------------------------------------------------------------------------

export function writeJsonError(
  res: http.ServerResponse,
  status: number,
  code: IpcErrorCode,
  message: string,
): void {
  // I9: error messages never include the offending token value. Callers are
  // responsible for constructing sanitized messages; this writer just emits.
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

export function writeJsonOk(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const serialized = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(serialized);
}
