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
 * A host executor's failure message is free text written by whatever library
 * or API the tool wraps, not by us. It is audit-trail detail, not prose a
 * human is meant to read as our voice, so it gets a generous clamp rather
 * than the tight ones above.
 */
const FAILURE_DETAIL_MAX = 200;

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

/**
 * A host executor's failure message, made safe to store and to hand to a
 * renderer. It is NOT a receipt: the receipt is always `FAILED_RECEIPT`. This
 * is the audit-trail detail, and a host tool's message can quote
 * model-authored input back at us (a rejected email address, an argument the
 * remote API echoed), so it is stripped of control characters — which could
 * forge a separate line in a log the way they could a hold note — and clamped
 * with the same `oneLine` helper everything else in this file uses.
 */
export function sanitizeFailureDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = oneLine(value, FAILURE_DETAIL_MAX);
  return clean.length > 0 ? clean : null;
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
 * Two more authored outcomes, alongside `approvedText`/`dismissedText` above.
 * AW-5 adds paths the mechanical form in `decisionText` cannot cover, because
 * neither of them is "the call went out as recorded":
 *
 *   - a host replay that ran and failed partway, and
 *   - a call the host cannot even attempt (sandbox-only tool).
 *
 * Both are constants, not templates built from `capability` or `toolName`, on
 * purpose. The design this whole file exists to avoid derived one outcome line
 * from a DIFFERENT outcome line by regex and shipped "sent your reply to Priya"
 * for a reply that was never sent (design H1). A constant cannot be derived
 * from anything — there is nothing to regex.
 *
 * There WAS a third: `RETRACTED_RECEIPT`, the line shown when a human took an
 * approval back inside the undo window. It is gone, and its absence is the
 * point (TASK-279). It existed to replace a receipt that had already been
 * pushed out to a feed; now the receipt is READ off the row, and an undone
 * decision is `pending` again, so the old line stops existing on its own. A
 * sentence whose whole job was to correct a claim we no longer make is a
 * sentence with nothing to say.
 *
 * Both survivors are read by `receiptFor` at the moment somebody looks, never
 * copied onto the row. `approvedText` is the opposite and deliberately so: it
 * is written ONTO the row when the human is asked, because it is the sentence
 * they agreed to and a rule edited afterwards must not rewrite it.
 */

/**
 * The receipt when a host replay FAILED. Never derived from `approvedText`:
 * `approvedText` says the call MAY run, which is true the instant a human
 * says yes, and stays true right up until the replay itself. Reusing any part
 * of that line here would let "you said yes" bleed into a receipt whose whole
 * job is to say the opposite — it tried, and it did not work.
 */
export const FAILED_RECEIPT =
  'It tried to do this, and it did not work. Nothing was completed.';

/**
 * The receipt when the host cannot replay the call at all — a tool that only
 * runs inside the sandbox next to the agent, which the host has no way to
 * reach once the turn has ended. This is not a failure: nothing was
 * attempted and nothing went wrong. It is a promise about the future, so it
 * says exactly that and nothing more — never "Sent", because nothing has
 * gone anywhere yet.
 */
export const PENDING_AGENT_RECEIPT =
  'Approved — it will do this the next time it runs.';

/**
 * The two sentences the MODEL reads when a person has ANSWERED a call it held
 * (AW-6), delivered to a still-warm agent as the next inbox message.
 *
 * Constants, and nothing else. Not the decision id: the model never saw it in
 * `holdNote` either, so putting it here would be a dangling reference to a
 * token the model has no memory of — strictly worse than no token. Not the
 * person's words: they clicked a button, they did not write prose, and inventing
 * a quote for them would be the same class of lie as claiming an unsent email
 * was sent (design H1). Not `call.input` either, for the reason the header of
 * this file gives — model output must not be echoed into a note the model reads
 * back as instruction.
 *
 * The approved note tells the agent to re-issue the call UNCHANGED. That is not
 * a request we trust: the standing authorisation is keyed on the call's
 * fingerprint, so an unchanged call passes the gate exactly once and any change
 * to it holds again. Saying so is a courtesy to the model, not the enforcement.
 *
 * The dismissed note has to close the door on a workaround, for the same reason
 * `holdNote` does: "no" that reads as "not this way" invites a different tool
 * and a shell command.
 */
export function decisionApprovedNote(): string {
  return (
    `A person has answered the approval you were waiting on. ` +
    `They said yes. You may now make that call again, exactly as you made it ` +
    `before — unchanged. An unchanged call goes through once; anything ` +
    `different will be held again. Then tell the user what happened.`
  );
}

export function decisionDismissedNote(): string {
  return (
    `A person has answered the approval you were waiting on. ` +
    `They said no, and nothing ran. Do not make that call again and do not ` +
    `look for another way to do the same thing. Acknowledge it, then carry on ` +
    `with whatever else they asked for or end your turn.`
  );
}

/**
 * The sentence the MODEL reads when its call is held.
 *
 * `hold` differs from `deny` precisely here: a deny invites a workaround — a
 * different tool, a shell command — and "not yet" must not read as "not this
 * way" (design §3.1). So this note says stop, says why, and says what to tell
 * the user, and it does so in our words.
 *
 * The decision id is deliberately NOT in this sentence. It has no consumer:
 * the model cannot act on it, and the correlation the system actually
 * enforces is the call fingerprint (`callFingerprint`), not this note. The
 * note itself reaches a user-visible transcript on the aisdk runner, whose
 * hold text is a single artifact serving both audiences — so the id stays
 * structural (`hold({decisionId})`, the Decision row, the runner's stderr
 * line) and out of the prose. The `hold()` helper in `@ax/core` clamps the
 * result at `HOLD_NOTE_MAX`; nothing here comes close, but the clamp is the
 * backstop that keeps an over-long note from failing the wire schema and
 * degrading into the deny this verdict exists to avoid.
 */
export function holdNote(input: {
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
    `Held for approval. ${what} ` +
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
