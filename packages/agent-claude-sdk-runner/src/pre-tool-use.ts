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
import { POLICY_EXACT_PATHS, POLICY_PREFIXES } from '@ax/core';
import {
  ToolPreCallResponseSchema,
  type IpcClient,
  type ToolPreCallResponse,
} from '@ax/ipc-protocol';
import { classifySdkToolName } from './tool-names.js';

export interface CreatePreToolUseHookOptions {
  client: IpcClient;
  /**
   * Runner workspace root (AX_WORKSPACE_ROOT, e.g. `/agent`) — the GOVERNED git
   * tier. Used as the re-root TARGET for governed paths in tool inputs, so a
   * mis-rooted (or, under Plan 2, cwd-relative) `.ax/**`/`.claude/**` write lands
   * on the validated, git-backed tier rather than ungoverned NFS. See
   * `resolveGovernedPaths`. NOTE: this is the governed root, NOT necessarily the
   * SDK cwd — under Plan 2 cwd/HOME move to `/workspace` while this stays `/agent`.
   */
  workspaceRoot: string;
  /**
   * filestore-user-files Phase 2 (TASK-164) — the §14 governance LINCHPIN.
   *
   * When `true` (set iff `AX_USERFILES_ROOT` is wired, i.e. cwd/HOME = the durable
   * `/workspace` NFS mount), broaden the re-rooter from the legacy `.ax/uploads/`
   * attachment namespace to the FULL validator policy scope (`POLICY_PREFIXES`
   * `.ax/**`+`.claude/**` plus the root-exact `POLICY_EXACT_PATHS`
   * `CLAUDE.md`/`CLAUDE.local.md`). This forces every agent self-edit of governed
   * state back onto `/agent` even though the agent's cwd is now ungoverned NFS —
   * otherwise a `.ax/SOUL.md` write relative to `cwd=/workspace` would land on NFS,
   * bypass the validator, and break git-backed memory.
   *
   * When `false` (today's behavior — cwd/HOME = `/agent`, no NFS), only the legacy
   * `.ax/uploads/` attachment safety-net runs: there's no ungoverned tier to drift
   * onto, and broadening would needlessly rewrite `.claude/**` paths the agent
   * legitimately authors under its own working dir. Defaults to `false`.
   */
  broaden?: boolean;
  /**
   * The runtime root directories a TOP-LEVEL governed path may be rooted against
   * when `broaden` is on — typically the SDK cwd (`AX_USERFILES_ROOT`=/workspace)
   * and the scratch tier (`/ephemeral`). `workspaceRoot` is always added, and
   * `/home/<user>/`+`~/` are always recognized. Bounds the broadened re-root to
   * top-level governed dirs so a genuinely NESTED `.claude/` under a user subtree
   * (e.g. a cloned repo) is left on the user tier — matching the validator, which
   * governs only git-root-relative top-level `.ax/`+`.claude/`. Ignored when
   * `broaden` is false.
   */
  recognizedRoots?: readonly string[];
  /** Test seam: override the per-call id generator. Defaults to randomUUID. */
  idGen?: () => string;
}

// The workspace-relative namespace every uploaded attachment is KEYED under in
// the transcript (`.ax/uploads/<conv>/<turn>/<file>`). It's our own convention,
// so a path referencing it resolves to the materialized on-disk copy — a safe,
// deterministic re-root key the model can't strip. A subset of `.ax/**`, so the
// broadened (Plan 2) match subsumes it; this constant remains the SOLE match
// when `broaden` is off.
const UPLOADS_SEGMENT = '.ax/uploads/';
// The path-bearing input fields of the builtin file tools (Read/Write/Edit →
// file_path, NotebookEdit → notebook_path, Glob/Grep/LS → path). We rewrite
// ONLY these — never free-text fields like Edit's old_string/new_string,
// Write's content, or a Bash description, which could legitimately *mention*
// `.ax/uploads/` (or `.claude/...`) as text and must not be mangled.
const PATH_INPUT_KEYS = new Set(['file_path', 'path', 'notebook_path']);

// `~/` (literal tilde home) is always a recognized root for the dotfile-illusion
// mis-root. `/home/<user>/` is handled specially in `findGovernedSegment` because
// the username is a variable component (we match `/home/` + exactly one segment).
const TILDE_HOME_PREFIX = '~/';
const POSIX_HOME_BASE = '/home/';

/**
 * Find the offset of a TOP-LEVEL governed path SEGMENT in `value`, or -1 if none.
 *
 * A governed segment is one of:
 *   - a `POLICY_PREFIXES` entry (`.ax/`, `.claude/`) — the dir matches, or
 *   - a `POLICY_EXACT_PATHS` entry (`CLAUDE.md`, `CLAUDE.local.md`) ONLY as the
 *     FINAL component (so `CLAUDE.md/foo` — a dir literally named that — does not
 *     match; only the exact file does).
 *
 * To match the VALIDATOR's scope (which governs only top-level `.ax/`+`.claude/`
 * relative to the git root), the segment must appear at the TOP LEVEL of a
 * recognized root, NOT nested under an arbitrary user subdir. Concretely the
 * segment must start at offset 0 (bare relative) OR immediately after:
 *   - one of `recognizedRoots` (the cwd/workspaceRoot/ephemeral the caller passes), or
 *   - `~/`, or a `/home/<user>/` home dir (the dotfile-illusion mis-root — the
 *     model treats `.ax/x` as a home dotfile and resolves it under HOME).
 * So:
 *   - `.ax/x`, `/workspace/.ax/x`, `/home/runner/.claude/x`  → MATCH
 *   - `/workspace/myrepo/.claude/config`, `data/.ax/x`,
 *     `/home/runner/projects/.ax/x`                          → NO MATCH (nested;
 *     the validator wouldn't govern these either)
 *
 * Returns the index where the matched segment begins, so the caller re-roots
 * `<root>/.ax/x` → `<workspaceRoot>/.ax/x` keeping the policy-relative tail. The
 * scope is read from `@ax/core`'s `POLICY_*` constants so the re-root and the
 * validator stay in lockstep (invariant 4).
 */
function findGovernedSegment(
  value: string,
  matchers: readonly string[],
  exact: ReadonlySet<string>,
  recognizedRoots: readonly string[],
): number {
  const isGoverned = (tail: string): boolean =>
    matchers.some((p) => tail.startsWith(p)) || exact.has(tail);

  // Bare relative: the whole value is a top-level governed path.
  if (isGoverned(value)) return 0;

  // Explicit recognized roots (always end in `/` after normalization) + `~/`.
  const fixedPrefixes = [
    ...recognizedRoots.map((r) => (r.endsWith('/') ? r : `${r}/`)),
    TILDE_HOME_PREFIX,
  ];
  for (const prefix of fixedPrefixes) {
    if (value.startsWith(prefix) && isGoverned(value.slice(prefix.length))) {
      return prefix.length;
    }
  }

  // `/home/<user>/<governed>` — recognize a single-segment username under
  // /home/ as a home dir (the dotfile illusion), but NOT a deeper nesting
  // (`/home/<user>/projects/.ax` is the user's own subtree, left alone).
  if (value.startsWith(POSIX_HOME_BASE)) {
    const afterBase = value.slice(POSIX_HOME_BASE.length);
    const slash = afterBase.indexOf('/');
    if (slash > 0) {
      const homeDirLen = POSIX_HOME_BASE.length + slash + 1; // through `/home/<user>/`
      if (isGoverned(value.slice(homeDirLen))) return homeDirLen;
    }
  }
  return -1;
}

/**
 * If `value` references the legacy `.ax/uploads/` attachment namespace as a
 * path segment, re-root it under `workspaceRoot`; else null. This is the
 * pre-Plan-2 behavior, kept intact for the `broaden: false` path.
 *
 * TASK-78: uploads materialize at the ADVERTISED path
 * `<workspaceRoot>/.ax/uploads/<conv>/<turn>/<file>` — the absolute form of the
 * `.ax/uploads/...` key the system-prompt workspace note tells the model to open
 * (system-prompt.ts) and the same key the transcript/download scope use. So we
 * map `.ax/uploads/<rest>` → `<workspaceRoot>/.ax/uploads/<rest>` (KEEP the
 * `.ax/`). This is a safety net: with the materialized path matching the
 * advertised one, the model's own `/agent/.ax/uploads/...` is already
 * correct (no rewrite needed); we still normalize a home-rooted or bare
 * reference here so a mis-rooted Read/Glob/NotebookEdit still opens the file.
 *
 * Matches the segment at a path boundary (start of string or after a `/`) so
 * `foo.ax/uploads/x` is NOT treated as an attachment, and refuses any `..`
 * segment so a crafted `.ax/uploads/../../etc/x` can't be re-rooted out of the
 * uploads dir. Idempotent on an already-correct workspace path.
 */
function rerootUploadsPath(
  value: string,
  workspaceRoot: string,
): string | null {
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
  // `.ax/uploads/<rest>` → `<workspaceRoot>/.ax/uploads/<rest>` (keep the `.ax/`).
  return `${workspaceRoot}/${rel}`;
}

/**
 * filestore-user-files Phase 2 (TASK-164), the governance LINCHPIN. Broadened
 * re-rooter: if `value` references the FULL validator policy scope (`.ax/**`,
 * `.claude/**`, or root-exact `CLAUDE.md`/`CLAUDE.local.md`) as a path segment,
 * re-root it under `workspaceRoot` (the governed `/agent` tier); else null.
 *
 * Why: under Plan 2 the agent's cwd/HOME is the ungoverned `/workspace` NFS
 * mount, so a relative `.ax/SOUL.md` (or an absolute `/workspace/.ax/SOUL.md`,
 * or a home-rooted `/home/runner/.ax/SOUL.md`) would land on NFS — bypassing
 * the workspace validator (`@ax/core`'s `filterToPolicy`) and the per-turn git
 * bundle. Re-rooting these to `<workspaceRoot>/<governed-tail>` keeps every
 * governed self-edit on the validated, git-backed tier. The match scope is read
 * straight from `@ax/core`'s `POLICY_PREFIXES`/`POLICY_EXACT_PATHS` so the
 * re-root and the validator can never drift (invariant 4).
 *
 * Same safety rails as the uploads re-rooter: only matches a TOP-LEVEL governed
 * segment under a recognized root (so neither `foo.ax/x` NOR a genuinely nested
 * `/workspace/myrepo/.claude/x` — which the validator wouldn't govern — is
 * touched), refuses any `..` segment (so a crafted `.ax/../../etc/x` can't
 * escape), keeps the matched policy tail, and is idempotent on an already-
 * `<workspaceRoot>`-rooted path. `recognizedRoots` are the runtime roots a
 * top-level governed path may legitimately be rooted against (cwd, workspaceRoot,
 * ephemeral); `/home/<user>/` and `~/` are always recognized.
 */
function rerootGovernedPath(
  value: string,
  workspaceRoot: string,
  recognizedRoots: readonly string[],
): string | null {
  const idx = findGovernedSegment(
    value,
    POLICY_PREFIXES,
    POLICY_EXACT_PATHS,
    recognizedRoots,
  );
  if (idx < 0) return null;
  const rel = value.slice(idx); // `.ax/<...>` | `.claude/<...>` | `CLAUDE.md` | ...
  if (rel.split('/').includes('..')) return null;
  return `${workspaceRoot}/${rel}`;
}

/**
 * Re-root governed paths a tool is about to touch to the absolute governed-tier
 * path, so file tools (Read, Edit, …) open/write the real file on the validated,
 * git-backed `/agent` tier regardless of how the model rooted it.
 *
 * Two scopes, selected by `broaden`:
 *
 *  - `broaden: false` (default — pre-Plan-2): only the legacy `.ax/uploads/`
 *    attachment namespace re-roots. An uploaded attachment is referenced by a
 *    workspace-relative path (`.ax/uploads/...`); because that path starts with
 *    a dot, the model reads it as a home dotfile and resolves it under
 *    `~`/`/home/<user>` instead of its working directory — so `Read` fails (the
 *    file is at `/agent/.ax/uploads/...`). (We first tried an `ax-file://`
 *    scheme; the model stripped it, then home-rooted the bare path anyway. So we
 *    resolve by the `.ax/uploads/` marker the model can't strip.)
 *
 *  - `broaden: true` (filestore-user-files Phase 2 / TASK-164 — cwd/HOME on the
 *    ungoverned `/workspace` NFS mount): the FULL validator policy scope
 *    (`.ax/**`, `.claude/**`, root-exact `CLAUDE.md`/`CLAUDE.local.md`) re-roots
 *    to `/agent`. This is the §14 governance linchpin: it forces every agent
 *    self-edit of governed state back onto the validated, git-backed tier even
 *    though a relative path would otherwise resolve onto ungoverned NFS.
 *
 * Rewrites ONLY the structured path fields (`PATH_INPUT_KEYS`) as a whole-value
 * re-root — handling a home-prefixed (`/home/user/.ax/x`), cwd/NFS-prefixed
 * (`/workspace/.ax/x`), bare (`.ax/x`), or already-correct (`/agent/.ax/x`,
 * idempotent) reference. Free-text fields (a Bash command, an Edit's old_string,
 * etc.) are left untouched; the system-prompt workspace note (see
 * system-prompt.ts) steers the model to emit the right path for those.
 */
export function resolveGovernedPaths(
  input: unknown,
  workspaceRoot: string,
  opts: { broaden: boolean; recognizedRoots?: readonly string[] } = {
    broaden: false,
  },
): { changed: boolean; input: Record<string, unknown> } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { changed: false, input: {} };
  }
  const src = input as Record<string, unknown>;
  const wsRoot = workspaceRoot.replace(/\/+$/, '');
  // The broadened re-rooter recognizes a top-level governed segment under any of
  // these roots (plus /home/ + ~/, always). workspaceRoot is included so an
  // already-`/agent`-rooted path is recognized (and idempotent). The legacy
  // uploads re-rooter ignores roots (its `.ax/uploads/` namespace is specific
  // enough to match mid-path safely).
  const recognizedRoots = [wsRoot, ...(opts.recognizedRoots ?? [])];
  const reroot = (value: string): string | null =>
    opts.broaden
      ? rerootGovernedPath(value, wsRoot, recognizedRoots)
      : rerootUploadsPath(value, wsRoot);
  let changed = false;
  const out: Record<string, unknown> = { ...src };
  for (const [key, value] of Object.entries(src)) {
    if (!PATH_INPUT_KEYS.has(key) || typeof value !== 'string') continue;
    const rerooted = reroot(value);
    if (rerooted !== null && rerooted !== value) {
      out[key] = rerooted;
      changed = true;
    }
  }
  return { changed, input: out };
}

/**
 * @deprecated Back-compat alias for `resolveGovernedPaths(input, root)` (the
 * pre-Plan-2 uploads-only scope). Prefer `resolveGovernedPaths` with an explicit
 * `broaden` flag.
 */
export function resolveAttachmentPaths(
  input: unknown,
  workspaceRoot: string,
): { changed: boolean; input: Record<string, unknown> } {
  return resolveGovernedPaths(input, workspaceRoot, { broaden: false });
}

export function createPreToolUseHook(
  opts: CreatePreToolUseHookOptions,
): HookCallback {
  const idGen = opts.idGen ?? ((): string => randomUUID());
  const { workspaceRoot } = opts;
  const broaden = opts.broaden ?? false;
  const recognizedRoots = opts.recognizedRoots ?? [];

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

    // Re-root any governed path BEFORE adjudication, so the host's tool:pre-call
    // sees (and policy-checks) the real path the tool will actually open — not
    // the model's mis-rooted (or, under Plan 2, cwd-relative) one. The re-rooted
    // input is also what we forward to the SDK on allow. `broaden` widens the
    // scope from the legacy `.ax/uploads/` attachment safety-net to the full
    // `.ax/**`+`.claude/**` validator policy when cwd/HOME is the ungoverned NFS
    // mount (TASK-164 §14 linchpin).
    const resolved = resolveGovernedPaths(input.tool_input, workspaceRoot, {
      broaden,
      recognizedRoots,
    });

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
