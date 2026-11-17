/**
 * The agent's reports about its OWN runtime context are not facts (TASK-612),
 * and neither is its narration of its own memory operations and tool failures
 * (TASK-1136).
 *
 * ## What went wrong
 *
 * Walk TASK-607 measured it on kind. A person saved a Rule while the agent's
 * sandbox was already running. The system prompt is built when the sandbox
 * starts, so the running session never saw it. Asked "do you have any
 * rules?", the agent answered truthfully for its snapshot, and the observer
 * stored this, word for word:
 *
 *     assistant | stated | No rules have been given by the user; the only
 *     instructions came from the system bootstrap prompt (...)
 *
 * That row then outlived the session and contradicted the Rule the person had
 * just saved.
 *
 * ## Why it can never be a durable fact, even when it is true
 *
 * What the agent can see of its rules, instructions or memory is a snapshot of
 * one session's system prompt. It describes the session, not the world. Rules
 * have exactly one source of truth (the Rules file) and memory has exactly one
 * (the store), so a transcript copy of either is a second, staler source of
 * truth for the same concept (invariant 4). That holds for "I have no rules"
 * and for "my rules say X" alike, so this drops both.
 *
 * ## Why a filter and not a prompt change
 *
 * The extraction prompt is fingerprint-pinned and may not be reworded
 * (`extraction-prompt.ts` has the measurements that pinned it). A
 * deterministic filter on what comes out is the change we are allowed to make,
 * and it is testable.
 *
 * ## Deliberately narrow
 *
 * Both halves must hold: the AGENT is the subject, and the fact ties rules,
 * instructions or memory to the agent's own context. "assistant | listed | the
 * rules of chess" is real content and survives; so does anything a PERSON
 * said about rules, because a person's statement is theirs to keep.
 *
 * ## Its narration of its own operations (TASK-1136)
 *
 * Walk TASK-1134 caught this on kind. In a Slack channel the agent's
 * `memory_note` was refused, the agent told the channel "I couldn't save that
 * to memory", and the observer stored
 *
 *     assistant | could_not_save_memory | …
 *
 * next to the very work fact the note had tried to save. "Saved it to memory"
 * and "couldn't fetch the page" are the same kind of row.
 *
 * None of it is ever a durable fact, for the reason above: memory's store is
 * the one source of truth for what memory holds, and each tool's own state is
 * the one for what the tool did. A transcript report of a save or a failure is
 * a second, staler copy, stale on arrival (invariant 4).
 *
 * Narrow on purpose, in three ways:
 *
 * - The subject must be the ASSISTANT (`assistant`, `the_assistant`,
 *   `ai_assistant`: what the pinned prompt tells the extractor to write), not
 *   TASK-612's wider list. `agent` and `the_agent` are everyday nouns here
 *   ("the agent couldn't get the seller to accept 450k" is a person's fact),
 *   and TASK-612 could afford them only because it also needs text about
 *   rules, instructions or memory.
 * - A failure predicate (`could_not_*`, `unable_to_*`, `failed_to_*`, …)
 *   counts only when what failed is one of its own operations, a TOOLING
 *   verb (save, fetch, access, connect, open, …), when the predicate itself
 *   names memory (`could_not_write_to_memory`), or when the text points at
 *   its own memory ("anything in memory", "my memory", "saved facts"). Most
 *   other failures are outcomes the person asked about: `could_not_find |
 *   any flights under $300`, `could_not_book | a table for 8`,
 *   `could_not_reproduce | the crash on Node 20`. Nothing else records
 *   those, so they're the assistant content the extraction prompt asks for,
 *   and they're kept. Failures of a tool whose verb isn't on the list
 *   (`could_not_get | the weather data`, `could_not_create | the event`)
 *   are kept too: a missed junk row is the cheap direction.
 * - Every memory word ends in TASK-612's {@link MEMORY}, so "memory card",
 *   "memory loss", "memory leaks" and the rest of its exclusions aren't the
 *   agent's memory. "Long-term memory" counts only as "in/from long-term
 *   memory" or after "anything in": "studies on long-term memory" is a
 *   topic.
 *
 * A person's failure (`user | could_not_attend`) is theirs to keep, and
 * `did_not_*` is content: "did not recommend the Hilton" is an answer.
 *
 * The accepted losses: advice that reads like a save with a pronoun ("how to
 * save it to memory on an Arduino", "a mnemonic to keep them in memory"),
 * topical phrases that
 * look like its own memory ("anything in memory dumps"), and a content outcome
 * phrased with a tooling verb (`could_not_open | the museum on Mondays`).
 * The other way round, a tool failure phrased as a search (`could_not_find |
 * the weather page`) is kept.
 */

/**
 * Subjects the extractor uses for the agent itself, after
 * {@link normalizeSubject}. The pinned prompt tells it to use `assistant`
 * (and the walk measured exactly that); the rest are its near spellings.
 * Deliberately NOT `ai` or `bot`: those are as likely to be a topic.
 */
const AGENT_SUBJECTS = new Set([
  'assistant',
  'the_assistant',
  'ai_assistant',
  'agent',
  'the_agent',
]);

/**
 * "rules"/"instructions" as the agent's OWN, not a topic: "rules of chess",
 * "instructions for the desk" and "rules about parking" are content.
 */
// The `\b` before the lookahead matters: without it the engine backtracks to
// "rule" + "s of thumb" and the lookahead never sees " of".
//
// "for/of/on/about/in/against" + a TOPIC ("rules of chess", "instructions for
// the desk", "rules in baseball", "rules against it") is content. The same
// words + the agent's OWN scope ("no rules for this conversation", "no
// instructions on what to do", "no rules in place") are still a self-report,
// so the exclusion only applies when what follows is not a scope word.
// Deliberately NOT excluded: "to" and "around" — "no instructions to follow",
// "no rules to speak of", "no rules around here" are the agent's own context
// far more often than a topic. Accepted limitation: "no instructions for the
// task" reads as a topic and is kept.
const SELF_SCOPE = String.raw`(?:you|me|us|this|our|now|yet|how|what|place|here)\b`;
const RULES = String.raw`(?:rules?|instructions?)\b(?! (?:of|for|on|about|in|against) (?!${SELF_SCOPE}))`;
// "memory" the product ("memory foam", "a memory card") is not the agent's.
const MEMORY = String.raw`(?:memor(?:y|ies)\b(?! (?:foam|cards?|sticks?|lanes?|leaks?|games?|loss|palace)\b)|(?:saved facts|(?:prior|previous) (?:conversations?|sessions?|chats?))\b)`;
const NEGATION = String.raw`(?:don't|do not|doesn't|does not|cannot|can't|haven't|have not|hasn't|has not|hadn't|had not|wasn't|was not|weren't|were not|never|has no|have no|had no|without)`;

/**
 * The longest text the patterns scan. The object is untrusted model output
 * with no length cap upstream, and this runs synchronously on the host. A
 * self-report is a sentence or two; the extraction prompt already asks for
 * assistant objects under 400 characters.
 */
const MAX_SCANNED_CHARS = 1_000;

/**
 * Phrases that tie rules/instructions/memory to the agent's own context. Run
 * over `predicate` (underscores as spaces) + `object`, lowercased.
 */
const CONTEXT_PATTERNS: readonly RegExp[] = [
  // "no rules", "no standing instructions", "no saved memories"
  new RegExp(String.raw`\bno (?:standing |saved |stored |custom )?(?:${RULES}|${MEMORY})`),
  // "rules have been given by the user", "instructions from you"
  new RegExp(
    String.raw`\b${RULES} (?:have been |has been |were |was )?(?:given |set |provided |saved )?(?:from|by) (?:you|the user|user|me)\b`,
  ),
  // "the rules I was given", "instructions it received"
  new RegExp(
    String.raw`\b${RULES} (?:i|it) (?:was |were |have been |has been |had been )?(?:given|received|set|provided)\b`,
  ),
  // "I haven't been given any rules", "doesn't have any memory of",
  // "cannot remember prior sessions", "never received any instructions"
  new RegExp(
    String.raw`\b${NEGATION} (?:been )?(?:have |see |remember |recall |retain |keep |given |received |provided |offered |told |shown |set )?(?:any )?(?:saved |standing )?(?:${RULES}|${MEMORY})`,
  ),
  // Its OWN prompt: "came from the system bootstrap prompt", "in its system
  // prompt". Not any mention — "how to write a good system prompt" and "a
  // system prompt injection attack" are topics a person asked about.
  // `{1,2}`, never `+`: an unbounded repeat here is O(n^2) on a long run of
  // "system system …" (measured ~2.6 s at 40k repeats).
  /\b(?:(?:from|in|by|via) (?:the|my|its)|my|its) (?:system |bootstrap ){1,2}prompt\b/,
  // "the system prompt is all I was given", "... was the only instruction".
  // Needs the agent in it: "a system prompt is all you need" is advice.
  /\b(?:system |bootstrap ){1,2}prompt (?:is|was) (?:all (?:i|it)|the only)\b/,
  // "its instructions", "my memory"
  /\b(?:my|its|the assistant's|the agent's) (?:rules|instructions|memory|memories)\b/,
];

/** A predicate that is itself about the agent's rules/memory: `has_no_rules`, `has_rules`. */
const CONTEXT_PREDICATE = /^(has|have|had|received|remembers|knows|sees)_(no_)?(rules|instructions|memory|memories)(_|$)/;

/**
 * The subjects TASK-1136's narration checks accept: the assistant as the
 * pinned prompt names it, after {@link normalizeSubject}. Narrower than
 * {@link AGENT_SUBJECTS} on purpose (see the header).
 */
const ASSISTANT_SUBJECTS = new Set(['assistant', 'the_assistant', 'ai_assistant']);

/**
 * Phrases that narrate one of the assistant's own memory operations
 * (TASK-1136), over the same `text` as {@link CONTEXT_PATTERNS}.
 */
const NARRATION_PATTERNS: readonly RegExp[] = [
  // Its own note tool by name: "used memory_note to save it", "the memory
  // note tool refused it".
  /\bmemory[_ ]notes?\b/,
  // "couldn't save that to memory", "saved it to memory", "noted this in
  // memory": a save verb, a pronoun for what was said, then memory. A noun
  // in the pronoun's place ("save data to memory on an Arduino") is a topic,
  // and so is a memory card.
  new RegExp(
    String.raw`\b(?:save|saved|saving|store|stored|storing|note|noted|noting|record|recorded|recording|add|added|adding|keep|kept|keeping|write|wrote|written|writing) (?:it|that|this|these|those|them) (?:to|in|into) (?:(?:my|its|the) )?${MEMORY}`,
  ),
];

/**
 * A predicate saying the assistant failed at something (TASK-1136):
 * `could_not_save_memory`, `failed_to_connect`, `was_unable_to`. Tested on
 * {@link normalizePredicate}'s output, so `Could Not Save` and `couldn't_save`
 * read alike. The closing `(?:_|$)` keeps it a whole word: `cantilevered`
 * isn't `cant`. Not `did_not_*`: "did not recommend the Hilton" is an answer.
 * A failure counts only with a {@link TOOL_VERB} or {@link OWN_MEMORY}.
 */
const FAILURE_PREDICATE =
  /^(?:could_?not|couldn_?t|can_?not|can_?t|(?:was_|were_|is_)?unable_to|failed_to|(?:was_|were_|is_)?not_able_to|(?:wasn|weren|isn)_?t_able_to)(?:_|$)/;

/**
 * What failed, when the failure is the assistant's own tooling rather than an
 * outcome the person asked about. Read from the rest of the predicate, or
 * from the object's start when the predicate is the failure alone
 * (`was_unable_to | save the note`), normalized like the predicate. `find`,
 * `confirm`, `book`, `recommend` and the like are deliberately absent: their
 * failures are answers. So are `keep`, `reach` and `write` ("couldn't keep
 * the trip under $2,000", "couldn't reach a conclusion", "couldn't write one
 * regex for every email address"); their memory sense is caught only when
 * the predicate says where (`could_not_write_to_memory`), not when memory is
 * in the object (`could_not_write | the note to memory` is kept).
 */
const TOOL_VERB =
  /^(?:save|store|record|note|remember|recall|add|fetch|retrieve|access|connect|open|load|read|run|execute|send|download|upload|call|attach|browse|search|query|log_?in|sign_?in|authenticate)(?![a-z])/;

/**
 * The assistant's OWN memory, as narration names it: "anything in memory",
 * "nothing saved in long-term memory", "my memory", "in my long-term memory",
 * "saved facts". Not bare "memory": "the memory spike in the worker pod" and
 * "the pod's memory limit" are what the person asked about, and every form
 * ends in {@link MEMORY}, so "long-term memory loss" isn't either.
 */
const OWN_MEMORY = new RegExp(
  String.raw`\b(?:(?:anything|nothing|something) (?:saved |stored )?(?:in|from) (?:(?:my|its|long-term|long term) )?|(?:my|its) |(?:in|from) (?:my|its) long[- ]term )${MEMORY}|\bsaved facts\b`,
);

/**
 * A failure predicate's rest that says WHERE: to, in, into or from memory
 * (`could_not_write_to_memory`, `could_not_keep_it_in_memory`). Not any
 * memory word: `could_not_reduce_memory_usage` and
 * `could_not_reproduce_the_memory_spike` are about RAM.
 */
const MEMORY_WORD = new RegExp(
  String.raw`\b(?:to|in|into|from) (?:(?:my|its|the|long term|long-term) )?${MEMORY}`,
);

/** A predicate that IS a memory operation (TASK-1136): `saved_to_memory`, `added_to_long_term_memory`. */
const MEMORY_OP_PREDICATE =
  /^(?:save|saved|store|stored|note|noted|add|added|record|recorded|write|wrote|written|keep|kept)_(?:(?:it|that|this)_)?(?:to|in|into)_(?:(?:my|its|the|long_term)_)?memor(?:y|ies)(?!_(?:foam|cards?|sticks?)(?:_|$))(?:_|$)/;

function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * For the TASK-1136 checks only (a predicate, or a bare failure's object
 * head): cut to the scanned window first,
 * like the text, then trimmed, lowercased, apostrophes dropped (`couldn't` →
 * `couldnt`), and each run of spaces or hyphens made one `_`.
 */
function normalizePredicate(predicate: string): string {
  return predicate
    .slice(0, MAX_SCANNED_CHARS)
    .trim()
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[\s-]+/g, '_');
}

/**
 * Whether a failure predicate narrates the assistant's own operation: what
 * failed is a {@link TOOL_VERB}, the rest of the predicate names memory, or
 * the text points at its own memory. A bare failure's verb is read from the
 * object's start, normalized like a predicate, inside the scanned window.
 */
function isOwnFailure(rest: string, object: string, text: string): boolean {
  if (rest !== '' && MEMORY_WORD.test(rest.replace(/_/g, ' '))) return true;
  // `normalizePredicate` cuts to the window BEFORE it trims, so an object
  // padded past the window has no verb in view.
  const verb = rest !== '' ? rest : normalizePredicate(object);
  return TOOL_VERB.test(verb) || OWN_MEMORY.test(text);
}

/** TASK-1136: the assistant narrating its own memory operations and tool failures. */
function isOwnNarration(normalized: string, object: string, text: string): boolean {
  const failure = FAILURE_PREDICATE.exec(normalized);
  if (failure !== null && isOwnFailure(normalized.slice(failure[0].length), object, text)) return true;
  if (MEMORY_OP_PREDICATE.test(normalized)) return true;
  return NARRATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function isAgentContextSelfReport(fact: {
  subject: string;
  predicate: string;
  object: string;
}): boolean {
  // The agent as subject, FIRST: everything below is only its own narration.
  const subject = normalizeSubject(fact.subject);
  if (!AGENT_SUBJECTS.has(subject)) return false;
  const predicate = fact.predicate.trim().toLowerCase();
  if (CONTEXT_PREDICATE.test(predicate)) return true;
  const text = `${predicate.replace(/_/g, ' ')} ${fact.object}`
    .slice(0, MAX_SCANNED_CHARS)
    .toLowerCase()
    .replace(/[‘’]/g, "'");
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return ASSISTANT_SUBJECTS.has(subject) && isOwnNarration(normalizePredicate(fact.predicate), fact.object, text);
}
