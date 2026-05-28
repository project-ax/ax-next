import type * as http from 'node:http';
import type { IpcErrorCode } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// Response helpers
//
// Writers for IpcErrorEnvelope bodies, plain JSON success bodies, and the one
// raw-binary success body (workspace.materialize's git bundle — see
// writeBinaryOk / HandlerBinary). The writers are deliberately thin — we want
// every response in the dispatcher to look obviously right when read
// top-to-bottom, not hidden behind a builder. Every response is JSON except
// the binary materialize body.
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

// Raw-bytes success body (workspace.materialize). Content-Length is set so the
// runner's drain loop knows when the body is complete; no JSON envelope.
export function writeBinaryOk(
  res: http.ServerResponse,
  status: number,
  bytes: Buffer,
  contentType: string,
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(bytes.length),
  });
  res.end(bytes);
}
