/**
 * Every sentence this plugin writes.
 *
 * ALL OF IT IS HOST-AUTHORED. The only variables are the policy rule's
 * `capability` clause and the tool's name, both of which are in-repo values
 * that a human reviewed in a diff. `call.input` — the model-authored half of a
 * tool call — is stored verbatim on the row and NEVER reaches any string in
 * this file. That is the H6 / invariant-5 line: model output must not be echoed
 * into a note the model reads back as instruction, nor onto a surface a human
 * reads as a factual claim about what their agent is about to do.
 *
 * `capability` and `toolName` arrive over the hook bus from `@ax/tool-policy`.
 * Today that is the in-repo rule table, but the boundary review names a
 * per-tenant DB-backed alternate impl, so both are sanitised here rather than
 * trusted — this file is the last place before the text lands in a durable row
 * and in a runner's stderr.
 *
 * WHY THIS IS NOT A PER-RULE TEMPLATE TABLE. The plan allows a rule to carry
 * its own authored `summary`/`approvedText`. `PolicyRule` carries no such
 * fields (see `@ax/tool-policy`'s `types.ts`), and AW-4 does not modify that
 * package — so every rule falls to the mechanical form below. A per-ruleId
 * table living HERE was considered and rejected: invariant 2 forbids importing
 * `BUILTIN_RULES`, so nothing could lint the two halves against each other and
 * a renamed rule would silently downgrade to the fallback anyway. When a rule
 * earns bespoke prose, the prose belongs on the rule.
 */

/** Matches `@ax/tool-policy`'s own `CAPABILITY_MAX_CHARS`, with headroom. */
const CAPABILITY_MAX = 120;
const TOOL_NAME_MAX = 64;

/**
 * The shape a tool name is allowed to have before we are willing to print it.
 * Deliberately narrower than "any string": these names come back through
 * `tool-policy:evaluate`, they end up in a durable row and in a `hold` note
 * that is written to the runner's stderr, and neither of those surfaces
 * escapes anything.
 */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * C0 and C1 control characters. Written as escapes rather than literal bytes
 * on purpose: a raw control byte in a source file makes git treat it as binary
 * and makes the diff unreviewable.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** What we call a tool we are not willing to name. */
const UNNAMEABLE_TOOL = 'a tool';

/**
 * Strip everything that could break out of a single line, then clamp.
 *
 * Control characters (including CR/LF) are the ones that matter: the hold note
 * is emitted as a log/stderr line, and a newline inside it would let text that
 * came from outside this file forge what looks like a separate host-authored
 * line.
 */
function oneLine(value: string, max: number): string {
  const flat = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function sanitizeCapability(capability: string | null | undefined): string | null {
  if (typeof capability !== 'string') return null;
  const clean = oneLine(capability, CAPABILITY_MAX);
  return clean.length > 0 ? clean : null;
}

export function sanitizeToolName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const clean = oneLine(name, TOOL_NAME_MAX);
  return SAFE_TOOL_NAME.test(clean) ? clean : null;
}

export interface DecisionTextInput {
  /** The rule's bare capability clause, or null when no rule described it. */
  capability: string | null;
  /** The tool the model asked for. */
  toolName: string;
}

export interface DecisionText {
  summary: string;
  detail: string;
  primaryLabel: string;
  secondaryLabel: string;
  ghostLabel: string;
  approvedText: string;
  dismissedText: string;
}

/**
 * The Decision row's prose.
 *
 * `approvedText` and `dismissedText` are written independently, on purpose. The
 * design this came from derived the dismissed line from the approved one by
 * regex and shipped "you took over — sent your reply" for a reply that was
 * never sent (design H1). Neither line below is reachable from the other by
 * string surgery, and a test asserts it.
 */
export function decisionText(input: DecisionTextInput): DecisionText {
  const capability = sanitizeCapability(input.capability);
  const tool = sanitizeToolName(input.toolName) ?? UNNAMEABLE_TOOL;

  // The subject is always "it" — the agent. Naming the agent would mean
  // reading a display name from another plugin at hold time, and the row has
  // to be writable inside a 10-second ceiling.
  const summary =
    capability !== null ? `Wants to ${capability}` : `Wants to run ${tool}`;

  const detail =
    capability !== null
      ? `It stopped before running ${tool}, because that would ${capability}. ` +
        `Nothing has happened yet — it is waiting for your answer.`
      : `It stopped before running ${tool} and is waiting for your answer. ` +
        `Nothing has happened yet.`;

  return {
    summary,
    detail,
    primaryLabel: 'Yes, go ahead',
    secondaryLabel: 'Show me the details',
    ghostLabel: "No — I'll handle it",
    approvedText:
      capability !== null
        ? `You said yes, so it may ${capability}.`
        : `You said yes, so it may run ${tool}.`,
    // Written from scratch, not from the line above. It states what did NOT
    // happen, which is the claim a dismissal is actually making.
    dismissedText:
      capability !== null
        ? `You turned this down. It did not ${capability}, and nothing ran.`
        : `You turned this down. Nothing ran and nothing changed.`,
  };
}

/**
 * The sentence the MODEL reads when its call is held.
 *
 * `hold` differs from `deny` precisely here: a deny invites a workaround — a
 * different tool, a shell command — and "not yet" must not read as "not this
 * way" (design §3.1). So this note says stop, says why, and says what to tell
 * the user, and it does so in our words.
 *
 * `decisionId` is interpolated unescaped into a runner stderr line downstream,
 * so it is host-generated (`dec_<32 hex>`, see `plugin.ts`) and never derived
 * from anything the model wrote. The `hold()` helper in `@ax/core` clamps the
 * result at `HOLD_NOTE_MAX`; nothing here comes close, but the clamp is the
 * backstop that keeps an over-long note from failing the wire schema and
 * degrading into the deny this verdict exists to avoid.
 */
export function holdNote(input: {
  decisionId: string;
  capability: string | null;
  toolName: string;
}): string {
  const capability = sanitizeCapability(input.capability);
  const tool = sanitizeToolName(input.toolName) ?? UNNAMEABLE_TOOL;
  const what =
    capability !== null
      ? `Running ${tool} would ${capability}, and that needs a person's approval.`
      : `Running ${tool} needs a person's approval.`;

  return (
    `Held for approval (${input.decisionId}). ${what} ` +
    `The call has been recorded exactly as you made it and is waiting for the user. ` +
    `Do not retry it and do not look for another way to do the same thing. ` +
    `Tell the user what you were about to do and why, then end your turn.`
  );
}

/**
 * The sentence the model reads when policy says no outright.
 *
 * Unlike a hold, this one IS final, and says so. It still names the reason,
 * because a denial with no reason is the one most likely to be worked around.
 */
export function denialSentence(input: {
  capability: string | null;
  toolName: string;
}): string {
  const capability = sanitizeCapability(input.capability);
  const tool = sanitizeToolName(input.toolName) ?? UNNAMEABLE_TOOL;
  return capability !== null
    ? `Not allowed: this agent may not ${capability}, so ${tool} did not run. ` +
        `This is a standing rule, not something a retry can change.`
    : `Not allowed: ${tool} did not run. This is a standing rule, not something ` +
        `a retry can change.`;
}

/**
 * What the model is told when the gate itself failed.
 *
 * The gate fails CLOSED. `HookBus.fire` swallows a subscriber throw and carries
 * on, which would turn any internal error here into a silent allow — the worst
 * possible failure for a component whose entire job is to stop calls. So every
 * error path returns this instead.
 *
 * Deliberately carries no internal detail: the model does not need our stack,
 * and a message shaped by an internal error is a message we did not author.
 */
export const GATE_FAILURE_SENTENCE =
  'Not allowed: the approval check could not be completed, so the call did not run. ' +
  'Tell the user this needs looking at, then end your turn.';
