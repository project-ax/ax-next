// ---------------------------------------------------------------------------
// PreToolUse → tool.pre-call IPC adapter.
//
// Why this exists instead of forwarding `canUseTool` → `tool.pre-call` (the
// Task-7 design): `canUseTool` only fires for tools the CLI decides need a
// permission prompt. Built-ins the CLI considers benign (e.g. `Bash echo hi`
// under permissionMode 'default') never reach canUseTool — they run with no
// host visibility at all, which breaks the invariant that every tool
// invocation crosses `tool:pre-call`.
//
// `PreToolUse` is the SDK hook that ALWAYS fires, once per tool invocation,
// before the tool runs. We use it as the authoritative pre-call signal and
// translate the host's verdict into `hookSpecificOutput.permissionDecision`
// so the SDK treats the tool as pre-approved (or pre-denied) and skips
// canUseTool. The existing canUseTool adapter stays in place as a
// belt-and-suspenders allow-path for tools the SDK routes there directly
// (third-party MCP, etc.) — but the host sees them via PreToolUse first, so
// the pre-call event is single-fire.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import {
  ToolPreCallResponseSchema,
  type IpcClient,
  type ToolPreCallResponse,
} from '@ax/ipc-protocol';
import { classifySdkToolName } from './tool-names.js';

export interface CreatePreToolUseHookOptions {
  client: IpcClient;
  /**
   * Runner workspace root (AX_WORKSPACE_ROOT, e.g. `/permanent`) — the agent's
   * working directory. Used to re-root mis-rooted attachment paths in tool
   * inputs to the real absolute path before a file tool runs. See
   * `resolveAttachmentPaths`.
   */
  workspaceRoot: string;
  /** Test seam: override the per-call id generator. Defaults to randomUUID. */
  idGen?: () => string;
}

// The workspace-relative namespace every uploaded attachment lives under
// (`@ax/attachments` commits to `.ax/uploads/<conv>/<turn>/<file>`). It's our
// own convention, so ANY tool path referencing it must resolve under the
// agent's workspace root — that makes it a safe, deterministic re-root key.
const UPLOADS_SEGMENT = '.ax/uploads/';
// A maximal non-whitespace run that contains the uploads segment — i.e. a
// single path token (whether bare, scheme-wrapped, or wrongly absolute).
const UPLOADS_TOKEN_RE = /\S*\.ax\/uploads\/\S*/g;

/**
 * Re-root any attachment path a tool is about to touch to the absolute
 * workspace path, so file tools (Read, Bash `cat`, Edit, …) open the real
 * file regardless of how the model rooted it.
 *
 * Why this is needed: an uploaded attachment is referenced by a
 * workspace-relative path (`.ax/uploads/...`). Because that path starts with a
 * dot, the model reads it as a home dotfile and resolves it under
 * `~`/`/home/<user>` instead of its working directory — so `Read` fails (the
 * file is under the runner workspace root, e.g. `/permanent/.ax/uploads/...`).
 * (We first tried wrapping the path in an `ax-file://` scheme to disambiguate,
 * but the model stripped the scheme itself — then home-rooted the bare path
 * anyway — and even mistook the URI for a web resource. So we resolve by the
 * `.ax/uploads/` namespace marker, which the model can't strip away.)
 *
 * For every top-level string field (file_path, command, path, …) we replace
 * each path token containing `.ax/uploads/` with `<workspaceRoot>/` + the
 * substring from `.ax/uploads/` onward. This handles a home-prefixed
 * (`/home/user/.ax/uploads/x`), bare (`.ax/uploads/x`), or already-correct
 * (`/permanent/.ax/uploads/x`, idempotent) reference, and an embedded one in a
 * Bash command (`cat /home/user/.ax/uploads/x` → `cat /permanent/.ax/uploads/x`).
 * Returns the (possibly new) input and whether anything changed.
 */
export function resolveAttachmentPaths(
  input: unknown,
  workspaceRoot: string,
): { changed: boolean; input: Record<string, unknown> } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { changed: false, input: {} };
  }
  const src = input as Record<string, unknown>;
  const root = workspaceRoot.replace(/\/+$/, '');
  let changed = false;
  const out: Record<string, unknown> = { ...src };
  for (const [key, value] of Object.entries(src)) {
    if (typeof value !== 'string' || !value.includes(UPLOADS_SEGMENT)) continue;
    const rewritten = value.replace(UPLOADS_TOKEN_RE, (token) => {
      const rel = token.slice(token.indexOf(UPLOADS_SEGMENT));
      // Security: only re-root traversal-free attachment paths. A legit
      // committed attachment is `.ax/uploads/<conv>/<turn>/<file>` (no `..`);
      // refusing `..` segments stops a crafted `.ax/uploads/../../etc/x` from
      // being re-rooted out of the workspace. The re-root happens AFTER the
      // host's tool:pre-call adjudicated the original path, so it must not
      // widen reach. Non-attachment escapes are unaffected (the agent could
      // already Read any sandbox path directly; we just don't ENABLE one here).
      if (rel.split('/').includes('..')) return token;
      return `${root}/${rel}`;
    });
    if (rewritten !== value) {
      out[key] = rewritten;
      changed = true;
    }
  }
  return { changed, input: out };
}

export function createPreToolUseHook(
  opts: CreatePreToolUseHookOptions,
): HookCallback {
  const idGen = opts.idGen ?? ((): string => randomUUID());
  const { workspaceRoot } = opts;

  return async (input, toolUseID) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }

    const klass = classifySdkToolName(input.tool_name);
    if (klass.kind === 'disabled') {
      // Belt-and-braces: disallowedTools should already block these.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'tool disabled by policy',
        },
      };
    }

    let parsed: ToolPreCallResponse;
    try {
      const raw = await opts.client.call('tool.pre-call', {
        call: {
          id: toolUseID ?? idGen(),
          name: klass.axName,
          input: input.tool_input,
        },
      });
      parsed = ToolPreCallResponseSchema.parse(raw) as ToolPreCallResponse;
    } catch (err) {
      // IPC failure: fall back to deny so subscribers can't be bypassed by a
      // racing disconnection. The SDK surfaces this as a turn error.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            err instanceof Error ? err.message : String(err),
        },
      };
    }

    if (parsed.verdict === 'reject') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: parsed.reason,
        },
      };
    }

    // Allow — optionally forward a modified input back to the SDK.
    const out: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse';
        permissionDecision: 'allow';
        updatedInput?: Record<string, unknown>;
      };
    } = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
    // Start from the host's modified input if it supplied one, else the
    // original. Either way, re-root any `.ax/uploads/` attachment path to the
    // absolute workspace path so file tools open the real file. Forward
    // updatedInput when the host modified it OR we rewrote a path.
    const hostModified =
      parsed.modifiedCall?.input !== undefined &&
      parsed.modifiedCall.input !== null &&
      typeof parsed.modifiedCall.input === 'object';
    const baseInput = hostModified
      ? (parsed.modifiedCall!.input as Record<string, unknown>)
      : (input.tool_input as Record<string, unknown>);
    const resolved = resolveAttachmentPaths(baseInput, workspaceRoot);
    if (hostModified || resolved.changed) {
      out.hookSpecificOutput.updatedInput = resolved.input;
    }
    return out;
  };
}
