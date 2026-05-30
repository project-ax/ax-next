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
  /**
   * TASK-68: where uploaded attachments are MATERIALIZED on disk. Uploads left
   * git — at session start the runner materializes them under
   * `<ephemeralRoot>/uploads/<conv>/<turn>/<file>` (from the blob store), so a
   * `.ax/uploads/...` reference in a tool input must re-root THERE, not under
   * `<workspaceRoot>/.ax/uploads/`. When undefined (no ephemeral tier), the
   * legacy `<workspaceRoot>/.ax/uploads/` target is used.
   */
  uploadsRoot?: string;
  /** Test seam: override the per-call id generator. Defaults to randomUUID. */
  idGen?: () => string;
}

// The workspace-relative namespace every uploaded attachment is KEYED under in
// the transcript (`.ax/uploads/<conv>/<turn>/<file>`). It's our own convention,
// so a path referencing it resolves to the materialized on-disk copy — a safe,
// deterministic re-root key the model can't strip.
const UPLOADS_SEGMENT = '.ax/uploads/';
// The on-disk subdir uploads materialize into under the ephemeral root
// (`<ephemeralRoot>/uploads/<conv>/<turn>/<file>`). The transcript KEY keeps the
// `.ax/` prefix; the materialized PATH drops it.
const MATERIALIZED_SEGMENT = 'uploads/';
// The path-bearing input fields of the builtin file tools (Read/Write/Edit →
// file_path, NotebookEdit → notebook_path, Glob/Grep/LS → path). We rewrite
// ONLY these — never free-text fields like Edit's old_string/new_string,
// Write's content, or a Bash description, which could legitimately *mention*
// `.ax/uploads/` as text and must not be mangled.
const PATH_INPUT_KEYS = new Set(['file_path', 'path', 'notebook_path']);

/**
 * If `value` references the `.ax/uploads/` attachment namespace as a path
 * segment, return it re-rooted at the MATERIALIZED on-disk location; else null
 * (leave the value alone).
 *
 * TASK-68: uploads no longer live in git at `<workspaceRoot>/.ax/uploads/`. They
 * materialize under `<uploadsRoot>/uploads/<conv>/<turn>/<file>` (uploadsRoot =
 * the ephemeral root). The transcript KEY keeps the `.ax/uploads/` prefix (the
 * stable download/scope key), so we map `.ax/uploads/<rest>` →
 * `<uploadsRoot>/uploads/<rest>` (drop the `.ax/`). When no ephemeral tier is
 * wired (`uploadsRoot` undefined), fall back to the legacy
 * `<workspaceRoot>/.ax/uploads/<rest>` target.
 *
 * Matches the segment at a path boundary (start of string or after a `/`) so
 * `foo.ax/uploads/x` is NOT treated as an attachment, and refuses any `..`
 * segment so a crafted `.ax/uploads/../../etc/x` can't be re-rooted out of the
 * materialized dir. Idempotent on an already-correct materialized path.
 */
function rerootUploadsPath(
  value: string,
  workspaceRoot: string,
  uploadsRoot: string | undefined,
): string | null {
  // Already a correct materialized path? Leave it (idempotent).
  if (uploadsRoot !== undefined && value.startsWith(`${uploadsRoot}/${MATERIALIZED_SEGMENT}`)) {
    return null;
  }
  let idx = -1;
  if (value.startsWith(UPLOADS_SEGMENT)) {
    idx = 0;
  } else {
    const j = value.indexOf(`/${UPLOADS_SEGMENT}`);
    if (j >= 0) idx = j + 1;
  }
  if (idx < 0) return null;
  const rel = value.slice(idx); // `.ax/uploads/<...>`
  if (rel.split('/').includes('..')) return null;
  if (uploadsRoot !== undefined) {
    // `.ax/uploads/<rest>` → `<uploadsRoot>/uploads/<rest>` (drop the `.ax/`).
    const afterPrefix = rel.slice(UPLOADS_SEGMENT.length); // `<conv>/<turn>/<file>`
    return `${uploadsRoot}/${MATERIALIZED_SEGMENT}${afterPrefix}`;
  }
  // Legacy fallback: no ephemeral tier — keep the in-workspace target.
  return `${workspaceRoot}/${rel}`;
}

/**
 * Re-root attachment paths a tool is about to touch to the absolute workspace
 * path, so file tools (Read, Edit, …) open the real file regardless of how the
 * model rooted it.
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
 * Rewrites ONLY the structured path fields (`PATH_INPUT_KEYS`) as a whole-value
 * re-root — handling a home-prefixed (`/home/user/.ax/uploads/x`), bare
 * (`.ax/uploads/x`), or already-correct (`/permanent/.ax/uploads/x`,
 * idempotent) reference. Free-text fields (a Bash command, an Edit's
 * old_string, etc.) are left untouched; the system-prompt workspace note (see
 * system-prompt.ts) steers the model to emit the right path for those.
 */
export function resolveAttachmentPaths(
  input: unknown,
  workspaceRoot: string,
  uploadsRoot?: string,
): { changed: boolean; input: Record<string, unknown> } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { changed: false, input: {} };
  }
  const src = input as Record<string, unknown>;
  const wsRoot = workspaceRoot.replace(/\/+$/, '');
  const upRoot = uploadsRoot?.replace(/\/+$/, '');
  let changed = false;
  const out: Record<string, unknown> = { ...src };
  for (const [key, value] of Object.entries(src)) {
    if (!PATH_INPUT_KEYS.has(key) || typeof value !== 'string') continue;
    const rerooted = rerootUploadsPath(value, wsRoot, upRoot);
    if (rerooted !== null && rerooted !== value) {
      out[key] = rerooted;
      changed = true;
    }
  }
  return { changed, input: out };
}

export function createPreToolUseHook(
  opts: CreatePreToolUseHookOptions,
): HookCallback {
  const idGen = opts.idGen ?? ((): string => randomUUID());
  const { workspaceRoot, uploadsRoot } = opts;

  // `HookCallback` is `(input, toolUseID, options: { signal })` — the SDK
  // always invokes the hook with the third options arg. We don't use it, but
  // declare it (`_options`) so the impl's arity matches the call sites (same
  // convention as canUseTool's `_options`). Omitting it made the third
  // argument look "superfluous" to CodeQL at every call site.
  return async (input, toolUseID, _options) => {
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

    // Re-root any `.ax/uploads/` attachment path BEFORE adjudication, so the
    // host's tool:pre-call sees (and policy-checks) the real path the tool will
    // actually open — not the model's mis-rooted one. The re-rooted input is
    // also what we forward to the SDK on allow.
    const resolved = resolveAttachmentPaths(input.tool_input, workspaceRoot, uploadsRoot);

    let parsed: ToolPreCallResponse;
    try {
      const raw = await opts.client.call('tool.pre-call', {
        call: {
          id: toolUseID ?? idGen(),
          name: klass.axName,
          input: resolved.input,
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
    // Forward updatedInput when the host transformed the call (its
    // modifiedCall.input was computed against the already-resolved input we
    // sent, so it wins) OR when we re-rooted an attachment path.
    const hostModified =
      parsed.modifiedCall?.input !== undefined &&
      parsed.modifiedCall.input !== null &&
      typeof parsed.modifiedCall.input === 'object';
    if (hostModified) {
      out.hookSpecificOutput.updatedInput = parsed.modifiedCall!.input as Record<
        string,
        unknown
      >;
    } else if (resolved.changed) {
      out.hookSpecificOutput.updatedInput = resolved.input;
    }
    return out;
  };
}
