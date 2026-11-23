/**
 * The agent's reports about its OWN runtime context are not facts (TASK-612),
 * and neither is its narration of its own memory operations and tool failures
 * (TASK-1136), of its own actions, or of what it can't do (TASK-1151).
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
 *   verb (save, fetch, access, connect, open, …), when the predicate ends
 *   by saying where in memory (`could_not_write_to_memory`), or when the
 *   text points at its own memory ("anything in memory", "my memory",
 *   "saved facts"). Most
 *   other failures are outcomes the person asked about: `could_not_find |
 *   any flights under $300`, `could_not_book | a table for 8`,
 *   `could_not_reproduce | the crash on Node 20`. Nothing else records
 *   those, so they're the assistant content the extraction prompt asks for,
 *   and they're kept. Failures of a tool whose verb isn't on the list
 *   (`could_not_get | the weather data`, `could_not_create | the event`)
 *   are kept too: a missed junk row is the cheap direction.
 * - Memory words in the object and the text end in TASK-612's
 *   {@link MEMORY}, so "memory card", "memory loss", "memory leaks" and the
 *   rest of its exclusions aren't the agent's memory. {@link MEMORY_PLACE}
 *   counts memory only as a failure predicate's LAST word, after where, and
 *   takes none of MEMORY's other phrases (`…_it_in_previous_conversations`
 *   is kept). The text checks still read the predicate, so
 *   `…_anything_in_memory_about_x` and `…_in_saved_facts` are dropped by
 *   {@link OWN_MEMORY}. In the text, "long-term memory" counts only as
 *   "in/from my/its long-term
 *   memory" or after "anything in": "encoded in long-term memory" is a
 *   topic. A predicate that IS a memory operation
 *   (`added_to_long_term_memory`) is its own check.
 *
 * A person's failure (`user | could_not_attend`) is theirs to keep, and
 * `did_not_*` is content: "did not recommend the Hilton" is an answer.
 *
 * The accepted losses: advice that reads like a save with a pronoun ("how to
 * save it to memory on an Arduino", "a mnemonic to keep them in memory"),
 * topical phrases that look like its own memory ("anything in memory dumps",
 * `could_not_fit_in_memory`), and a content outcome phrased with a tooling
 * verb (`could_not_open | the museum on Mondays`).
 * The other way round, a tool failure phrased as a search (`could_not_find |
 * the weather page`) is kept.
 *
 * ## Its narration of its own actions (TASK-1151)
 *
 * The card quoted rows like these from prod:
 *
 *     assistant | created_artifact | the Q3 revenue dashboard
 *     assistant | ran_tests | all 42 passed
 *     assistant | stated_limitation | cannot browse the internet
 *
 * The first two are the agent's play-by-play of its own tool use. The tool's
 * own state is the source of truth for what it did: the artifact store, the
 * files, the routines, the repo, the test run. A transcript copy of it is a
 * second source, stale on arrival (invariant 4). This supersedes TASK-1136's
 * call that success narration (`assistant | saved | the draft to the drive`)
 * "is a real action": Vinay's 2026-11-17 scope for TASK-1151 drops it, and the
 * drive holds the draft.
 *
 * The third is a capability statement: what the agent says it can or can't do.
 * That's true of one session's tools, not something to remember. But limits
 * can be anyone's: `listed_limitations | the Roth IRA caps income at $161k`,
 * `described_capabilities | Kubernetes HPA can scale on custom metrics` and
 * `technical_limitations | Postgres max row size is 1.6 TB` are answers. So
 * a limitation predicate counts only when the assistant is the one with the
 * limit:
 *
 * - The predicate makes it the holder: `has_limitation`, `had_limitations`,
 *   any `lacks_…` (`lacks_capability`, TASK-1198), and the no-access
 *   family (`has_no_access_to`, `lacks_access`). These need no object
 *   check: "the assistant has a limitation" is about the assistant.
 * - Anything else needs the assistant marked, whether a reporting verb leads
 *   it (`stated_`, `listed_`, `described_`, …) or nothing does
 *   (`limitations`, `known_limitations`): `its` or `own` in the predicate
 *   (`stated_its_limitations`), or a {@link SELF_LIMIT_OBJECT} at the
 *   object's start ("cannot browse the internet", "unable to send email",
 *   "no internet access"). "It" doesn't mark the assistant ("it doesn't work
 *   offline" is a product's), and neither does a plain "can" ("can export to
 *   PDF and Excel"). An object that starts with a topic, "of" or "for"
 *   included, stays.
 *
 * ## Its replies (TASK-1198)
 *
 * Walk TASK-1192 found Slack test turns ("reply with exactly: hello
 * <!channel>, testing") stored as `assistant | replied_with | hello
 * <!channel>, testing`, and shown back in the agent's instructions. That
 * predicate names the act of answering, not what was supplied: an answer
 * worth recalling the pinned prompt files under what it was (`recommended`,
 * `listed`, `stated`). So {@link REPLY_PREDICATE} drops `echoed`, and
 * `replied`/`responded` bare or with `with`. Not `replied_to_<person>`:
 * measured over the 500 LongMemEval banks' 86,819 agent rows, those hold
 * messages it drafted for someone (names, links), which it supplied. Kept
 * too, though it's narration: `replied_in_french`, `responded_to_request`.
 *
 * ## More of the turn's narration (TASK-1210)
 *
 * The same walk, replayed live (5 trials per turn), stored more of the turn
 * talking about itself:
 *
 * - Its memory misses: `assistant | stated | has no record of his favorite
 *   color`, `stated_no_standup_on_record`, "No record of X exists in prior
 *   conversations" ({@link MEMORY_MISS_PATTERNS}, `own-narration`). What
 *   memory holds has one source of truth, the store; "I don't have it" is a
 *   snapshot of one lookup, wrong the moment the person answers.
 * - Its offers and its requests to its admin: `offered_to_…`,
 *   `requested_admin_capability`, `filed_admin_request`,
 *   `requested_capability`, and `complied_with_…` ({@link OFFER_PREDICATE},
 *   {@link isAdminRequest}, `action-narration`). The capability request has
 *   its own record; an offer is a line of the reply, not a thing it did.
 * - Not about the agent at all, so {@link isTurnNarration}, not
 *   {@link classifyAgentFact}: the speaker's Slack id (`has_slack_user_id`,
 *   `slack_identity`: the channel label shows it every turn), the speaker's
 *   request for a verbatim reply (`requested_exact_reply | asked Fern to
 *   reply with exactly these lines: …`), and the memory miss filed under
 *   the person or a topic (`vinay | team_standup_time | no team standup
 *   time is on record for vinay's team`), which would otherwise sit in the
 *   same slot as the real standup time.
 *
 * Measured over the 500 LongMemEval banks (166,869 rows, 87,790 about the
 * agent): these rules drop one row `main` keeps, `complied_with_jailbreak`
 * (its own narration), in no evidence session. Wider rules were measured and
 * rejected: any `user | requested_…`/`asked_…`/`instructed_…` drops 1,530
 * rows, 17 of them in evidence sessions (`requested_reservation | Roscioli`,
 * `instructed_formatting | use markdown`), and any `offered_…` drops 19
 * offers that are content (`offered_appointment_slots`, `offered_discount`).
 * So `user | requested_fetch` and `requested_routine` stay: a missed junk
 * row is the cheap direction.
 *
 * What the agent SUPPLIED stays: recommendations, lists, values, forecasts,
 * explanations, the plans and drafts it wrote. It is the pinned prompt's
 * contract (`extraction-prompt.ts:65-75`), and it is what moved
 * single-session-assistant 45.5 -> 81.8.
 *
 * So the rule is a DENYLIST, and when unsure it keeps. Predicates are
 * model-written and mostly one-offs, so an allowlist of content verbs would
 * drop real answers phrased with a verb nobody listed (`outlined_steps`,
 * `calculated_total`). A missed junk row is the cheap direction.
 *
 * - Past tense only. A completed action is narration (`ran_tests`). A
 *   present-tense one is a standing behaviour (`runs | a daily digest at
 *   9am`), so it stays.
 * - {@link ACTION_VERBS} (`published`, `deployed`, `ran`, `fixed`, `saved`,
 *   `sent`, …) drop on the predicate's first word alone.
 * - {@link ARTIFACT_VERBS} (`created`, `wrote`, `updated`, `added`, `built`,
 *   `tested`, `merged`, …) read two ways: "created a meal plan", "built a
 *   12-week training plan", "tested the hypothesis" and "merged the two guest
 *   lists" are content it supplied, "created an artifact", "wrote a file" and
 *   "merged the PR" are narration. So they drop only when the
 *   HEAD of the verb's object is an {@link ARTIFACT_NOUNS} word. The object
 *   runs to its first {@link PREPOSITIONS} word, and its head is its last
 *   word. `created_artifact_for_q3_sales_review` and `added_slack_connector`
 *   made an artifact and a connector. `created_presentation_outline`,
 *   `wrote_commit_message` and `generated_image_prompt` are an outline, a
 *   message and a prompt it wrote: the artifact word there only modifies.
 * - {@link EVERYDAY_NOUNS} name an AX surface and an everyday thing at once.
 *   "Updated the routine" is narration, but a workout routine is a plan it
 *   wrote. So `routine` counts only bare, with nothing but determiners before
 *   it: `updated_routine` and `created_a_new_routine` drop,
 *   `created_workout_routine` stays. Charts, graphs and pages are the same:
 *   `created_chart` drops, `created_org_chart` and `wrote_cover_page` stay.
 * - Some words aren't artifact nouns at all. `added_skills | Python, SQL` is
 *   a résumé, and an install still drops on its verb (`installed_skill`). A
 *   workflow or an automation it designed is a procedure it supplied, the
 *   kind skill reflection recalls memory for
 *   (`packages/routines/src/reflection-prompt.ts`), and AX has neither as a
 *   surface. `connector` is AX's own word, so it counts with a modifier in
 *   front too: `added_slack_connector` is narration.
 * - The identity guard runs first. A predicate with an identity word (`name`,
 *   `persona`, `emoji`, `style`, `rule`, `preference`, `standing`, `default`,
 *   …) or a `created_by` pair says who the agent is, and stays even when it
 *   starts with an action verb: the card's own keep-set has
 *   `saved_standing_preference`. It shields only these new checks. TASK-612's
 *   and TASK-1136's run before it, in their old order, so `saved_to_memory` is
 *   still its own narration.
 *
 * One class the observer drops, the one-off cleanup keeps. TASK-612 reads the
 * subjects `agent` and `the_agent` as the agent too, so the observer still
 * drops their context self-reports on the way in. But `agent` is an everyday
 * word ("the agent received no instructions from the seller" is about
 * someone's real-estate agent), and the cleanup's delete is for good. So
 * those rows are `agent-context`, not `context`, and the cleanup leaves the
 * saved ones alone.
 *
 * The accepted residuals:
 *
 * - Kept, though it's narration: a verb nobody listed (`searched_web | for
 *   flights to Lisbon`, `checked | the deploy status`); `renamed_file`,
 *   because `renamed` is an identity word; a skill it created or added
 *   (`added_skill | pdf-tools`); a routine, chart, graph, page or diagram
 *   named by its kind (`set_up_weekly_routine`, `created_bar_chart`); an
 *   artifact word that isn't its object's head (`wrote_to_file`,
 *   `created_artifact_showing_q3_sales`), or that a word follows
 *   (`created_artifact_successfully`), or that ends an "and" list's first
 *   half (`created_dashboard_and_report`); and its own limits when "it", a
 *   plain "can", a passive or a "doesn't" without "have" + access opens
 *   them (`noted_limitation | it is unable to send email`,
 *   `described_capabilities | can browse, run code and make charts`, `I
 *   don't browse the web`).
 * - Dropped, though it's content: `sent | a summary of the call`,
 *   `saved | the user $120 a year on the annual plan`, `fixed_typo | their ->
 *   there`, `edited_document | the essay intro`, a bare `created_routine |
 *   6am wake, 6:15 stretch`, and a chart that isn't a picture
 *   (`created_chart_of_accounts`). So is a topic's limit written with no
 *   subject of its own, in the active voice: `listed_limitations | can't
 *   establish causation` reads as the assistant's.
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
 * Whether the extractor wrote `subject` for the agent itself: one of
 * {@link AGENT_SUBJECTS} after {@link normalizeSubject}. The one answer to
 * that question: {@link classifyAgentFact} starts from it, and so does
 * `speakerSubject` (`audience.ts`, TASK-1204 review F9), which keeps every
 * one of these as written in a team agent's member turn, so a member whose
 * display name is "AI Assistant" or "Agent Smith" never pulls the agent's
 * facts under their own key.
 */
export function isAgentSubject(subject: string): boolean {
  return AGENT_SUBJECTS.has(normalizeSubject(subject));
}

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
 * "No X is saved in memory" (TASK-1210): a lookup that came back empty, for
 * any subject. Bounded gaps, so it stays linear on untrusted text.
 */
const NONE_SAVED_IN_MEMORY = new RegExp(
  String.raw`\bno\b[^.;,]{0,80}?\b(?:is|was|are|were) (?:saved|stored|recorded|noted)\b[^.;]{0,40}?\b(?:in|to|into) (?:my |its |the )?${MEMORY}`,
);

/**
 * The assistant's memory misses (TASK-1210), over the same `text` as
 * {@link CONTEXT_PATTERNS}. "On record"/"on file" only after "no" or "don't
 * have": "the largest snowflake on record" is a topic. "No record of" only
 * with whose it is or with memory: "had no record of saying that" is kept.
 */
const MEMORY_MISS_PATTERNS: readonly RegExp[] = [
  // "has no record of his favorite color", "had no record of vinay's …"
  /\b(?:has|had|have|having|keeps?|kept|found) no records? (?:of|for|on|about) (?:your|his|her|their|the user's|[a-z0-9_]+'s) /,
  // "No record of vinay's favorite color exists in prior conversations"
  new RegExp(String.raw`\bno records? (?:of|for) [^.;]{0,200}?\b(?:in|from) (?:our |the |any )?${MEMORY}`),
  // "No team standup time is on record", `stated_no_standup_time_on_file`
  /\bno\b[^.;,]{0,80}?\b(?:(?:is|was|are|were) )?on (?:record|file)\b/,
  // "I don't have your team standup time on file"
  /\b(?:don't|do not|doesn't|does not|didn't|did not) have\b[^.;]{0,80}?\bon (?:file|record)\b/,
  NONE_SAVED_IN_MEMORY,
];

/**
 * A memory miss filed under a person or a topic (TASK-1210): "no team
 * standup time is on record for vinay's team". Narrower than the assistant's
 * "on record": "for" must follow, so "no allergies are on file at the
 * clinic" is a person's fact and stays.
 */
const NONE_ON_RECORD_FOR = /\bno\b[^.;,]{0,80}?\b(?:is|was|are|were) on (?:record|file) for\b/;

/** The speaker's Slack id (TASK-1210): `has_slack_user_id`, `slack_identity`. The channel label carries it. */
const SLACK_ID_PREDICATE = /(?:^|_)slack_(?:(?:user|member)_)?id(?:_|$)|(?:^|_)slack_identity(?:_|$)/;

/** A request's verb (TASK-1210): `requested_exact_reply`, `instructed_assistant`. */
const REQUEST_VERBS = new Set(['requested', 'asked', 'instructed', 'told']);

/** A request for a verbatim reply, in the object (TASK-1210): "asked Fern to reply with exactly these lines". */
const EXACT_REPLY_OBJECT = /\b(?:reply|respond|answer|say)(?:ing)? with exactly\b/;

/**
 * A predicate saying the assistant failed at something (TASK-1136):
 * `could_not_save_memory`, `failed_to_connect`, `was_unable_to`. Tested on
 * {@link normalizePredicate}'s output, so `Could Not Save` and `couldn't_save`
 * read alike. The closing `(?:_|$)` keeps it a whole word: `cantilevered`
 * isn't `cant`. Not `did_not_*`: "did not recommend the Hilton" is an answer.
 * A failure counts only with a {@link TOOL_VERB}, a {@link MEMORY_PLACE} or
 * {@link OWN_MEMORY}.
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
 * A failure predicate's rest (underscores as spaces) that ENDS by saying
 * where in memory: to, in, into or from (the) memory
 * (`could_not_write_to_memory`, `could_not_find_it_in_memory`). Not any
 * memory word, and not one followed by more: `could_not_reduce_memory_usage`
 * and `could_not_find_a_regression_in_memory_usage` are about RAM. Not after
 * any other modifier either: `…_encoded_in_long_term_memory` is a topic.
 * `\b` so `could_not_stay_within_memory` isn't "in memory". (TASK-612's "my
 * memory" pattern drops the usual `my`/`its` spelling first; only a hyphen
 * or a run of spaces, `in_my-memory`, reaches them here, and no row pins
 * that.)
 */
const MEMORY_PLACE = /\b(?:to|in|into|from) (?:(?:my|its|the) )?memor(?:y|ies)$/;

/** A predicate that IS a memory operation (TASK-1136): `saved_to_memory`, `added_to_long_term_memory`. */
const MEMORY_OP_PREDICATE =
  /^(?:save|saved|store|stored|note|noted|add|added|record|recorded|write|wrote|written|keep|kept)_(?:(?:it|that|this)_)?(?:to|in|into)_(?:(?:my|its|the|long_term)_)?memor(?:y|ies)(?!_(?:foam|cards?|sticks?)(?:_|$))(?:_|$)/;

// TASK-1151. Every set below holds whole words of `normalizePredicate`'s
// output, split on `_`.

// Past tense only: a completed action is narration; `runs`/`publishes` is a standing behaviour.
const ACTION_VERBS = new Set(['published', 'unpublished', 'republished', 'deployed', 'redeployed', 'ran', 'reran',
  'executed', 'committed', 'pushed', 'installed', 'uninstalled', 'reinstalled', 'fixed', 'patched', 'refactored',
  'uploaded', 'downloaded', 'deleted', 'restarted', 'configured', 'reconfigured', 'migrated', 'saved', 'sent',
  'posted', 'opened', 'attached', 'exported', 'imported', 'cloned', 'forked', 'moved', 'invoked', 'triggered',
  'complied']);
/**
 * TASK-1198: the act of replying. `echoed` drops on its own; `replied` and
 * `responded` only bare or followed by `with` (`replied_with | hello
 * <!channel>, testing`). `replied_to_sarah | told her the call is Tuesday via
 * https://…` is a message it wrote for someone, which it supplied, so it stays.
 */
const REPLY_PREDICATE = /^(?:echoed(?:_|$)|(?:replied|responded)(?:_with(?:_|$)|$))/;
/**
 * TASK-1210: an offer to do something (`offered_to_set_up_reminder`), or of
 * help. Not any `offered_…`: `offered_appointment_slots | 9:00-9:30, …` and
 * `offered_discount` are what it supplied (19 such rows in LongMemEval).
 */
const OFFER_PREDICATE = /^offered_to(?:_|$)|^offered_(?:(?:further|more|additional|extra)_)?(?:help|assistance|support)$/;
/** TASK-1210: the verbs of a request it made, to its admin or for a capability. */
const ADMIN_REQUEST_VERBS = new Set(['requested', 'filed', 'submitted', 'raised', 'escalated', 'asked', 'sent']);
const ADMIN_WORDS = new Set(['admin', 'admins', 'administrator', 'administrators']);
// Narration only when the head of the verb's object is an artifact noun: "created a meal plan", "wrote
// a haiku", "built a 12-week training plan" and "tested the hypothesis" are content. `setup` stands for
// the two words `set_up`.
const ARTIFACT_VERBS = new Set(['created', 'generated', 'made', 'wrote', 'rewrote', 'updated', 'modified', 'changed',
  'added', 'removed', 'edited', 'shared', 'scheduled', 'rendered', 'setup', 'built', 'rebuilt', 'implemented',
  'debugged', 'tested', 'retested', 'merged']);
// As the head of the verb's object: `created_artifact_for_q3_sales_review` is narration,
// `created_presentation_outline` is an outline it wrote. No `skill`, `workflow` or `automation`:
// `added_skills | Python, SQL` is a résumé, and a workflow is a procedure it wrote.
const ARTIFACT_NOUNS = new Set(['artifact', 'artifacts', 'file', 'files', 'folder', 'folders', 'directory',
  'directories', 'document', 'documents', 'doc', 'docs', 'webpage', 'webpages', 'site', 'sites',
  'website', 'websites', 'app', 'apps', 'dashboard', 'dashboards', 'visual', 'visuals', 'visualization',
  'visualizations', 'spreadsheet', 'spreadsheets', 'deck', 'decks',
  'presentation', 'presentations', 'image', 'images', 'repo', 'repos', 'repository',
  'repositories', 'branch', 'branches', 'commit', 'commits', 'pr', 'prs', 'connector', 'connectors', 'component',
  'components', 'endpoint', 'endpoints', 'pdf', 'pdfs', 'csv', 'csvs']);
// Artifact nouns that are everyday words too: as the head only bare, with nothing but determiners
// before them. `updated_routine` is narration; `created_workout_routine` is a plan it wrote. So
// with charts, graphs and pages: `created_chart` is narration; `created_org_chart`,
// `created_dependency_graph` and `wrote_cover_page` are what it wrote.
const EVERYDAY_NOUNS = new Set(['routine', 'routines', 'chart', 'charts', 'graph', 'graphs', 'page', 'pages',
  'diagram', 'diagrams']);
const DETERMINERS = new Set(['a', 'an', 'the', 'new', 'my', 'your', 'its']);
// The verb's object ends at its first preposition, so its head is the word before one.
const PREPOSITIONS = new Set(['for', 'of', 'to', 'in', 'on', 'about', 'with', 'from', 'at', 'into', 'via', 'by']);
// Checked first: the card's keep-set includes `saved_standing_preference`.
const IDENTITY_WORDS = new Set(['name', 'names', 'named', 'renamed', 'nickname', 'nicknamed', 'identity', 'persona',
  'personality', 'introduced', 'introduction', 'signature', 'emoji', 'avatar', 'style', 'tone', 'voice', 'pronoun',
  'pronouns', 'rule', 'rules', 'preference', 'preferences', 'standing', 'default', 'defaults']);
/** Who made it is who it is: `was_created_by_user`. */
const CREATED_BY = /(?:^|_)(?:created|made|built|designed)_by(?:_|$)/;
/**
 * What it says it can or can't do: `stated_limitation`, `has_limitation`,
 * `described_capabilities`, `stated_its_limitations`. Ends at the
 * limitation word, so `explained_limitations_of_the_study` is a topic.
 * Group 1 is a holder (`has_`, `had_`, `have_`): the assistant has the limit.
 * Anything else can be anyone's limits, with a reporting verb
 * (`listed_limitations`) or none (`limitations`, `known_limitations`).
 */
const LIMITATION_PREDICATE =
  /^(?:(?:stated|noted|acknowledged|explained|described|mentioned|clarified|disclosed|admitted|flagged|reported|listed|outlined|summarized)_|(has|had|have)_)?(?:(?:its|own|a|the|some|several|current|known|technical)_){0,2}(?:limitations?|capabilit(?:y|ies)|inabilit(?:y|ies))$/;
/**
 * What it says it can't reach: `has_no_access_to`, `doesnt_have_access`,
 * `lacks_access`. Like `has_limitation`, it makes the assistant the holder,
 * and it has no reporting form, so it needs no object check.
 */
const NO_ACCESS_PREDICATE =
  /^(?:has_no|have_no|had_no|lacks?|lacked|does_not_have|doesnt_have|did_not_have|didnt_have)_(?:(?:direct|real_?time|live|internet|web|external)_)?access(?:_|$)/;
/**
 * What it says it lacks, whatever the noun (TASK-1198): `lacks_capability`,
 * `lacks_slack_messaging_capability`, `lacked_permission`. With the assistant
 * as the subject, "lacks" is always its own limit, so like
 * {@link NO_ACCESS_PREDICATE} it needs no object check. Measured: walk
 * TASK-1192 stored `lacks_capability`, and five replays of the same turn
 * all wrote `lacks_slack_messaging_capability`, which
 * {@link LIMITATION_PREDICATE}'s modifier list never reaches. Not the noun
 * `lack_of | evidence for X`: that's a topic's.
 */
const LACKS_PREDICATE = /^(?:lacks?|lacked)(?!_of(?:_|$))(?:_|$)/;
/**
 * An object that starts with the assistant's own limit, for a limitation
 * predicate that isn't a holder: "cannot browse the internet", "unable to
 * send email", "I don't have access to your calendar", "no internet access".
 * Read on the windowed, trimmed, lowercased object, and anchored at its
 * start: "Kubernetes HPA can't scale to zero" is a topic. With no subject of
 * its own, a negative modal reads as the assistant's: that's the card's
 * `stated_limitation | cannot browse the internet`. A subject counts only
 * when it's "I" or "the assistant": "it doesn't work offline" is a
 * product's. A plain "can" doesn't count at all: "can export to PDF and
 * Excel" could be any product's too. "no", "has no" and "lacks" count only
 * before access, the internet, the web, browsing, real-time data or the
 * ability to do something ("no control group" is a study's limit), and
 * "only" and "without" don't count ("only covers in-network providers").
 * Passive voice never counts, with or without a subject: the assistant's
 * own limits are active ("cannot browse"), and "cannot be combined with
 * other offers" is an offer's. "does not"/"don't" counts only as "doesn't
 * have" + the same access words as "has no" ("doesn't have access"): "does
 * not cover dental" and "does not have a free tier" are a plan's, and "I
 * don't browse the web" is kept too.
 */
const SELF_LIMIT_OBJECT =
  /^(?:(?:i|the assistant) )?(?:(?:can(?:not|'?t| not)|could(?:n'?t| not)|(?:is |am )?(?:unable|not able) to)(?!\s+be(?![a-z]))|(?:(?:does|do)(?:n'?t| not) have|(?:has|have) no|no|lacks?) (?:direct |real[- ]?time |live |internet |web |external )?(?:access|internet|web|browsing|real[- ]?time|(?:the )?ability))(?![a-z])/;

/**
 * What the text patterns read: the predicate (underscores as spaces) and the
 * object, cut to the scanned window, lowercased, curly apostrophes made
 * straight.
 */
function scannedText(predicate: string, object: string): string {
  return `${predicate.trim().toLowerCase().replace(/_/g, ' ')} ${object}`
    .slice(0, MAX_SCANNED_CHARS)
    .toLowerCase()
    .replace(/[‘’]/g, "'");
}

function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * For the TASK-1136 and TASK-1151 checks only (a predicate, or a bare
 * failure's object head): cut to the scanned window first,
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
 * failed is a {@link TOOL_VERB}, the rest of the predicate ends in a
 * {@link MEMORY_PLACE}, or
 * the text points at its own memory. A bare failure's verb is read from the
 * object's start, normalized like a predicate, inside the scanned window.
 */
function isOwnFailure(rest: string, object: string, text: string): boolean {
  if (rest !== '' && MEMORY_PLACE.test(rest.replace(/_/g, ' '))) return true;
  // `normalizePredicate` cuts to the window BEFORE it trims, so an object
  // padded past the window has no verb in view.
  const verb = rest !== '' ? rest : normalizePredicate(object);
  return TOOL_VERB.test(verb) || OWN_MEMORY.test(text);
}

/**
 * TASK-1136: the assistant narrating its own memory operations and tool
 * failures; TASK-1210: and its memory misses.
 */
function isOwnNarration(normalized: string, object: string, text: string): boolean {
  const failure = FAILURE_PREDICATE.exec(normalized);
  if (failure !== null && isOwnFailure(normalized.slice(failure[0].length), object, text)) return true;
  if (MEMORY_OP_PREDICATE.test(normalized)) return true;
  if (NARRATION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return MEMORY_MISS_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * TASK-1210: a request it made to its admin (`requested_admin_capability`,
 * `filed_admin_request`), or for a capability (`requested_capability`,
 * `filed_request`). The admin word only after a request verb:
 * `listed_admin_steps` is an answer.
 */
function isAdminRequest(words: readonly string[], normalized: string): boolean {
  const verb = words[0] ?? '';
  if (ADMIN_REQUEST_VERBS.has(verb) && words.some((word) => ADMIN_WORDS.has(word))) return true;
  if (/^requested_capabilit(?:y|ies)$/.test(normalized)) return true;
  return (verb === 'filed' || verb === 'submitted') && words.includes('request');
}

/** What a fact about the agent is. The cleanup script prints these names. */
export type AgentFactClass =
  | 'context' //          TASK-612: its own rules/instructions/memory   (dropped)
  | 'agent-context' //    TASK-612, filed under `agent`/`the_agent`     (dropped; the cleanup keeps it)
  | 'own-narration' //    TASK-1136: its memory operations, tool failures (dropped)
  //                      TASK-1210: and its memory misses
  | 'action-narration' // TASK-1151: what it did with its tools         (dropped)
  //                      TASK-1210: and its offers, its admin requests
  | 'capability' //       TASK-1151: what it says it can't do           (dropped)
  | 'identity' //         kept: name, persona, standing rules
  | 'other'; //           kept: everything else, incl. what it supplied

/**
 * TASK-1151: the assistant's statement about itself, once the older checks
 * have kept it. Reads the windowed, normalized predicate, and the object only
 * inside the window.
 */
function classifyOwnStatement(normalized: string, object: string): AgentFactClass {
  const words = normalized.split('_').filter((word) => word !== '');
  // Who it is, first: `saved_standing_preference` starts with an action verb.
  if (words.some((word) => IDENTITY_WORDS.has(word)) || CREATED_BY.test(normalized)) return 'identity';
  // A holder (`has_limitation`) is the assistant. Anything else, a reporting
  // verb or none, needs it marked: `its`/`own` in the predicate, or a
  // self-limit at the object's start.
  const limitation = LIMITATION_PREDICATE.exec(normalized);
  if (
    limitation !== null &&
    (limitation[1] !== undefined ||
      words.includes('its') ||
      words.includes('own') ||
      SELF_LIMIT_OBJECT.test(object.slice(0, MAX_SCANNED_CHARS).trimStart().toLowerCase().replace(/[‘’]/g, "'")))
  ) {
    return 'capability';
  }
  if (NO_ACCESS_PREDICATE.test(normalized) || LACKS_PREDICATE.test(normalized)) return 'capability';
  const setUp = words[0] === 'set' && words[1] === 'up';
  const verb = setUp ? 'setup' : (words[0] ?? '');
  if (ACTION_VERBS.has(verb) || REPLY_PREDICATE.test(normalized)) return 'action-narration';
  if (OFFER_PREDICATE.test(normalized) || isAdminRequest(words, normalized)) return 'action-narration';
  if (!ARTIFACT_VERBS.has(verb)) return 'other';
  // The verb's object runs to its first preposition, and its last word, the
  // head, is what was made: `created_artifact_for_q3_sales_review` made an
  // artifact, `created_presentation_outline` an outline.
  const rest = words.slice(setUp ? 2 : 1);
  const end = rest.findIndex((word) => PREPOSITIONS.has(word));
  const phrase = end === -1 ? rest : rest.slice(0, end);
  const head = phrase[phrase.length - 1];
  if (head === undefined) return 'other';
  // An everyday noun counts only bare: `created_a_new_routine`, not `created_workout_routine`.
  const artifact =
    ARTIFACT_NOUNS.has(head) ||
    (EVERYDAY_NOUNS.has(head) && phrase.slice(0, -1).every((word) => DETERMINERS.has(word)));
  return artifact ? 'action-narration' : 'other';
}

/**
 * What a fact about the agent is, or `null` when its subject isn't the agent
 * (see the header). The observer drops `context`, `agent-context`,
 * `own-narration`, `action-narration` and `capability`, and keeps `identity`
 * and `other` ({@link isAgentContextSelfReport}). `agent` and `the_agent`
 * only ever get `agent-context` or `null`: TASK-1136's and TASK-1151's checks
 * take the assistant alone.
 *
 * The one-off cleanup, `packages/memory/scripts/clean-assistant-narration.mjs`,
 * deletes saved rows with this very function: it pipes this file, as text,
 * ahead of its own into `node --input-type=module-typescript`. It deletes
 * every class the observer drops except `agent-context`: `agent` is an
 * everyday noun, and that delete is for good. So this file
 * stays import-free and uses only erasable TypeScript (annotations, `as`,
 * `readonly`; no `enum`, `namespace` or parameter properties), and its
 * top-level names share that program's scope.
 */
export function classifyAgentFact(fact: {
  subject: string;
  predicate: string;
  object: string;
}): AgentFactClass | null {
  // The agent as subject, FIRST: everything below is only its own narration.
  if (!isAgentSubject(fact.subject)) return null;
  const subject = normalizeSubject(fact.subject);
  // TASK-612 reads `agent` as the agent too, but under a class of its own.
  const context = ASSISTANT_SUBJECTS.has(subject) ? 'context' : 'agent-context';
  const predicate = fact.predicate.trim().toLowerCase();
  if (CONTEXT_PREDICATE.test(predicate)) return context;
  const text = scannedText(fact.predicate, fact.object);
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(text))) return context;
  // `agent` is an everyday noun: the checks below take the assistant alone.
  if (!ASSISTANT_SUBJECTS.has(subject)) return null;
  const normalized = normalizePredicate(fact.predicate);
  // Before the action verbs: `saved_to_memory` starts with one.
  if (isOwnNarration(normalized, fact.object, text)) return 'own-narration';
  return classifyOwnStatement(normalized, fact.object);
}

/**
 * Whether the observer drops the fact: its class is one of the five dropped
 * ones. The name predates TASK-1136 and TASK-1151; `toStatements` calls it by
 * that name.
 */
export function isAgentContextSelfReport(fact: {
  subject: string;
  predicate: string;
  object: string;
}): boolean {
  const kind = classifyAgentFact(fact);
  return (
    kind === 'context' ||
    kind === 'agent-context' ||
    kind === 'own-narration' ||
    kind === 'action-narration' ||
    kind === 'capability'
  );
}

/**
 * TASK-1210: the turn's narration filed under someone other than the agent:
 * the speaker's Slack id, the speaker's request for a verbatim reply, and a
 * memory miss filed under a person or a topic (see the header). The observer
 * drops it with the self-reports. It isn't {@link classifyAgentFact}, so the
 * one-off cleanup, which deletes only facts about the assistant, never reads
 * it. Always false for the agent's own facts: those are classifyAgentFact's.
 */
export function isTurnNarration(fact: { subject: string; predicate: string; object: string }): boolean {
  if (isAgentSubject(fact.subject)) return false;
  const normalized = normalizePredicate(fact.predicate);
  if (SLACK_ID_PREDICATE.test(normalized)) return true;
  const words = normalized.split('_').filter((word) => word !== '');
  if (REQUEST_VERBS.has(words[0] ?? '')) {
    if (words.some((word) => word === 'exact' || word === 'exactly' || word === 'verbatim')) return true;
    if (EXACT_REPLY_OBJECT.test(fact.object.slice(0, MAX_SCANNED_CHARS).toLowerCase())) return true;
  }
  const text = scannedText(fact.predicate, fact.object);
  return NONE_SAVED_IN_MEMORY.test(text) || NONE_ON_RECORD_FOR.test(text);
}
