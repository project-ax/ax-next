import { describe, expect, it } from 'vitest';

import { classifyAgentFact, isAgentContextSelfReport, isAgentSubject } from '../self-report.js';

/**
 * TASK-612. The fact below is the one walk TASK-607 measured the observer
 * storing, verbatim: a Rule saved mid-session had not reached the running
 * sandbox, the agent truthfully said it saw no rules, and the extractor
 * turned that snapshot of its own system prompt into a durable memory.
 */
const WALK_FACT = {
  subject: 'assistant',
  predicate: 'stated',
  object:
    'No rules have been given by the user; the only instructions came from the system bootstrap prompt (figuring out identity, writing identity files)',
};

describe('isAgentContextSelfReport', () => {
  it('flags the exact fact walk TASK-607 measured being stored', () => {
    expect(isAgentContextSelfReport(WALK_FACT)).toBe(true);
  });

  it.each([
    ['stated', 'No rules from you yet'],
    ['stated', 'no standing instructions from the user'],
    ['said', "doesn't have any memory of previous conversations"],
    ['stated', 'cannot remember prior sessions'],
    ['stated', 'has no saved memories about the user'],
    ['described', 'its instructions come only from the system prompt'],
    ['has_no_rules', 'from the user'],
    ['has_rules', 'none'],
    ['stated', 'The rules I was given by the user are: none'],
    ['stated', 'no rules have been set by the user'],
    // First-person negations: the likeliest way a running agent says it.
    ['stated', "I haven't been given any rules"],
    ['stated', 'I have not been given any rules'],
    ['stated', "I wasn't given any rules"],
    ['stated', 'I was not given any rules'],
    ['stated', "hasn't received any instructions"],
    ['stated', 'I never received any instructions'],
    ['stated', 'has not been told any rules'],
    ['stated', 'I have no instructions to follow'],
    ['stated', 'I have no rules to go by'],
    ['stated', 'no rules to speak of'],
    ['stated', 'I have no rules in place'],
    ['stated', 'there are no rules around here for me'],
    ['stated', 'I was not provided any rules'],
    ['stated', 'I have not been provided any instructions'],
    // "for/of/on/about" + the agent's OWN scope is still a self-report; only a
    // topic after it ("rules of chess") is content.
    ['stated', 'I have no rules for this conversation'],
    ['stated', 'no rules for you yet'],
    ['stated', 'I have no instructions for this task'],
    ['stated', 'I have not been given any instructions for our chat'],
    ["stated", "I don't have any rules about how to respond"],
    ['stated', 'there are no instructions on what to do'],
    ['stated', 'the system prompt is all I was given'],
    // A self-tied mention of its prompt is still about its own context.
    ['stated', 'the only instructions came from the system bootstrap prompt'],
    ['stated', 'follows only what is in its system prompt'],
  ])('flags the assistant self-report %s | %s', (predicate, object) => {
    expect(isAgentContextSelfReport({ subject: 'assistant', predicate, object })).toBe(true);
  });

  it('stays fast on a huge, repetitive, untrusted object', () => {
    // The object is model output with no length cap upstream. An unbounded
    // `(system |bootstrap )+` here measured O(n^2): ~2.6 s at 40k repeats.
    const start = performance.now();
    for (const word of ['system ', 'bootstrap ', 'no ', 'never been ']) {
      isAgentContextSelfReport({
        subject: 'assistant',
        predicate: 'stated',
        object: `${word.repeat(40_000)}x`,
      });
    }
    expect(performance.now() - start).toBeLessThan(250);
  });

  it.each(['ai', 'bot', 'sourdough'])('does not treat the topic subject %s as the agent', (subject) => {
    expect(isAgentContextSelfReport({ ...WALK_FACT, subject })).toBe(false);
  });

  it.each(['Assistant', 'the_assistant', 'AI assistant', 'agent'])(
    'treats %s as the agent speaking',
    (subject) => {
      expect(isAgentContextSelfReport({ ...WALK_FACT, subject })).toBe(true);
    },
  );

  it.each([
    // An assistant fact that merely MENTIONS rules is real content.
    ['assistant', 'listed', 'the rules of chess: no castling through check'],
    ['assistant', 'recommended_sealant', 'Mod Podge, to seal the newspaper flower vase'],
    ['assistant', 'explained', 'house rules for the rental: no parties after 10pm'],
    ['assistant', 'recommended', 'a memory foam pillow'],
    // "system prompt" as a TOPIC the person asked about is real content.
    ['assistant', 'explained', 'how to write a good system prompt for GPT models'],
    ['assistant', 'described', 'a system prompt injection attack technique'],
    ['assistant', 'stated', 'a clear system prompt is all you need for a good agent'],
    // "no <topic>" where the noun is only a word, not the agent's context.
    ['assistant', 'recommended', 'no memory foam is needed'],
    ['assistant', 'stated', 'there are no rules in baseball about bat length'],
    ['assistant', 'stated', 'there are no rules against it, so castle freely'],
    ['assistant', 'recommended', 'never given any rules of thumb for sourdough — weigh the flour'],
    // Not the agent speaking: a person's own statement is theirs to keep.
    ['user', 'stated', 'no rules have been given by the user'],
    ['user', 'prefers', 'no memory foam pillows'],
    ['sam', 'has_no_rules', 'for weekend meetings'],
  ])('keeps %s | %s | %s', (subject, predicate, object) => {
    expect(isAgentContextSelfReport({ subject, predicate, object })).toBe(false);
  });
});

describe('the agent narrating its own memory operations and tool failures (TASK-1136)', () => {
  // Walk TASK-1134 stored `assistant | could_not_save_memory`; its object wasn't recorded.
  it.each([
    '',
    'the standup time',
    'Team standup moved to 10:15 on Tuesdays',
    "Notes about a person aren't saved in a shared conversation.",
  ])('flags the walk row whatever its object (%j)', (object) => {
    expect(isAgentContextSelfReport({ subject: 'assistant', predicate: 'could_not_save_memory', object })).toBe(true);
  });

  it.each([
    ['the_assistant', 'could_not_save_memory', 'x'],
    ['AI assistant', 'failed_to_save', 'the note'],
    ['Assistant', 'Could Not Save', 'the note'],
    ['assistant', "couldn't_save", 'the note'],
    ['assistant', 'couldnt_save_note', 'about Vinay'],
    ['assistant', 'cannot_save_notes', 'about a person in a shared conversation'],
    ['assistant', 'could_not_fetch', 'the weather page'],
    ['assistant', 'failed_to_connect', 'Gmail'],
    ['assistant', 'unable_to_access', 'the shared drive'],
    ['assistant', 'was_unable_to', 'save the note'],
    ['assistant', 'was_not_able_to_open', 'the attachment'],
    ['assistant', 'could_not', 'connect to the calendar'],
    ['assistant', 'was_unable_to', 'log in to the bank portal'],
    ['assistant', "couldn_t_save_memory", 'x'],
    ['assistant', "wasn_t_able_to_save", 'the note'],
    ['assistant', "weren_t_able_to_fetch", 'the page'],
    ['assistant', 'isn_t_able_to_access', 'the drive'],
    ['assistant', 'could_not_find_it_in_memory', 'the standup time'],
    ['assistant', 'could_not_find_it_into_memory', 'x'],
    ['assistant', 'could_not_get_it_from_memory', 'the standup time'],
    ['assistant', 'could_not_find_it_in_the_memory', 'the standup time'],
    ['assistant', 'could_not_find', 'the standup time in my long-term memory'],
    ['assistant', "can_t_save", 'the note'],
    ['assistant', 'could_not_write_to_memory', 'the standup time'],
    ['assistant', 'could_not_keep_it_in_memory', 'the standup time'],
    ['assistant', 'could_not_recall', 'the standup time'],
    ['assistant', 'could_not_find', 'anything in long-term memory about Vinay'],
    ['assistant', 'saved_to_memory', 'team standup time is 10:15 on Tuesdays'],
    ['assistant', 'stored_in_memory', 'the standup time'],
    ['assistant', 'added_to_long_term_memory', 'the standup time'],
    ['assistant', 'stated', "I couldn't save that to memory"],
    ['assistant', 'stated', 'Saved it to memory: standup is 10:15 on Tuesdays'],
    ['assistant', 'confirmed', 'it noted this in memory'],
    ['assistant', 'used', 'memory_note to save the standup time'],
    ['assistant', 'called', 'the memory note tool, which refused the note'],
    // Failing to find something is narration again once it's memory it
    // looked in: memory's store is the source of truth for what it holds.
    ['assistant', 'could_not_find', 'anything in memory about the standup time'],
    ['assistant', 'was_unable_to', 'find any saved facts about Vinay'],
  ])('flags %s | %s | %s', (subject, predicate, object) => {
    expect(isAgentContextSelfReport({ subject, predicate, object })).toBe(true);
  });

  it.each([
    ['user', 'could_not_attend', 'the offsite'],
    ['sam', 'failed_to_submit', 'the expense report'],
    ['vinay', 'could_not_save_memory', 'x'],
    ['assistant', 'explained', 'how to save data to memory on an Arduino with EEPROM.write'],
    ['assistant', 'explained', 'data saved to memory is lost on reboot unless written to flash'],
    ['assistant', 'recommended', 'upgrading the laptop to 32GB of memory'],
    ['assistant', 'recommended', 'a memory card reader for the camera'],
    ['assistant', 'did_not_recommend', 'the Hilton, because of the noise complaints'],
    ['assistant', 'explained', "the user couldn't save the file because the drive was full"],
    ['assistant', 'listed', 'steps to save notes in Apple Notes'],
    ['assistant', 'cantilevered', 'the shelf design'],
    // The save verb has to govern the pronoun: this "it" is what was loaded.
    ['assistant', 'explained', 'the program saved the file, then loaded it into memory'],
    // Failing to find, locate, confirm or recommend something is the answer
    // to what the person asked, not the agent's tooling. The extraction
    // prompt asks for exactly this kind of assistant content.
    ['assistant', 'could_not_find', 'any flights under $300 on the 14th'],
    ['assistant', 'unable_to_locate', 'a pharmacy open past 10pm near Fenway'],
    ['assistant', 'could_not_confirm', 'whether the museum is open on Mondays'],
    ['assistant', 'cannot_recommend', 'the Hilton, because of the noise complaints'],
    ['assistant', 'was_unable_to', 'find a direct flight from Boston to Lisbon in March'],
    ['assistant', 'could_not_find', 'a memory card reader in stock at the Back Bay store'],
    // Review of TASK-1136: any other failure is an outcome too. Nothing else
    // records it, so it's the assistant content the extraction prompt keeps.
    ['assistant', 'could_not_book', 'a table for 8 on Friday at Giulia'],
    ['assistant', 'could_not_suggest', 'a vegan option on that menu'],
    ['assistant', 'could_not_verify', 'the contractor\'s license number'],
    ['assistant', 'unable_to_identify', 'the plant from the photo'],
    ['assistant', 'could_not_reproduce', 'the crash on Node 20'],
    // Memory in the RAM sense isn't its own memory.
    ['assistant', 'could_not_find', 'the cause of the memory spike in the worker pod'],
    ['assistant', 'could_not_confirm', "the pod's memory limit"],
    ['assistant', 'could_not_find', 'a more memory-efficient library'],
    ['assistant', 'explained', 'how to save them to the memory card before formatting the camera'],
    // `agent` is an everyday noun: a person's agent, whose failures are the
    // person's facts. TASK-1136's checks take only the assistant.
    ['agent', 'could_not_save_memory', 'x'],
    ['the_agent', 'failed_to_file', 'the closing paperwork by Friday'],
    ['agent', 'could_not_get', 'the seller to accept 450k'],
    ['the agent', 'was unable to', 'get an extension on the closing date'],
    ['agent', 'cannot_attend', 'the inspection on Tuesday'],
    ['the_agent', 'failed_to_connect', 'the buyer with a lender'],
    // Review round 2: memory in the health or study sense isn't its own.
    ['assistant', 'could_not_find', 'studies linking statins to long-term memory loss'],
    ['assistant', 'could_not_find', 'studies showing that ginkgo biloba improves long-term memory in adults'],
    ['assistant', 'could_not_determine', 'whether her long-term memory loss is reversible'],
    ['assistant', 'could_not_confirm', 'whether the medication causes long-term memory problems'],
    ['assistant', 'could_not_find', 'anything stored in memory cards older than 2015 at that shop'],
    ['assistant', 'suggested', 'a peg-word mnemonic for the 12 cranial nerves to keep them in long-term memory'],
    // Review rounds 3-4: `MEMORY_PLACE` counts memory in a failure predicate
    // only when the predicate ENDS with where (to/in/into/from memory);
    // otherwise it's RAM, or a topic.
    ['assistant', 'could_not_reduce_memory_usage', 'of the worker pod below 512MB'],
    ['assistant', 'could_not_reproduce_the_memory_spike', 'on Node 20'],
    ['assistant', 'failed_to_allocate_memory', 'for the 70B model on one GPU'],
    ['assistant', 'could_not_find_research_on_memory_consolidation', 'during sleep'],
    ['assistant', 'could_not_find_a_regression_in_memory_usage', 'between v2 and v3'],
    ['assistant', 'could_not_find_the_bug_in_the_memory_allocator', 'in the C extension'],
    ['assistant', 'could_not_find_studies_on_facts_encoded_in_long_term_memory', 'x'],
    ['assistant', 'could_not_stay_within_memory', 'on the 8GB instance'],
    ['assistant', 'could_not_find', 'research on how emotions are encoded in long-term memory'],
    ['assistant', 'could_not_explain', 'why some memories fade from long-term memory'],
    // Failures whose verb has an outcome sense are answers too.
    ['assistant', 'could_not_keep', 'the 5-day Italy trip under $2,000 with flights; cheapest found was $2,340'],
    ['assistant', 'was_unable_to', 'keep the weekly grocery plan under $80'],
    ['assistant', 'could_not_reach', 'a definitive conclusion on whether the non-compete is enforceable'],
    ['assistant', 'could_not_write', 'a single regex that validates every RFC 5322 email address'],
    // A failure or memory word mid-predicate is a topic: both predicate
    // tests are anchored at the start.
    ['assistant', 'explained_why_the_printer_cannot_connect', 'to 5 GHz Wi-Fi; it only supports 2.4 GHz'],
    ['assistant', 'explained_how_to_save_to_memory', 'on an Arduino, with EEPROM.write(address, value)'],
  ])('keeps %s | %s | %s', (subject, predicate, object) => {
    expect(isAgentContextSelfReport({ subject, predicate, object })).toBe(false);
  });

  it("reads a bare failure's verb inside the scanned window, and nothing past it", () => {
    const padding = ' '.repeat(2_000);
    for (const object of [`${padding}save the note`, `${padding}find anything in memory about the standup time`]) {
      expect(isAgentContextSelfReport({ subject: 'assistant', predicate: 'was_unable_to', object })).toBe(false);
    }
    expect(
      isAgentContextSelfReport({ subject: 'assistant', predicate: 'was_unable_to', object: '  save the note' }),
    ).toBe(true);
  });

  it('reads a failure predicate inside the scanned window, and nothing past it', () => {
    // Cut before it's normalized: the verb after 1,000 spaces isn't read.
    expect(
      isAgentContextSelfReport({ subject: 'assistant', predicate: `could not${' '.repeat(1_000)}save`, object: 'the note' }),
    ).toBe(false);
    expect(
      isAgentContextSelfReport({ subject: 'assistant', predicate: `could not${' '.repeat(10)}save`, object: 'the note' }),
    ).toBe(true);
  });

  // A guard for later edits, not for this change: it passes on main too. An
  // unbounded pattern added later over the uncut predicate is what it catches.
  it('stays fast on a huge, repetitive, untrusted predicate and object', () => {
    const start = performance.now();
    for (const word of ['save that to ', 'memory note ', 'could not ', 'saved it into the ', 'noted ']) {
      isAgentContextSelfReport({
        subject: 'assistant',
        predicate: `${word.replace(/ /g, '_').repeat(20_000)}x`,
        object: `${word.repeat(40_000)}x`,
      });
    }
    // A bare failure predicate reads its verb from the object's start.
    isAgentContextSelfReport({
      subject: 'assistant',
      predicate: 'was_unable_to',
      object: `${' '.repeat(40_000)}find ${'in memory '.repeat(40_000)}x`,
    });
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe("the assistant's narration of its own actions, and what it says it can't do (TASK-1151)", () => {
  it.each([
    ['assistant', 'created_artifact', 'the Q3 revenue dashboard'], // card: x5 on prod
    ['assistant', 'published_artifact', 'the Q3 revenue dashboard'], // card: x5
    ['assistant', 'ran_tests', 'all 42 passed'], // card
    ['assistant', 'fixed_bug', 'in the date parser'], // card
    // `built` and `implemented` need an artifact noun: `built | a 12-week training plan` is content.
    ['assistant', 'built_dashboard', 'for weekly sign-ups'],
    ['assistant', 'implemented_component', 'the date picker on the settings page'],
    ['assistant', 'deployed', 'the staging build'],
    ['assistant', 'committed_changes', 'to the main branch'],
    ['assistant', 'opened_pr', '#43 to fix the login redirect'],
    // `merged`, `tested` and `debugged` need an artifact noun too:
    // `merged_lists | the two guest lists` is content.
    ['assistant', 'merged_pr', '#42'],
    ['assistant', 'installed_package', 'pandas 2.2'],
    ['assistant', 'executed_command', 'npm ci'],
    ['assistant', 'tested_endpoint', '/api/health returned 200'],
    ['assistant', 'debugged_app', 'the login crash on Android'],
    ['assistant', 'configured_connector', 'Gmail'],
    // `skill` isn't an artifact noun (`added_skills | Python, SQL` is a résumé), but an install is narration.
    ['assistant', 'installed_skill', 'pdf-tools'],
    ['assistant', 'uploaded_file', 'report.pdf'],
    ['assistant', 'deleted_file', 'old.csv'],
    ['assistant', 'sent_email', 'to Bob about the launch'],
    // TASK-1136 kept success narration as a real action; Vinay's 2026-11-17
    // scope (TASK-1151) drops it: the drive holds the draft.
    ['assistant', 'saved', 'the Q3 report draft to the shared drive'],
    // Still pins TASK-1136's memory-card exclusion: its class is
    // action-narration, not own-narration.
    ['assistant', 'saved_to_memory_card', 'the photos from the shoot'],
    ['assistant', 'created_file', 'notes.md'],
    ['assistant', 'generated_image', 'a watercolor fox'],
    ['assistant', 'wrote_file', 'src/index.ts'],
    ['assistant', 'updated_routine', 'the daily digest now runs at 9am'],
    ['assistant', 'added_connector', 'Slack'],
    // `connector` names AX's own connectors, so it counts anywhere after the verb.
    ['assistant', 'added_slack_connector', 'for the team workspace'],
    ['assistant', 'scheduled_routine', 'a weekly report on Mondays'],
    ['assistant', 'set_up_routine', 'a weekly digest'],
    // `routine` is also an everyday word, so it counts only bare, with
    // nothing but determiners before it.
    ['assistant', 'created_a_new_routine', 'a daily digest at 9am'],
    // So do `chart`, `graph`, `page` and `diagram`.
    ['assistant', 'created_chart', 'Q3 revenue by region'],
    ['assistant', 'generated_a_graph', 'weekly sign-ups'],
    ['assistant', 'updated_page', 'the pricing page'],
    ['assistant', 'created_diagram', 'the Q3 funnel'],
    ['assistant', 'edited_document', 'the onboarding doc'],
    // The verb's object ends at its first preposition; its head is the word before.
    ['assistant', 'created_artifact_for_q3_sales_review', 'x'],
    ['assistant', 'generated_image_of_the_q3_funnel', 'one bar per stage'],
    ['assistant', 'added_slack_connector_to_workspace', 'Acme'],
    ['assistant', 'created_file_with_notes', 'notes.md'],
    ['Assistant', 'Published Artifact', 'the dashboard'],
    ['the_assistant', 'ran-tests', 'all passed'],
    ['AI assistant', 'Created Artifact', 'the dashboard'],
  ])('drops %s | %s | %s: narration of its own action', (subject, predicate, object) => {
    const fact = { subject, predicate, object };
    expect(classifyAgentFact(fact)).toBe('action-narration');
    expect(isAgentContextSelfReport(fact)).toBe(true);
  });

  it.each([
    ['assistant', 'stated_limitation', 'cannot browse the internet'], // card: x3
    ['assistant', 'has_limitation', 'no real-time data'],
    ['assistant', 'acknowledged_limitations', "can't see images in this chat"],
    // No verb at all is no holder either: these read the object's start.
    ['assistant', 'limitation', 'no access to the calendar'],
    ['assistant', 'known_limitations', 'cannot read images or PDFs'],
    ['assistant', 'stated_its_limitations', 'no web access'],
    ['assistant', 'has_no_access_to', 'real-time stock prices'],
    ['assistant', "doesn't_have_access", 'to the internet'],
    ['assistant', 'lacks_access', 'to the shared drive'],
    ['the assistant', 'Stated Limitation', 'cannot open PDFs'],
    // `has_…`, `had_…` or `have_…` makes the assistant the holder: no object
    // check, so "for …" is still its own limit, not a topic.
    ['assistant', 'has_limitation', 'knowledge cutoff of early 2024'],
    ['assistant', 'has_limitations', 'for image input: it reads text only'],
    // A reporting verb can report anyone's limits, and so can a predicate with
    // no verb, so they need the assistant marked: in the predicate (`its`,
    // `own`), or at the object's start.
    ['assistant', 'described_its_capabilities', 'web search, code execution and charts'],
    ['assistant', 'acknowledged_own_limitations', 'text only, no image input'],
    ['assistant', 'noted_limitation', 'unable to send email'],
    ['assistant', 'clarified_limitation', 'I don’t have access to your calendar'],
    ['assistant', 'admitted_limitation', 'the assistant could not open attachments'],
    ['assistant', 'stated_limitation', 'no internet access'],
    ['assistant', 'disclosed_limitation', 'lacks real-time data'],
    ['assistant', 'noted_limitation', 'does not have access to your files'],
    ['assistant', 'stated_limitation', 'unable to browse the web'],
    ['assistant', 'stated_limitation', 'unable to begin a phone call'], // "be" only as a whole word
  ])('drops %s | %s | %s: what it says it can or cannot do', (subject, predicate, object) => {
    const fact = { subject, predicate, object };
    expect(classifyAgentFact(fact)).toBe('capability');
    expect(isAgentContextSelfReport(fact)).toBe(true);
  });

  // The card's whole keep-set, plus two rows where an identity word beats an
  // action word (`saved_…`, `published_…`).
  it.each([
    ['assistant', 'has_name', 'Ember'],
    ['assistant', 'is_named', 'Ember'],
    ['assistant', 'was_named', 'Ember, by the user'],
    ['assistant', 'introduced_as', 'Ember, a research assistant'],
    ['assistant', 'adopted_identity', 'a calm, curious research partner'],
    ['assistant', 'adopted_signature_emoji', '✨'],
    ['assistant', 'default_design_style', 'minimal, lots of whitespace'],
    ['assistant', 'established_rule', 'always cite sources'],
    ['assistant', 'saved_standing_preference', 'reply in bullet points'],
    ['assistant', 'was_created_by_user', 'Vinay'],
    ['assistant', 'published_style_guide', 'brand colors and fonts'],
  ])('keeps %s | %s | %s: who it is', (subject, predicate, object) => {
    const fact = { subject, predicate, object };
    expect(classifyAgentFact(fact)).toBe('identity');
    expect(isAgentContextSelfReport(fact)).toBe(false);
  });

  // What the assistant supplied: the pinned extraction prompt's contract.
  it.each([
    ['assistant', 'recommended_sealant', 'Mod Podge or another sealant, to seal the newspaper flower vase'],
    ['assistant', 'recommended', 'the Fenway walking tour'],
    ['assistant', 'listed', 'the 10 hiking trails near Denver, in order'],
    ['assistant', 'listed_options', 'three plans: basic, plus, pro'],
    ['assistant', 'provided_forecast', '72 F and sunny on Tuesday'], // the card called it narration; scope B keeps it
    ['assistant', 'provided_solution', 'a composite index on (agent_key, slot)'],
    ['assistant', 'stated', 'the Roth IRA income limit is $161k'],
    ['assistant', 'described_architecture', 'three tiers: web, api, db'],
    ['assistant', 'explained', 'how compound interest works'],
    ['assistant', 'suggested', 'a vegetarian lasagna'],
    ['assistant', 'noted', 'the API allows 100 requests a minute'],
    ['assistant', 'reported_findings', '3 issues, the worst an open redirect'],
    ['assistant', 'created_meal_plan', 'Mon oatmeal, Tue eggs, Wed yogurt'], // `created` needs an artifact noun
    ['assistant', 'created', 'a 5-day Lisbon itinerary: Belem, Sintra, Cascais'],
    ['assistant', 'generated_list', '10 baby names, starting with Ada'],
    ['assistant', 'wrote', 'a haiku about autumn'],
    ['assistant', 'wrote_code', 'def parse(s): return s.split(",")'], // code it supplied is content
    ['assistant', 'updated_itinerary', 'Day 2 is now Sintra'],
    ['assistant', 'added', 'a vegetarian option: lentil curry'],
    ['assistant', 'compiled', 'a list of 10 trails'],
    ['assistant', 'drafted_email', 'Subject: Q3 update'],
    // Everyday nouns: a routine, skills or a workflow it wrote for the person.
    ['assistant', 'created_workout_routine', 'Mon push, Tue pull, Wed legs'],
    ['assistant', 'updated_workout_routine', 'Mon push, Tue pull, Wed legs, Thu rest'],
    ['assistant', 'added_skills', 'Python, SQL'],
    ['assistant', 'added_skills_to_resume', 'Python, SQL and Tableau'],
    ['assistant', 'created_workflow', '1. intake 2. triage 3. assign 4. close'],
    ['assistant', 'created_home_automation_plan', 'porch lights on at sunset, thermostat to 62 at 11pm'],
    // An artifact word that only modifies the head: an outline, a map, a
    // message or a prompt it wrote.
    ['assistant', 'created_presentation_outline', '1. Intro 2. Market size 3. The ask'],
    ['assistant', 'created_site_map', 'home, about, pricing, blog'],
    ['assistant', 'created_app_idea', 'a plant-watering reminder app'],
    ['assistant', 'created_file_naming_convention', 'YYYY-MM-DD_client_project'],
    ['assistant', 'created_branch_naming_scheme', 'feat/<ticket>-<slug>'],
    ['assistant', 'wrote_landing_page_copy', 'Ship faster with fewer meetings'],
    ['assistant', 'wrote_commit_message', 'fix: handle empty input in parser'],
    ['assistant', 'wrote_pr_description', 'Adds retry with jitter to the uploader'],
    ['assistant', 'wrote_document_summary', 'the lease allows pets under 25 lb'],
    ['assistant', 'wrote_component_spec', 'DatePicker: min, max, locale props'],
    ['assistant', 'generated_image_prompt', 'a watercolor fox in a misty forest, soft light'],
    // Content phrased like a build.
    ['assistant', 'built', 'a 12-week training plan'],
    ['assistant', 'rebuilt', 'the training plan around 3 runs a week'],
    ['assistant', 'implemented_solution', 'memoized fib'],
    // Content phrased like debugging, a test or a merge.
    ['assistant', 'debugged', 'the regex: the dot needs escaping'],
    ['assistant', 'tested_hypothesis', 'with a t-test: p = 0.03, significant'],
    ['assistant', 'retested_hypothesis', 'on the full sample: p = 0.04'],
    ['assistant', 'merged_lists', 'the two guest lists: 42 names'],
    // A reporting verb reports anyone's limits. A topic's stay.
    ['assistant', 'explained_limitations', 'of the Roth IRA: an income cap of $161k'],
    ['assistant', 'listed_limitations', 'the Roth IRA caps income at $161k'],
    ['assistant', 'described_capabilities', 'Kubernetes HPA can scale on custom metrics'],
    ['assistant', 'listed_limitations', 'no control group and a small sample (n=40)'],
    ['assistant', 'described_limitations', 'lacks a control group, so it shows correlation only'],
    ['assistant', 'outlined_limitations', 'only covers in-network providers'],
    ['assistant', 'explained_limitations_of_the_study', 'small sample size'],
    // With no verb, a limitation predicate is no holder: anyone's limits.
    ['assistant', 'known_limitations', 'of the study: n=40, no control group'],
    ['assistant', 'technical_limitations', 'Postgres max row size is 1.6 TB'],
    ['assistant', 'limitations', 'Roth IRA: income cap $161k'],
    ['assistant', 'capabilities', 'Kubernetes HPA: scale on custom metrics'],
    // "it" and a plain "can" don't mark the assistant: a product has them too.
    ['assistant', 'noted_limitation', "it doesn't work offline"],
    ['assistant', 'noted_limitation', "it can't be refunded after 30 days"],
    ['assistant', 'described_capabilities', 'can export to PDF and Excel'],
    // A topic's limit with no subject of its own: passive voice ("cannot BE
    // combined") is never the assistant's own limit, and a bare "does not"
    // is one only before "have".
    ['assistant', 'explained_limitations', 'cannot be combined with other offers'],
    ['assistant', 'listed_limitations', 'cannot be used for international travel'],
    ['assistant', 'explained_limitations', 'could not be verified by an independent lab'],
    ['assistant', 'noted_limitation', 'unable to be refunded after 30 days'],
    ['assistant', 'listed_limitations', 'does not cover dental or vision'],
    ['assistant', 'explained_limitations', "doesn't apply to rollovers"],
    ['assistant', 'explained_limitations', 'do not include taxes'],
    ['assistant', 'explained_limitations', 'cannot  be combined with other offers'], // any whitespace
    // "does not have" counts only before access, the internet or an ability.
    ['assistant', 'listed_limitations', 'does not have a free tier'],
    ['assistant', 'known_limitations', "doesn't have offline mode"],
    // A chart, graph or page it wrote: these count only bare, like `routine`.
    ['assistant', 'created_org_chart', 'CEO -> VP Eng -> 3 managers'],
    ['assistant', 'created_chore_chart', 'Mon dishes, Tue laundry'],
    ['assistant', 'created_gantt_chart', 'design wk1-2, build wk3-6'],
    ['assistant', 'wrote_landing_page', 'Ship faster with fewer meetings'],
    ['assistant', 'wrote_cover_page', 'Q3 Report, prepared for the board'],
    ['assistant', 'created_dependency_graph', 'A -> B -> C'],
    ['assistant', 'created_sequence_diagram', 'client -> api -> db'],
    // An opener word must end where it ends: "no accessories", "no webhooks"
    // and "cantilevered" aren't the assistant's own limits.
    ['assistant', 'listed_limitations', 'no accessories in the box'],
    ['assistant', 'listed_limitations', 'no webhooks on the free plan'],
    ['assistant', 'known_limitations', 'cantilevered decks need an engineer'],
    // A limitation or no-access word mid-predicate is a topic: both
    // capability tests are anchored at the start.
    ['assistant', 'explained_study_limitations', 'small sample size, no control group'],
    ['assistant', 'explained_why_the_guest_has_no_access', 'the share link expired yesterday'],
    ['assistant', 'runs', 'a daily digest at 9am'], // present tense: a standing behaviour
    ['assistant', 'publishes', 'the weekly report on Fridays'],
  ])('keeps %s | %s | %s: what it supplied', (subject, predicate, object) => {
    const fact = { subject, predicate, object };
    expect(classifyAgentFact(fact)).toBe('other');
    expect(isAgentContextSelfReport(fact)).toBe(false);
  });

  // Accepted residuals, kept on purpose: a missed junk row is the cheap
  // direction. Only "kept" is pinned, not why.
  it.each([
    ['assistant', 'searched_web', 'for flights to Lisbon'],
    ['assistant', 'checked', 'the deploy status: green'],
    ['assistant', 'renamed_file', 'a.txt to b.txt'], // `renamed` is an identity word
    ['assistant', 'added_skill', 'pdf-tools'], // `skill` isn't an artifact noun: `added_skills | Python, SQL` is a résumé
    ['assistant', 'set_up_weekly_routine', 'a digest every Monday at 9am'], // `routine` counts only bare
    // The artifact noun isn't the head of the verb's object.
    ['assistant', 'wrote_to_file', 'results.csv'], // no object before the preposition
    ['assistant', 'created_artifact_showing_q3_sales', 'a bar chart'], // the head is `sales`
    // Its own limits, opened by words a product's can start with too.
    ['assistant', 'noted_limitation', 'it is unable to send email'],
    ['assistant', 'described_capabilities', 'can browse, run code and make charts'],
    ['assistant', 'described_capabilities', "I don't browse the web"],
    // A chart named by its kind, a word after the head, and an "and" list.
    ['assistant', 'created_bar_chart', 'Q3 revenue by region'],
    ['assistant', 'created_artifact_successfully', 'the Q3 dashboard'],
    ['assistant', 'created_dashboard_and_report', 'for Q3'],
  ])('keeps the accepted residual %s | %s | %s', (subject, predicate, object) => {
    expect(isAgentContextSelfReport({ subject, predicate, object })).toBe(false);
  });

  it.each([
    ['user', 'created_artifact', 'the Q3 dashboard'],
    ['sam', 'ran_tests', 'all passed'],
    ['agent', 'published_artifact', 'x'], // `agent` is an everyday noun (TASK-1136)
    ['the_agent', 'published', 'the listing on Zillow'],
    ['vinay', 'stated_limitation', 'no weekend meetings'],
  ])('keeps %s | %s | %s: not the assistant', (subject, predicate, object) => {
    const fact = { subject, predicate, object };
    expect(classifyAgentFact(fact)).toBeNull();
    expect(isAgentContextSelfReport(fact)).toBe(false);
  });

  it("names TASK-612's class: walk TASK-607's fact is context", () => {
    expect(classifyAgentFact(WALK_FACT)).toBe('context');
  });

  // TASK-612 reads `agent` and `the_agent` as the agent too, and the observer
  // still drops these. But `agent` is an everyday noun (a real-estate agent's
  // "no instructions from the seller"), and the cleanup's delete is permanent,
  // so they get a class of their own, which the cleanup keeps
  // (`narration-cleanup.test.ts`).
  it.each([
    ['agent', WALK_FACT.predicate, WALK_FACT.object],
    ['The Agent', WALK_FACT.predicate, WALK_FACT.object],
    ['the_agent', 'received', 'no instructions from the seller about the counteroffer'],
    ['agent', 'has_no_rules', 'about pets in the unit'],
    ['the agent', 'stated', "doesn't have any memory of the phone call"],
    ['Agent', 'said', 'my instructions are to accept anything over 450k'],
  ])("names TASK-612's class for %s | %s | %s: agent-context, still dropped", (subject, predicate, object) => {
    const fact = { subject, predicate, object };
    expect(classifyAgentFact(fact)).toBe('agent-context');
    expect(isAgentContextSelfReport(fact)).toBe(true);
  });

  it.each(['the_assistant', 'AI assistant', 'Assistant'])(
    "names TASK-612's class for %s: the assistant's own context",
    (subject) => {
      expect(classifyAgentFact({ ...WALK_FACT, subject })).toBe('context');
    },
  );

  it("names TASK-1136's class: a failed save is its own narration", () => {
    expect(classifyAgentFact({ subject: 'assistant', predicate: 'could_not_save_memory', object: 'x' })).toBe(
      'own-narration',
    );
  });

  it("runs TASK-1136's check before the action verbs: saved_to_memory is its own narration", () => {
    // Its first word, `saved`, is also an action verb.
    expect(
      classifyAgentFact({ subject: 'assistant', predicate: 'saved_to_memory', object: 'the standup time' }),
    ).toBe('own-narration');
  });

  it('stays fast on huge, repetitive, untrusted input (TASK-1151)', () => {
    const start = performance.now();
    for (const word of ['created artifact ', 'stated limitation ', 'has no access ', 'saved standing preference ', 'set up ']) {
      classifyAgentFact({
        subject: 'assistant',
        predicate: `${word.replace(/ /g, '_').repeat(20_000)}x`,
        object: `${word.repeat(40_000)}x`,
      });
    }
    // A megabyte of spaces before the topic's "of".
    classifyAgentFact({
      subject: 'assistant',
      predicate: 'explained_limitations',
      object: `${' '.repeat(1_000_000)}of the study`,
    });
    // The object's start is read for a reporting verb: a megabyte of "it "
    // and "no " before a self-limit. And a long run of determiners before a
    // routine (its size is the loop's: more only times TASK-612's uncut work).
    for (const object of [`${'it '.repeat(400_000)}cannot`, `${'no '.repeat(400_000)}access`]) {
      classifyAgentFact({ subject: 'assistant', predicate: 'listed_limitations', object });
    }
    classifyAgentFact({ subject: 'assistant', predicate: `created_${'a_new_'.repeat(20_000)}routine`, object: 'x' });
    expect(performance.now() - start).toBeLessThan(250);
  });
});

// TASK-1204 review F9: the one answer to "is this subject the agent itself?",
// for `speakerSubject` too. A team agent's member turn files a subject made of
// the speaker's names under the speaker, and a member whose display name is
// "AI Assistant" or "Agent Smith" must not pull the agent's facts with it.
describe('isAgentSubject: the subjects classifyAgentFact reads as the agent itself', () => {
  it.each([
    'assistant',
    'Assistant',
    ' assistant ',
    'the_assistant',
    'the assistant',
    'ai_assistant',
    'AI Assistant',
    'ai-assistant',
    'agent',
    'Agent',
    'the_agent',
    'The Agent',
  ])('%j is the agent', (subject) => {
    expect(isAgentSubject(subject)).toBe(true);
    // The same answer classifyAgentFact starts from: the agent is the subject.
    expect(classifyAgentFact({ subject, predicate: 'has_no_rules', object: 'from the user' })).not.toBeNull();
  });

  it.each(['user', 'agent_smith', 'ai', 'bot', 'assistants', 'travel_agent', 'assistant_manager', ''])(
    '%j is not',
    (subject) => {
      expect(isAgentSubject(subject)).toBe(false);
      expect(classifyAgentFact({ subject, predicate: 'has_no_rules', object: 'from the user' })).toBeNull();
    },
  );
});
