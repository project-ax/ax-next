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
 * Narrow on purpose. The AGENT must be the subject, and the fact must carry a
 * failure predicate (`could_not_*`, `unable_to_*`, `failed_to_*`, …), a
 * memory-operation predicate (`saved_to_memory`), or text that anchors the
 * operation to memory ("save that to memory", "memory_note"). A person's
 * failure (`user | could_not_attend`) is theirs to keep, and `did_not_*` is
 * content: "did not recommend the Hilton" is an answer.
 *
 * So is a failure to find, locate, confirm or recommend something:
 * `could_not_find | any flights under $300 on the 14th` is the answer to what
 * the person asked, the assistant content the extraction prompt asks for. It's
 * kept unless the text mentions memory, because then the agent is reporting
 * what it looked up in its own memory, which the store already answers.
 *
 * The accepted losses: a content outcome phrased with any other failure verb
 * (`could_not_book | a table for 8 on Friday`), and programming advice that
 * reads like a save ("how to save it to memory on an Arduino", "instead of
 * keeping it in memory"). Both are dropped. The other way round, a tool
 * failure phrased as a search (`could_not_find | the weather page`) is kept.
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
 * Phrases that tie rules/instructions/memory to the agent's own context, or
 * narrate one of its memory operations (TASK-1136). Run over `predicate`
 * (underscores as spaces) + `object`, lowercased.
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
  // TASK-1136. Its own note tool by name: "used memory_note to save it",
  // "the memory note tool refused it".
  /\bmemory[_ ]notes?\b/,
  // "couldn't save that to memory", "saved it to memory", "noted this in
  // memory": a save verb, a pronoun for what was said, then memory. A noun
  // in the pronoun's place ("save data to memory on an Arduino") is a topic.
  /\b(?:save|saved|saving|store|stored|storing|note|noted|noting|record|recorded|recording|add|added|adding|keep|kept|keeping|write|wrote|written|writing) (?:it|that|this|these|those|them) (?:to|in|into) (?:(?:my|its|the|long-term|long term) )?memor(?:y|ies)\b/,
];

/** A predicate that is itself about the agent's rules/memory: `has_no_rules`, `has_rules`. */
const CONTEXT_PREDICATE = /^(has|have|had|received|remembers|knows|sees)_(no_)?(rules|instructions|memory|memories)(_|$)/;

/**
 * A predicate saying the agent failed at something (TASK-1136):
 * `could_not_save_memory`, `failed_to_connect`, `was_unable_to`. Tested on
 * {@link normalizePredicate}'s output, so `Could Not Save` and `couldn't_save`
 * read alike. The closing `(?:_|$)` keeps it a whole word: `cantilevered`
 * isn't `cant`. Not `did_not_*`: "did not recommend the Hilton" is an answer.
 */
const FAILURE_PREDICATE =
  /^(?:could_?not|couldnt|can_?not|cant|(?:was_|were_|is_)?unable_to|failed_to|(?:was_|were_|is_)?not_able_to|wasnt_able_to)(?:_|$)/;

/**
 * What follows a failure when the failure IS the answer: "couldn't find any
 * flights under $300" is what the person asked about, not the agent's
 * tooling. Read from the rest of the predicate, or from the object's start
 * when the predicate is the failure alone (`was_unable_to | find …`). Only
 * while the text doesn't mention memory ({@link AGENT_MEMORY}).
 */
const ANSWER_VERB = /^(?:find|locate|confirm|recommend)(?![a-z])/;

/** Memory in the agent's sense, TASK-612's {@link MEMORY}: "memory foam" and "a memory card" aren't. */
const AGENT_MEMORY = new RegExp(String.raw`\b${MEMORY}`);

/** A predicate that IS a memory operation (TASK-1136): `saved_to_memory`, `added_to_long_term_memory`. */
const MEMORY_OP_PREDICATE =
  /^(?:save|saved|store|stored|note|noted|add|added|record|recorded|write|wrote|written|keep|kept)_(?:(?:it|that|this)_)?(?:to|in|into)_(?:(?:my|its|the|long_term)_)?memor(?:y|ies)(?:_|$)/;

function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * For the two TASK-1136 predicate tests only: trimmed, lowercased, apostrophes
 * dropped (`couldn't` → `couldnt`), and each run of spaces or hyphens made one
 * `_`. Bounded like every quantifier here: a run past 32 leaves a doubled `_`
 * that no test matches, so the row is kept, and no model writes one.
 */
function normalizePredicate(predicate: string): string {
  return predicate.trim().toLowerCase().replace(/['‘’]/g, '').replace(/[\s-]{1,32}/g, '_');
}

/**
 * A failure that answers the person's question, not one of the agent's
 * tooling (see {@link ANSWER_VERB}). The object's start is read inside the
 * scanned window, like everything else here: an object padded past it has no
 * verb in view, so it stays narration.
 */
function isAnswerOutcome(rest: string, object: string, text: string): boolean {
  const verb = rest !== '' ? rest : object.slice(0, MAX_SCANNED_CHARS).trimStart().slice(0, 16).toLowerCase();
  return ANSWER_VERB.test(verb) && !AGENT_MEMORY.test(text);
}

export function isAgentContextSelfReport(fact: {
  subject: string;
  predicate: string;
  object: string;
}): boolean {
  // The agent as subject, FIRST: everything below is only its own narration.
  if (!AGENT_SUBJECTS.has(normalizeSubject(fact.subject))) return false;
  const predicate = fact.predicate.trim().toLowerCase();
  if (CONTEXT_PREDICATE.test(predicate)) return true;
  const text = `${predicate.replace(/_/g, ' ')} ${fact.object}`
    .slice(0, MAX_SCANNED_CHARS)
    .toLowerCase()
    .replace(/[‘’]/g, "'");
  const normalized = normalizePredicate(fact.predicate);
  const failure = FAILURE_PREDICATE.exec(normalized);
  if (failure !== null && !isAnswerOutcome(normalized.slice(failure[0].length), fact.object, text)) {
    return true;
  }
  if (MEMORY_OP_PREDICATE.test(normalized)) return true;
  return CONTEXT_PATTERNS.some((pattern) => pattern.test(text));
}
