// ---------------------------------------------------------------------------
// Runner-authored operational notes for the claude-agent-sdk query.
//
// These notes describe the runtime environment to the LLM: where the
// workspace root is, the session-scoped scratch directory (`ephemeralRoot`),
// the python venv, the JIT capability-handoff behavior, and the skill-
// authoring discovery constraint.
//
// Each note is a FIXED runner-authored string with host-controlled values
// interpolated (`workspaceRoot` = AX_WORKSPACE_ROOT, `ephemeralRoot` =
// AX_EPHEMERAL_ROOT) — never from the model, the user, or tool output — so
// there is no untrusted-input path into the prompt here. It is plain prose
// for the LLM; not interpolated into a shell, path, SQL, or URL.
//
// The composed system prompt is always a plain string (the file-based
// prompt-engine assembles it from the agent's `.ax/` identity files + these
// notes — see prompt-engine.ts). The legacy `claude_code` preset / string-
// fallback path was removed in the conversational-agent-identity Phase 4
// (TASK-142) when the `system_prompt` column was dropped.
// ---------------------------------------------------------------------------

/**
 * The shape the SDK's `options.systemPrompt` accepts that we produce. We only
 * ever emit a plain string — the file-based prompt-engine composes one from
 * the agent's identity files + the runner's operational notes. (The SDK also
 * accepts presets / `string[]`; we no longer use them.)
 */
export type SdkSystemPrompt = string;

/**
 * Operational note telling the agent where its workspace is and how to resolve
 * workspace-relative paths — fixed runner-authored prose for the LLM.
 *
 * Without this the model treats an attachment path like `.ax/uploads/…` as a
 * home dotfile and reads it under `~`/`/home/<user>/…` instead of the workspace
 * root, so the read fails (the runner's PreToolUse hook re-roots it as a
 * safety net — see `resolveAttachmentPaths` — but stating the root up front
 * makes the model emit the right path directly). `workspaceRoot` is
 * host-controlled (AX_WORKSPACE_ROOT), never model/user/tool input.
 */
export function workspaceNote(workspaceRoot: string): string {
  return [
    `Workspace: \`${workspaceRoot}\` is your current working directory and the`,
    `root of your workspace — everything you create, and every file shared with`,
    `you, lives under it. Workspace-relative paths shown to you (for example a`,
    `user-attached file at \`.ax/uploads/…\`) are relative to \`${workspaceRoot}\`:`,
    `open them as \`${workspaceRoot}/.ax/uploads/…\` (or as a path relative to your`,
    `working directory) — NEVER under a home directory like \`~\` or \`/home/…\`.`,
  ].join(' ');
}

/**
 * Operational note telling the agent that `ephemeralRoot` is throwaway
 * scratch — written for the LLM, kept short and direct.
 */
export function ephemeralScratchNote(ephemeralRoot: string): string {
  return [
    `Scratch space: \`${ephemeralRoot}\` is a writable, session-scoped scratch directory.`,
    `Use it for throwaway files — temporary git clones, build caches, intermediate artifacts —`,
    `that should NOT become part of the workspace.`,
    `Anything you write under \`${ephemeralRoot}\` is discarded when the session ends and is`,
    `never committed or saved. Your current working directory persists and is saved at the`,
    `end of each turn; \`${ephemeralRoot}\` does not. Prefer \`${ephemeralRoot}\` for any file`,
    `you don't need to keep.`,
  ].join(' ');
}

/**
 * Operational note telling the agent a session-scoped Python virtualenv is
 * active so `pip install` + `import` work. Fixed runner-authored prose for
 * the LLM — no untrusted input. Paired with the venv created by
 * `scaffoldPythonVenv` (python-venv.ts) and the PATH/VIRTUAL_ENV env it sets.
 */
export function pythonVenvNote(): string {
  return [
    `Python: a session-scoped virtual environment is already active.`,
    `Use \`pip install <pkg>\` to add Python dependencies and \`python <script>.py\` to run them —`,
    `installed packages are importable immediately.`,
    `The environment is discarded when the session ends, and installs are limited to the`,
    `package registries your agent is permitted to reach.`,
  ].join(' ');
}

/**
 * JIT capability-handoff note (design §7 + §13). Two cases, both fixed
 * runner-authored prose for the LLM (no untrusted input):
 *
 *  1. CONNECT (§7): when the agent connects a new capability mid-conversation
 *     (via a connect/approval tool like `request_capability`), the conversation
 *     re-spawns + resumes after the user approves — so the agent should NOT
 *     narrate the mechanics, restate keys, or ask the user to repeat their
 *     request; it just answers the original ask once it continues.
 *
 *  2. COLD-START (§13): when a capability the agent needs isn't in the catalog
 *     yet, the broker has already filed a request for the admin to add it. The
 *     agent should narrate that as in-progress — "I've asked your admin to add
 *     X; I'll be able to do this once it's approved" — and NOT surface it as an
 *     error. (The broker fires this request automatically on a `search_catalog`
 *     miss / `request_capability` not-found — TASK-53.)
 *
 * Harmless when no connect tool / catalog exists, so it's always present (the
 * open-mode happy path reads as one continuous answer).
 */
export function capabilityHandoffNote(): string {
  return [
    `Connecting capabilities: when you connect a new capability mid-conversation`,
    `(for example via a connect/approval tool), do not narrate the mechanics and do`,
    `not restate any keys. Once the user approves, the conversation will continue`,
    `automatically — so do not ask the user to re-ask or repeat their request; just`,
    `answer their original request with the newly connected capability.`,
    `If a capability you need isn't available yet (a catalog search or capability`,
    `request comes back empty or not-found), a request to add it is filed for your`,
    `administrator automatically — so tell the user you've asked your admin to add it`,
    `and that you'll be able to help once it's approved. That is the expected outcome,`,
    `not an error: say it warmly and don't report a failure.`,
  ].join(' ');
}

/**
 * Skill-authoring note (TASK-74, design §D6) — the spawn-time-discovery
 * constraint. A skill the agent proposes via `skill_propose` is discovered only
 * when a session STARTS, so it becomes available on the user's NEXT message, not
 * the current turn. Without this guidance the model may propose a skill and then
 * try to invoke it in the same turn, fail to find it, and get confused.
 *
 * Fixed runner-authored prose for the LLM (no untrusted input). Always present
 * — harmless when no skill_propose tool is wired (the model just never proposes).
 */
export function skillAuthoringNote(): string {
  return [
    `Authoring skills: if you write a skill into \`/ephemeral/skill-draft/<id>/\` and`,
    `propose it with \`skill_propose\`, it becomes available on the user's NEXT message —`,
    `not this turn. Skills are discovered when your session starts, so a skill you propose`,
    `now is not yet loaded. Do NOT try to invoke a skill you proposed this turn; tell the`,
    `user it will be ready on their next message. If it needs network access or a`,
    `credential, the user approves it on an inline card first. If they asked you to create`,
    `AND use a skill in one breath, propose it and offer to continue once they reply.`,
  ].join(' ');
}

/**
 * Assemble the runner-authored operational notes block, in order:
 *   workspace → (ephemeral-scratch?) → (python-venv?) → capability-handoff →
 *   skill-authoring.
 *
 * Always includes the workspace note (the root is always known); the
 * ephemeral-scratch and python-venv notes are conditional on the sandbox
 * having wired a scratch tier / venv. The capability-handoff and
 * skill-authoring notes are always present (harmless when the corresponding
 * tools aren't wired). Returns a single string joined by blank lines —
 * always non-empty.
 *
 * Consumed by the file-based prompt-engine's normal mode (`prompt-engine.ts`),
 * so the operational notes are assembled in exactly one place.
 */
export function operationalNotes(
  workspaceRoot: string,
  ephemeralRoot: string | undefined,
  pythonVenvActive = false,
): string {
  const notes: string[] = [workspaceNote(workspaceRoot)];
  if (ephemeralRoot !== undefined) notes.push(ephemeralScratchNote(ephemeralRoot));
  if (pythonVenvActive) notes.push(pythonVenvNote());
  // Always last two: the JIT capability-handoff note (design §7) so the agent
  // doesn't narrate a mid-conversation connect/approval handoff, and the
  // skill-authoring spawn-time-discovery constraint (TASK-74 §D6). Both
  // harmless when the corresponding tools aren't wired.
  notes.push(capabilityHandoffNote());
  notes.push(skillAuthoringNote());
  return notes.join('\n\n');
}
