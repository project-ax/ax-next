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

// `draftPrefix` is the runner's source of truth for the model-facing skill-draft
// dir prefix (`<root>/.skill-draft/`). Imported (not re-derived) so the prose the
// model reads and the path the executor enforces never drift — the executor uses
// the SAME helper from `@ax/tool-skill-propose` (an already-declared runner dep,
// the pure path-validation helper, not a cross-plugin runtime coupling).
import { draftPrefix } from '@ax/tool-skill-propose';

/**
 * The shape the SDK's `options.systemPrompt` accepts that we produce. We only
 * ever emit a plain string — the file-based prompt-engine composes one from
 * the agent's identity files + the runner's operational notes. (The SDK also
 * accepts presets / `string[]`; we no longer use them.)
 */
export type SdkSystemPrompt = string;

// ---------------------------------------------------------------------------
// Default operating policy — how the agent works, and how it writes back.
//
// ATTRIBUTION: `workPolicyNote` and `communicationNote` are ADAPTED from the
// Grok Build system prompt — `crates/codegen/xai-grok-agent/templates/prompt.md`
// in https://github.com/xai-org/grok-build (Apache-2.0), at commit
// 19d42e35c07a9c9244f03f6df0c4c353f970d4f9. See `THIRD-PARTY-NOTICES.md` at the
// repo root. Modifications are listed there and flagged inline below.
//
// WHY these exist: the composed prompt is a plain string on BOTH runners — the
// Claude Agent SDK's `claude_code` preset was dropped in TASK-142 and a string
// `systemPrompt` REPLACES the preset rather than appending to it. So neither
// runner has ever carried work or communication guidance; the SDK runner only
// got the behavior implicitly, from Claude's own post-training on that harness.
// A non-Claude model on `@ax/agent-aisdk-runner` has neither, which is what
// these two notes fix. They live in core (not in one runner) because a
// runner-conditional prompt would fork behavior at exactly the seam the
// two-runner parity bar exists to keep honest.
//
// PRECEDENCE: composed AFTER the safety floor (which no file can suppress) and
// BEFORE `.ax/AGENTS.md` (the agent's override layer) — defaults first, then
// the overrides that act on them. See `composeNormalModePrompt`.
//
// Both are FIXED runner-authored strings with no interpolation: no untrusted
// input path, nothing to escape.
// ---------------------------------------------------------------------------

/**
 * Default working behavior — scope, honesty about what was verified, and which
 * tool to reach for. Overridable by `.ax/AGENTS.md`; the safety floor above it
 * is not.
 *
 * The evidence line ("done, fixed, tested … only when tool output supports the
 * claim") is the load-bearing one: a model without harness post-training will
 * otherwise report a success it never observed.
 */
export function workPolicyNote(): string {
  // Bulleted, not a paragraph: these are six independent rules the model checks
  // against, and the rest of the composed prompt is already markdown.
  return [
    `## How you work`,
    ``,
    `These are defaults. \`.ax/AGENTS.md\` below can override any of them; the`,
    `operating floor above them cannot be overridden.`,
    ``,
    `- Keep every explicit requirement of the request in view until it is done,`,
    `  superseded by the user, or genuinely blocked. If something is blocked, say`,
    `  so plainly rather than quietly dropping it.`,
    `- Match your response to what was asked: implement clear action requests, but`,
    `  answer questions, reviews, explanations and planning requests without`,
    `  making unsolicited edits.`,
    `- For work that is clear and reversible, do it in this turn instead of asking`,
    `  permission conversationally or ending with an offer to do it later.`,
    `- Say that something is done, fixed, tested or verified ONLY when tool output`,
    `  supports the claim. Otherwise state what you did not verify, and why.`,
    `- Keep changes scoped to what was asked, and match the surrounding code's`,
    `  comment and tooling conventions — comments stay short and factual and`,
    `  explain non-obvious constraints only. Never leave placeholder comments for`,
    `  unrelated work, and never let a comment or a suppression stand in for`,
    `  fixing the problem.`,
    `- Prefer the dedicated tools over their shell equivalents: \`Read\` over`,
    `  \`cat\`, \`Edit\` over \`sed\`, \`Glob\` and \`Grep\` over \`find\` and \`grep\`.`,
    `  Reserve \`Bash\` for commands that genuinely need a shell, and never use`,
    `  \`echo\` to talk to the user — everything you want them to read goes in your`,
    `  reply.`,
  ].join('\n');
}

/**
 * Default reply style — what a user-facing message has to carry on its own.
 *
 * DIVERGENCE from the upstream prompt (deliberate): its "never coin acronyms /
 * state facts literally / no metaphors or idioms" clauses are dropped. They
 * would fight the agent-authored `.ax/SOUL.md` that gives an agent its voice.
 * Structure is ours to set; style is the agent's. The upstream `<user_guide>`
 * and `<browser_verification>` sections are dropped as inapplicable, and the
 * subagent / background-task lines with them — we register no such tools.
 */
export function communicationNote(): string {
  return [
    `## How you communicate`,
    ``,
    `Defaults, and \`.ax/AGENTS.md\` below can override them.`,
    ``,
    `- Write every user-facing message for a reader who has not seen your tool`,
    `  calls, your notes, or the files you opened. Restate what you did and what`,
    `  you found in plain language; don't assume they remember earlier messages`,
    `  or know the state of the work.`,
    `- Define project-specific terms, abbreviations and codenames the first time`,
    `  you use them, and don't carry vocabulary out of internal docs, rules or`,
    `  skills into your replies unless the user used it first.`,
    `- Lead with the answer. Answer the actual question first — especially a`,
    `  "why" question — then give the supporting detail.`,
    `- If a question is answerable from what you already have, answer it instead`,
    `  of sending a clarifying question back, and give the relevant subset rather`,
    `  than dumping raw data.`,
    `- Keep progress updates short and infrequent. Your final message has to`,
    `  stand alone: what you did, how it came out, and the answer to what was`,
    `  asked.`,
    `- Your text is rendered as GitHub-flavored markdown. Use it where it helps`,
    `  the reader — lists for parallel items, \`inline code\` for identifiers,`,
    `  paths and commands, tables for short enumerable facts. When you nest`,
    `  fenced code blocks, make the outer fence longer than every inner fence.`,
  ].join('\n');
}

/**
 * Operational note telling the agent where its workspace is and how to resolve
 * workspace-relative paths — fixed runner-authored prose for the LLM.
 *
 * Without this the model treats an attachment path like `.ax/uploads/…` as a
 * home dotfile and reads it under `~`/`/home/<user>/…` instead of the workspace
 * root, so the read fails (the runner's PreToolUse hook re-roots it as a
 * safety net — see `resolveGovernedPaths` — but stating the root up front
 * makes the model emit the right path directly).
 *
 * filestore-user-files Phase 2 (TASK-164): `cwd` is the agent's working
 * directory (`AX_USERFILES_ROOT`=/workspace when a durable mount is wired, else
 * `workspaceRoot`). When the two DIFFER the note states both — the working dir
 * the agent operates in, and the governed `workspaceRoot` that shared files
 * (`.ax/uploads/…`) actually live under — so the model resolves attachments
 * against the governed root, not the new cwd (where they don't exist). When they
 * match (today / no durable mount) the prose is the original single-root form.
 * Both `workspaceRoot` and `cwd` are host-controlled (AX_WORKSPACE_ROOT /
 * AX_USERFILES_ROOT), never model/user/tool input.
 */
export function workspaceNote(workspaceRoot: string, cwd: string = workspaceRoot): string {
  if (cwd === workspaceRoot) {
    return [
      `Workspace: \`${workspaceRoot}\` is your current working directory and the`,
      `root of your workspace — everything you create, and every file shared with`,
      `you, lives under it. Workspace-relative paths shown to you (for example a`,
      `user-attached file at \`.ax/uploads/…\`) are relative to \`${workspaceRoot}\`:`,
      `open them as \`${workspaceRoot}/.ax/uploads/…\` (or as a path relative to your`,
      `working directory) — NEVER under a home directory like \`~\` or \`/home/…\`.`,
    ].join(' ');
  }
  return [
    `Workspace: \`${cwd}\` is your current working directory — relative paths and`,
    `new files you create land there. Your governed workspace state lives under`,
    `\`${workspaceRoot}\` instead: files shared with you (for example a user-attached`,
    `file at \`.ax/uploads/…\`) and your own \`.ax/…\` and \`.claude/…\` files are`,
    `under \`${workspaceRoot}\` — open a shared file as \`${workspaceRoot}/.ax/uploads/…\`,`,
    `NEVER relative to \`${cwd}\` and NEVER under a home directory like \`~\` or \`/home/…\`.`,
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
 * Operational note telling the agent that `userFilesRoot` is durable, shared
 * storage for the user's working files — fixed runner-authored prose for the
 * LLM (filestore-user-files Phase 1, design §6). Phase 1 only ADDS this mount to
 * the agent's reachable directories; the agent's working directory is still the
 * governed `/agent` tier (cwd/HOME re-root is Phase 2 / TASK-164), so the note
 * tells the agent to use the durable root EXPLICITLY by path for files that
 * should persist live across sessions (large/binary data, datasets, cloned
 * repos) and outlive the per-turn git round-trip. `userFilesRoot` is
 * host-controlled (AX_USERFILES_ROOT), never model/user/tool input.
 */
export function userFilesNote(userFilesRoot: string): string {
  return [
    `Durable files: \`${userFilesRoot}\` is a writable directory that persists`,
    `across sessions and is NOT versioned by the per-turn workspace snapshot.`,
    `Write files there (by their full \`${userFilesRoot}/…\` path) when you want`,
    `them to live across sessions without being committed — large or binary data,`,
    `datasets, downloaded or cloned repositories, build trees. Files you write`,
    `under \`${userFilesRoot}\` stay exactly as you left them next time; they are`,
    `the right home for anything big or long-lived that does not belong in your`,
    `versioned workspace.`,
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
 * Skill-authoring note (TASK-74, design §D6; filestore-user-files Phase 3 /
 * TASK-165) — tells the agent WHERE to author drafts and the spawn-time-discovery
 * constraint. A skill the agent proposes via `skill_propose` is discovered only
 * when a session STARTS, so it becomes available on the user's NEXT message, not
 * the current turn. Without this guidance the model may propose a skill and then
 * try to invoke it in the same turn, fail to find it, and get confused.
 *
 * The draft prefix is DYNAMIC (TASK-165): drafts stage under `<draftRoot>/.skill-draft/`
 * where `draftRoot` is the durable per-agent mount when one is wired (drafts persist
 * across sessions) else the ephemeral scratch tier. We interpolate the SAME prefix
 * the executor enforces (`draftPrefix`) so the model is told the exact accepted path.
 * `draftRoot` is host-controlled (AX_USERFILES_ROOT / AX_EPHEMERAL_ROOT), never
 * model/user/tool input. When neither tier is wired, fall back to a generic
 * `.skill-draft/<id>/` phrasing so the prose stays coherent (the tool will reject
 * a propose anyway, since there's nowhere to read the draft from).
 *
 * Fixed runner-authored prose for the LLM (no untrusted input). Always present
 * — harmless when no skill_propose tool is wired (the model just never proposes).
 */
export function skillAuthoringNote(draftRoot?: string): string {
  const dir = draftRoot !== undefined ? `${draftPrefix(draftRoot)}<id>/` : `.skill-draft/<id>/`;
  return [
    `Authoring skills: if you write a skill into \`${dir}\` and`,
    `propose it with \`skill_propose\`, it becomes available on the user's NEXT message —`,
    `not this turn. Skills are discovered when your session starts, so a skill you propose`,
    `now is not yet loaded. Do NOT try to invoke a skill you proposed this turn; tell the`,
    `user it will be ready on their next message. If it needs network access or a`,
    `credential, the user approves it on an inline card first. If they asked you to create`,
    `AND use a skill in one breath, propose it and offer to continue once they reply.`,
  ].join(' ');
}

/**
 * Clarifying-questions note. The SDK's built-in `AskUserQuestion` tool is
 * disabled in this runner (see DISABLED_BUILTINS in tool-names.ts) because its
 * interactive picker is answered by the CLI's own UI, and our headless
 * stream-json runner has no UI / control-protocol path to feed a user-chosen
 * answer back as the tool_result. Without the tool the model has no structured
 * way to ask the user to choose — so this note tells it to just ask in the
 * reply itself and wait, which renders and is answered in the normal turn flow.
 *
 * Fixed runner-authored prose for the LLM (no untrusted input). Always present.
 */
export function clarifyingQuestionsNote(): string {
  return [
    `Asking the user: when you need the user to make a choice, or to give you`,
    `information only they have, ask them directly in your reply — in plain`,
    `language, listing the options when there are a few — then stop and wait for`,
    `their answer before continuing. You have no separate question or menu tool;`,
    `the chat itself is how you ask. Only ask for what you genuinely need to`,
    `proceed, and keep going on your own whenever you reasonably can.`,
  ].join(' ');
}

/**
 * Assemble the runner-authored operational notes block, in order:
 *   workspace → (ephemeral-scratch?) → (python-venv?) → capability-handoff →
 *   skill-authoring → clarifying-questions.
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
  userFilesRoot: string | undefined = undefined,
  // filestore-user-files Phase 2 (TASK-164): the agent's effective working
  // directory. Defaults to workspaceRoot (today's behavior); when a durable
  // user-files mount moved cwd to /workspace, the workspace note states both the
  // working dir and the governed root so attachments still resolve correctly.
  cwd: string = workspaceRoot,
): string {
  const notes: string[] = [workspaceNote(workspaceRoot, cwd)];
  if (ephemeralRoot !== undefined) notes.push(ephemeralScratchNote(ephemeralRoot));
  // filestore-user-files Phase 1: advertise the durable per-agent mount when
  // the sandbox wired one (AX_USERFILES_ROOT). Conditional like the scratch
  // note — absent means no durable mount, so we say nothing about it.
  if (userFilesRoot !== undefined) notes.push(userFilesNote(userFilesRoot));
  if (pythonVenvActive) notes.push(pythonVenvNote());
  // Always-present tail: the JIT capability-handoff note (design §7) so the
  // agent doesn't narrate a mid-conversation connect/approval handoff, the
  // skill-authoring spawn-time-discovery constraint (TASK-74 §D6), and the
  // clarifying-questions note (which replaces the disabled AskUserQuestion
  // tool — see clarifyingQuestionsNote / DISABLED_BUILTINS). All harmless when
  // the corresponding tools aren't wired.
  notes.push(capabilityHandoffNote());
  // TASK-165: the skill-draft prefix is dynamic — drafts stage under the durable
  // per-agent mount when wired (userFilesRoot), else the ephemeral scratch tier
  // (ephemeralRoot), matching `userFilesRoot ?? ephemeralRoot` in the executor.
  // Pass the resolved root so the model is told the exact path the tool accepts.
  notes.push(skillAuthoringNote(userFilesRoot ?? ephemeralRoot));
  notes.push(clarifyingQuestionsNote());
  return notes.join('\n\n');
}
