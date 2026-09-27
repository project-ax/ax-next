/**
 * The agent's reports about its OWN runtime context are not facts (TASK-612).
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

function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isAgentContextSelfReport(fact: {
  subject: string;
  predicate: string;
  object: string;
}): boolean {
  if (!AGENT_SUBJECTS.has(normalizeSubject(fact.subject))) return false;
  const predicate = fact.predicate.trim().toLowerCase();
  if (CONTEXT_PREDICATE.test(predicate)) return true;
  const text = `${predicate.replace(/_/g, ' ')} ${fact.object}`
    .slice(0, MAX_SCANNED_CHARS)
    .toLowerCase()
    .replace(/[‘’]/g, "'");
  return CONTEXT_PATTERNS.some((pattern) => pattern.test(text));
}
