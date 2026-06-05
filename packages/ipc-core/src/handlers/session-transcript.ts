import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import {
  SessionAppendTranscriptMetaSchema,
  SessionAppendTranscriptResponseSchema,
  SessionGetTranscriptRequestSchema,
  SessionReplaceTranscriptResponseSchema,
} from '@ax/ipc-protocol';
import {
  hookRejected,
  internalError,
  logInternalError,
  mapPluginError,
  validationError,
} from '../errors.js';
import type { ActionHandler, HandlerResult } from './types.js';
import type { BinaryActionHandler } from './blob.js';

// ---------------------------------------------------------------------------
// session.append-transcript / .replace-transcript / .get-transcript — TASK-67
// (out-of-git Part B / B2). The host side of the runner's resume-transcript
// delta-ship + resume read.
//
// SECURITY: the conversationId is NEVER taken from the runner's request body.
// It is resolved host-side from the runner's own session row (the bearer token
// → ctx.sessionId → `session:get-config` → conversationId), exactly as
// `session.get-config` reads ctx not the body. A runner therefore cannot aim a
// transcript at a foreign conversation. The lines are an UNTRUSTED, adversarial
// SDK/model artifact — forwarded verbatim to the conversations store, never
// executed or shell-interpolated.
//
// The three host hooks (`conversations:append-transcript` /
// `:replace-transcript` / `:get-transcript`) are OPTIONAL dependencies — a
// single-session CLI deployment without @ax/conversations simply can't reach
// these (the runner never has a conversationId). When the hooks are absent we
// surface a 500 (the deployment shouldn't be calling them); when conversationId
// is absent (non-conversation session) we surface a 409 conflict (the action is
// not applicable).
// ---------------------------------------------------------------------------

interface BusSessionGetConfigOutput {
  conversationId: string | null;
}

/**
 * Resolve the runner's conversationId from its session row. Returns null when
 * the session is not conversation-scoped (the caller maps that to a 409). A
 * `session:get-config` failure propagates so the dispatcher maps it.
 */
async function resolveConversationId(
  ctx: AgentContext,
  bus: HookBus,
): Promise<string | null> {
  const cfg = await bus.call<Record<string, never>, BusSessionGetConfigOutput>(
    'session:get-config',
    ctx,
    {},
  );
  return cfg.conversationId;
}

interface AppendTranscriptCall {
  conversationId: string;
  fromSeq: number;
  prefixHash: string;
  lines: string[];
}
interface AppendTranscriptResult {
  outcome: 'appended' | 'resync-required';
  maxSeq: number;
}

export const sessionAppendTranscriptHandler: BinaryActionHandler = async (
  body,
  ctx,
  bus,
  url,
) => {
  // REQUEST-direction binary: the delta lines are the raw octet-stream body
  // (split on `\n`, same as replace-transcript), so a turn that Read a large
  // attachment can't overflow the 4 MiB JSON cap. The `fromSeq`/`prefixHash`
  // integrity metadata ride as QUERY PARAMS. Missing/malformed → 400. A
  // `?conversationId=…` smuggled onto the query is NEVER read — the host
  // resolves the conversationId from the session row (below), exactly as the
  // old JSON shape's `.strict()` schema refused a body-smuggled conversationId.
  const fromSeqRaw = url.searchParams.get('fromSeq');
  const prefixHashRaw = url.searchParams.get('prefixHash');
  if (fromSeqRaw === null || prefixHashRaw === null) {
    return validationError(
      'session.append-transcript: missing fromSeq/prefixHash query param',
    );
  }
  const parsed = SessionAppendTranscriptMetaSchema.safeParse({
    fromSeq: fromSeqRaw,
    prefixHash: prefixHashRaw,
  });
  if (!parsed.success) {
    return validationError(`session.append-transcript: ${parsed.error.message}`);
  }
  // The lines are an UNTRUSTED, adversarial SDK/model artifact — split verbatim
  // (no re-serialization, no per-line parse) and forwarded to the store as-is.
  const lines = splitJsonlBytes(body);

  let conversationId: string | null;
  try {
    conversationId = await resolveConversationId(ctx, bus);
  } catch (err) {
    logInternalError(ctx.logger, 'session.append-transcript', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }
  if (conversationId === null) {
    return hookRejected('session is not conversation-scoped');
  }

  let out: AppendTranscriptResult;
  try {
    out = await bus.call<AppendTranscriptCall, AppendTranscriptResult>(
      'conversations:append-transcript',
      ctx,
      {
        // Host-resolved — NOT from the wire (body or query).
        conversationId,
        fromSeq: parsed.data.fromSeq,
        prefixHash: parsed.data.prefixHash,
        lines,
      },
    );
  } catch (err) {
    logInternalError(ctx.logger, 'session.append-transcript', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  const checked = SessionAppendTranscriptResponseSchema.safeParse(out);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'session.append-transcript',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};

interface ReplaceTranscriptCall {
  conversationId: string;
  lines: string[];
}
interface ReplaceTranscriptResult {
  maxSeq: number;
}

/**
 * REQUEST-direction binary: the runner streams the WHOLE jsonl as a raw
 * octet-stream body. The host splits it into lines on `\n` (dropping a trailing
 * empty line from the final terminator) and replaces the conversation's
 * transcript rows wholesale. Used only on the resync path.
 */
export const sessionReplaceTranscriptHandler: BinaryActionHandler = async (
  body,
  ctx,
  bus,
): Promise<HandlerResult> => {
  let conversationId: string | null;
  try {
    conversationId = await resolveConversationId(ctx, bus);
  } catch (err) {
    logInternalError(ctx.logger, 'session.replace-transcript', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }
  if (conversationId === null) {
    return hookRejected('session is not conversation-scoped');
  }

  const lines = splitJsonlBytes(body);
  let out: ReplaceTranscriptResult;
  try {
    out = await bus.call<ReplaceTranscriptCall, ReplaceTranscriptResult>(
      'conversations:replace-transcript',
      ctx,
      { conversationId, lines },
    );
  } catch (err) {
    logInternalError(ctx.logger, 'session.replace-transcript', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  const checked = SessionReplaceTranscriptResponseSchema.safeParse(out);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'session.replace-transcript',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};

interface GetTranscriptCall {
  conversationId: string;
}
interface GetTranscriptResult {
  bytes: string;
  maxSeq: number;
}

/**
 * Response-direction binary: the host joins the conversation's transcript rows
 * (ORDER BY seq, `\n`) and streams the reconstructed jsonl bytes back. The
 * runner writes them to its `$CLAUDE_CONFIG_DIR/projects/<slug>/<sid>.jsonl`
 * before `query({ resume })`. An empty transcript streams a zero-byte body.
 */
export const sessionGetTranscriptHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = SessionGetTranscriptRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`session.get-transcript: ${parsed.error.message}`);
  }
  let conversationId: string | null;
  try {
    conversationId = await resolveConversationId(ctx, bus);
  } catch (err) {
    logInternalError(ctx.logger, 'session.get-transcript', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }
  if (conversationId === null) {
    return hookRejected('session is not conversation-scoped');
  }

  let out: GetTranscriptResult;
  try {
    out = await bus.call<GetTranscriptCall, GetTranscriptResult>(
      'conversations:get-transcript',
      ctx,
      { conversationId },
    );
  } catch (err) {
    logInternalError(ctx.logger, 'session.get-transcript', err);
    if (err instanceof PluginError) return mapPluginError(err);
    return internalError();
  }

  return {
    status: 200,
    binary: Buffer.from(out.bytes, 'utf8'),
    contentType: 'application/octet-stream',
  };
};

/**
 * Split the raw jsonl bytes the runner uploaded into verbatim lines. The SDK
 * writes each line `\n`-terminated, so a trailing empty segment after the final
 * terminator is dropped (it's not a line). We do NOT trim or re-serialize — the
 * bytes are opaque and must round-trip.
 */
function splitJsonlBytes(body: Buffer): string[] {
  const text = body.toString('utf8');
  if (text.length === 0) return [];
  const parts = text.split('\n');
  // A trailing '\n' produces a final empty element — drop it (it's the
  // terminator of the last real line, not a new line).
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
