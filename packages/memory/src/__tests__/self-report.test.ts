import { describe, expect, it } from 'vitest';

import { isAgentContextSelfReport } from '../self-report.js';

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
    ['assistant', 'could_not_find_it_in_my_memory', 'the standup time'],
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
    ['assistant', 'saved', 'the Q3 report draft to the shared drive'],
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
    ['assistant', 'saved_to_memory_card', 'the photos from the shoot'],
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
    // Review round 3: memory in a failure predicate counts only with where
    // (to/in/from memory); otherwise it's RAM, or a topic.
    ['assistant', 'could_not_reduce_memory_usage', 'of the worker pod below 512MB'],
    ['assistant', 'could_not_reproduce_the_memory_spike', 'on Node 20'],
    ['assistant', 'failed_to_allocate_memory', 'for the 70B model on one GPU'],
    ['assistant', 'could_not_find_research_on_memory_consolidation', 'during sleep'],
    ['assistant', 'could_not_find_a_regression_in_memory_usage', 'between v2 and v3'],
    ['assistant', 'could_not_find_the_bug_in_the_memory_allocator', 'in the C extension'],
    ['assistant', 'could_not_find_studies_on_facts_encoded_in_long_term_memory', 'x'],
    ['assistant', 'could_not_find_it_within_memory_limits', 'for the 70B model'],
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
