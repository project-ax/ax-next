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

/** Subjects the extractor uses for the agent itself, after {@link normalizeSubject}. */
const AGENT_SUBJECTS = new Set([
  'assistant',
  'the_assistant',
  'ai_assistant',
  'ai',
  'agent',
  'the_agent',
  'bot',
]);

/**
 * Phrases that tie rules/instructions/memory to the agent's own context. Run
 * over `predicate` (underscores as spaces) + `object`, lowercased.
 */
const CONTEXT_PATTERNS: readonly RegExp[] = [
  // "no rules", "no standing instructions", "no saved memories"
  /\bno (standing |saved |stored |custom )?(rules?|instructions?|memor(y|ies)|saved facts)\b/,
  // "rules have been given by the user", "instructions from you"
  /\b(rules?|instructions?) (have been |has been |were |was )?(given |set |provided |saved )?(from|by) (you|the user|user|me)\b/,
  // "the rules I was given", "instructions it received"
  /\b(rules?|instructions?) (i|it) (was |were |have been |has been |had been )?(given|received|set|provided)\b/,
  // "the system prompt", "the bootstrap prompt"
  /\b(system|bootstrap) prompt\b/,
  // "doesn't have any memory of", "cannot remember prior sessions"
  /\b(don't|do not|doesn't|does not|cannot|can't|has no|have no|had no|without) (have |see |remember |recall |retain |keep )?(any )?(saved )?(rules?|instructions?|memor(y|ies)|prior (conversations?|sessions?|chats?)|previous (conversations?|sessions?|chats?))\b/,
  // "its instructions", "my memory"
  /\b(my|its|the assistant's|the agent's) (rules|instructions|memory|memories|system prompt)\b/,
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
    .toLowerCase()
    .replace(/[‘’]/g, "'");
  return CONTEXT_PATTERNS.some((pattern) => pattern.test(text));
}
