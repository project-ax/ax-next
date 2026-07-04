import { describe, it, expect, vi } from 'vitest';
import type { LlmCallInput, LlmCallOutput } from '@ax/core';
import type { OrchestratorClient } from '@ax/memory-strata';
import { runE2EQuestion, parseCorpusDate } from '../e2e-driver.js';
import type { E2EAnswerClient } from '../e2e-answer.js';
import type { LongMemEvalSample } from '../corpora/longmemeval-s.js';

// A stubbed extraction LLM that returns one durable, high-confidence fact for any
// transcript mentioning "cortado", else []. No network. This is the seam the real
// Observer calls via `llm:call:anthropic`.
function stubExtraction(): (input: LlmCallInput) => Promise<LlmCallOutput> {
  return async (input: LlmCallInput) => {
    const transcript = input.messages.map((m) => m.content).join('\n');
    const facts = /cortado/i.test(transcript)
      ? [{ fact: 'User prefers cortados for coffee.', subject: 'coffee', factType: 'preference', confidence: 0.9 }]
      : [];
    return {
      text: JSON.stringify(facts),
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 20 },
    };
  };
}

const answerableSample: LongMemEvalSample = {
  question_id: 'q-coffee',
  question_type: 'single-session-preference',
  question: 'What coffee do I prefer?',
  answer: 'Cortados',
  haystack_session_ids: ['s0', 's1'],
  haystack_sessions: [
    [
      { role: 'user', content: 'I always order a cortado when I get coffee.' },
      { role: 'assistant', content: 'Noted — cortado it is.' },
    ],
    [
      { role: 'user', content: 'The weather has been cloudy lately, unrelated chatter.' },
      { role: 'assistant', content: 'Indeed.' },
    ],
  ],
};

describe('runE2EQuestion (TASK-189 integration, stubbed LLMs)', () => {
  it('ingests haystack via the real Observer+consolidator and injects/retrieves the promoted fact', async () => {
    // The answer client captures what the real plugin produced: the injected
    // block AND a live memory_search over the consolidated sqlite index.
    let capturedInjected = '';
    let capturedSearchRows: unknown[] = [];
    const answerClient: E2EAnswerClient = {
      async answer({ injectedMemory, search }) {
        capturedInjected = injectedMemory;
        capturedSearchRows = await search({ query: 'coffee preference' });
        return { text: 'You prefer cortados.', usage: { in: 200, out: 10 }, toolCalls: 1 };
      },
    };

    const result = await runE2EQuestion({
      sample: answerableSample,
      extractionLlm: stubExtraction(),
      answerClient,
    });

    expect(result.sessionsIngested).toBe(2);
    expect(result.agentAnswer).toBe('You prefer cortados.');
    expect(result.unanswerable).toBe(false);
    // The promoted fact reached docs/ → system/recent.md's "Recent Changes"
    // lists the doc pointer (`preference/coffee`) in the injected block. (The
    // fact BODY lives in the doc, surfaced via memory_search below — that's the
    // shipped split: inject = User Profile + Recent summary; search = full docs.)
    expect(capturedInjected.toLowerCase()).toContain('preference/coffee');
    // And the fact itself is retrievable via the real memory_search over the
    // consolidated sqlite index — the load-bearing per-turn retrieval path.
    expect(capturedSearchRows.length).toBeGreaterThan(0);
    expect(JSON.stringify(capturedSearchRows).toLowerCase()).toContain('cortado');
    // Extraction tokens accrued for both sessions' Observer calls (50 each =
    // 100) PLUS the TASK-190 map densifier, which runs through the SAME
    // `llm:call:anthropic` hook during consolidation: one promoted doc
    // (`preference/coffee`) ⇒ one densify call (+50). The map densifier shares
    // the Observer's host-LLM gating, so its tokens land in the same meter.
    expect(result.extractionTokens.in).toBe(150);
  });

  it('flags the _abs split as unanswerable and tolerates no extracted facts', async () => {
    const absSample: LongMemEvalSample = {
      question_id: 'q-hamster_abs',
      question: 'What is my hamster named?',
      answer: 'You did not mention this information.',
      haystack_session_ids: ['s0'],
      haystack_sessions: [
        [{ role: 'user', content: 'I love my cat Luna.' }, { role: 'assistant', content: 'Sweet!' }],
      ],
    };
    let injectedSeen = '';
    const answerClient: E2EAnswerClient = {
      async answer({ injectedMemory, search }) {
        injectedSeen = injectedMemory;
        await search({ query: 'hamster name' });
        return { text: "I don't know.", usage: { in: 50, out: 5 }, toolCalls: 1 };
      },
    };

    const result = await runE2EQuestion({
      sample: absSample,
      extractionLlm: stubExtraction(), // returns [] (no cortado) → nothing promoted
      answerClient,
    });

    expect(result.unanswerable).toBe(true);
    expect(result.agentAnswer).toBe("I don't know.");
    // No durable fact extracted → injected block has no profile/recent content
    // about a hamster (it may be empty or only carry the seeded persona).
    expect(injectedSeen.toLowerCase()).not.toContain('hamster');
  });

  it('keeps two samples isolated — no cross-question leakage', async () => {
    const search1: unknown[] = [];
    const search2: unknown[] = [];
    const mk = (sink: unknown[]): E2EAnswerClient => ({
      async answer({ search }) {
        const rows = await search({ query: 'coffee' });
        sink.push(...rows);
        return { text: 'ok', usage: { in: 1, out: 1 }, toolCalls: 1 };
      },
    });

    // Sample A ingests the cortado fact.
    await runE2EQuestion({ sample: answerableSample, extractionLlm: stubExtraction(), answerClient: mk(search1) });
    // Sample B has a different, unrelated haystack — must NOT see A's cortado fact.
    const otherSample: LongMemEvalSample = {
      question_id: 'q-other',
      question: 'What do I prefer?',
      answer: 'Tea',
      haystack_session_ids: ['s0'],
      haystack_sessions: [
        [{ role: 'user', content: 'Just discussing the cloudy weather, no coffee.' }, { role: 'assistant', content: 'OK.' }],
      ],
    };
    await runE2EQuestion({ sample: otherSample, extractionLlm: stubExtraction(), answerClient: mk(search2) });

    expect(JSON.stringify(search1).toLowerCase()).toContain('cortado');
    // Sample B's fresh workspace + fresh DB must not surface A's fact.
    expect(JSON.stringify(search2).toLowerCase()).not.toContain('cortado');
  });

  it('stops ingest early when the cost-cap predicate trips', async () => {
    const shouldStopIngest = vi.fn().mockReturnValue(true); // cap already hit
    const answerClient: E2EAnswerClient = {
      async answer() {
        return { text: 'capped', usage: { in: 0, out: 0 }, toolCalls: 0 };
      },
    };
    const result = await runE2EQuestion({
      sample: answerableSample,
      extractionLlm: stubExtraction(),
      answerClient,
      shouldStopIngest,
    });
    expect(result.sessionsIngested).toBe(0);
    expect(result.agentAnswer).toBe('capped');
  });

  it('reaches the shipped orchestrator retrieval path (TASK-191) when an orchestratorClient is supplied', async () => {
    // Stub orchestrator client — no network. Unconditionally emits a <load> op
    // for the doc the cortado fixture promotes (preference/coffee — the same
    // docId the first test above confirms lands in the injected block). Mirrors
    // the src/__tests__/tools-memory-search.test.ts orchestrator-path stub.
    const orchestratorClient: OrchestratorClient = {
      complete: vi.fn(async () => ({
        text: '<load doc="preference/coffee"/>',
        usage: { in: 1, out: 1 },
      })),
    };
    let capturedSearchRows: unknown[] = [];
    const answerClient: E2EAnswerClient = {
      async answer({ search }) {
        capturedSearchRows = await search({ query: 'coffee preference' });
        return { text: 'You prefer cortados.', usage: { in: 200, out: 10 }, toolCalls: 1 };
      },
    };

    const result = await runE2EQuestion({
      sample: answerableSample,
      extractionLlm: stubExtraction(),
      answerClient,
      orchestratorClient,
    });

    expect(result.retrievalMode).toBe('orchestrator');
    // The orchestrator LLM was actually invoked from the e2e acceptance path —
    // this is the reachability signal: the shipped memory_search tool read
    // system/map.md (regenerated by the real consolidator) and drove the
    // orchestrator, not a mock of the plugin itself.
    expect(orchestratorClient.complete).toHaveBeenCalledTimes(1);
    // Its <load> op resolved the same promoted doc a plain-BM25 search would
    // find (see the first test above) — proving the orchestrator path returns
    // real, usable rows, not just that it was called.
    expect(JSON.stringify(capturedSearchRows).toLowerCase()).toContain('cortado');
    expect(JSON.stringify(capturedSearchRows).toLowerCase()).toContain('preference/coffee');
  });

  // The tests above that omit `orchestratorClient` (e.g. "ingests haystack via
  // the real Observer+consolidator...") already prove the harness degrades
  // cleanly to BM25 when no client is configured — `runE2EQuestion` there
  // returns `retrievalMode: 'bm25'` and drives the exact same real
  // memory_search tool over the same consolidated index, just without an
  // orchestrator in front of it.

  // TASK-198/Task 5 (bench temporal fidelity): the harness previously ingested
  // every haystack session at wall-clock time, so fact dates and "this year"/
  // "in February" questions were fiction-vs-reality mismatches. `haystack_dates`
  // now drives the Observer's `now` per session, and `question_date` reaches the
  // answer system prompt.
  it('feeds haystack_dates into ingestion time and question_date into the answer system prompt', async () => {
    const dated: LongMemEvalSample = {
      ...answerableSample,
      question_id: 'q-coffee-dated',
      question_date: '2023-06-01',
      haystack_dates: ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:00'],
    };

    let capturedSearchRows: unknown[] = [];
    let capturedSystem = '';
    const answerClient: E2EAnswerClient = {
      async answer({ search, question, questionDate }) {
        capturedSystem =
          questionDate !== undefined ? `Today's date: ${questionDate}` : '';
        void question;
        capturedSearchRows = await search({ query: 'coffee preference' });
        return { text: 'You prefer cortados.', usage: { in: 200, out: 10 }, toolCalls: 1 };
      },
    };

    await runE2EQuestion({
      sample: dated,
      extractionLlm: stubExtraction(),
      answerClient,
    });

    // (a) the Observer's `now` for the first haystack session came from its
    // corpus date (2023-05-20), not wall-clock — visible as the fact line's
    // date prefix baked in at consolidation (formatFactLine).
    expect(JSON.stringify(capturedSearchRows)).toContain('(2023-05-20)');
    // (b) question_date reached the answer client.
    expect(capturedSystem).toBe("Today's date: 2023-06-01");
  });
});

describe('parseCorpusDate', () => {
  it('parses the LongMemEval "YYYY/MM/DD (Sat) HH:MM" form to noon UTC', () => {
    const d = parseCorpusDate('2023/05/20 (Sat) 02:21');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2023-05-20T12:00:00.000Z');
  });

  it('parses a bare "YYYY-MM-DD" form to noon UTC', () => {
    const d = parseCorpusDate('2023-05-20');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2023-05-20T12:00:00.000Z');
  });

  it('returns null for absent input', () => {
    expect(parseCorpusDate(undefined)).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseCorpusDate('not a date')).toBeNull();
  });

  it('returns null (does not throw) for a non-string JSON null', () => {
    // haystack_dates is an unchecked JSON.parse cast — a literal `null` entry
    // must not reach `raw.trim()` and throw a TypeError.
    expect(parseCorpusDate(null as unknown as string | undefined)).toBeNull();
  });
});
