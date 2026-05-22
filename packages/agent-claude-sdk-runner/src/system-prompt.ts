// ---------------------------------------------------------------------------
// System-prompt assembly for the claude-agent-sdk query.
//
// Two inputs converge here:
//   1. The agent's frozen, USER-AUTHORED system prompt (empty => fall back
//      to the SDK's `claude_code` preset).
//   2. A runner-authored operational note describing the session-scoped
//      scratch directory (`ephemeralRoot`), when the sandbox provided one.
//
// The note is a FIXED runner-authored string with `ephemeralRoot`
// interpolated. `ephemeralRoot` originates from the sandbox provider
// (AX_EPHEMERAL_ROOT, host-controlled) — never from the model, the user,
// or tool output — so there is no untrusted-input path into the prompt
// here. It is plain prose for the LLM; not interpolated into a shell,
// path, SQL, or URL.
//
// SDK quirk this module exists to handle: the preset form accepts an
// `append` field, but it "has no effect when systemPrompt is a string"
// (sdk.d.ts). So for a custom string prompt we must concatenate the note
// ourselves; for the preset we use the native `append`.
// ---------------------------------------------------------------------------

/**
 * The shape the SDK's `options.systemPrompt` accepts that we actually
 * produce. The SDK also accepts `string[]` and other presets; we only emit
 * a plain string (custom prompt) or the `claude_code` preset.
 */
export type SdkSystemPrompt =
  | string
  | { type: 'preset'; preset: 'claude_code'; append?: string };

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
 * Build the SDK `systemPrompt` value from the agent's frozen prompt and the
 * optional ephemeral scratch root.
 *
 * - Empty agent prompt => `claude_code` preset (with the scratch note
 *   appended via the SDK's native `append` when a root is present).
 * - Non-empty agent prompt => the verbatim string, with the scratch note
 *   concatenated ourselves (the preset `append` is a no-op on strings).
 * - No ephemeral root => unchanged: verbatim string or bare preset.
 */
export function buildSystemPrompt(
  agentSystemPrompt: string,
  ephemeralRoot: string | undefined,
): SdkSystemPrompt {
  const note =
    ephemeralRoot !== undefined ? ephemeralScratchNote(ephemeralRoot) : '';

  if (agentSystemPrompt.length > 0) {
    return note.length > 0
      ? `${agentSystemPrompt}\n\n${note}`
      : agentSystemPrompt;
  }

  return note.length > 0
    ? { type: 'preset', preset: 'claude_code', append: note }
    : { type: 'preset', preset: 'claude_code' };
}
