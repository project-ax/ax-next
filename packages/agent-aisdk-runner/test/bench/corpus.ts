// ---------------------------------------------------------------------------
// The compaction eval corpus (design §7: "long sessions where a question must
// still be answerable AFTER compaction fires").
//
// WHY SYNTHETIC. The thing being measured is whether one specific transform —
// summarize the middle, keep the ends — destroys facts a later turn needs.
// Answering that needs conversations where we KNOW what the facts are and
// WHERE they sit, and no corpus of real sessions gives us that. So the corpus
// is generated: filler that looks like agent work, with facts planted at
// controlled depths and a question written for each one.
//
// WHAT MAKES A FAIR TEST HERE, and what would make a rigged one:
//
//   - Every planted fact sits in the region that gets SUMMARIZED. A fact in
//     the preserved head or tail survives by construction and would inflate
//     the score for free, so `plantedFacts` refuses to place one there (the
//     bench asserts the split afterwards).
//   - The filler is not noise. A wall of lorem ipsum is much easier to
//     summarize than a real session, because there is nothing competing for
//     room in the summary. The filler here is plausible agent work — files
//     read, commands run, decisions revised — so the summarizer has to CHOOSE,
//     which is the actual failure mode.
//   - A fact is stated ONCE. Repetition is how a summary keeps something by
//     accident.
//   - Some questions are UNANSWERABLE. Recall alone rewards a model that
//     confabulates confidently; the abstention questions are the control, and
//     the memory-strata bench learned that lesson the expensive way.
// ---------------------------------------------------------------------------

import type { ModelMessage } from 'ai';

export interface Needle {
  /** Stable id, for the report. */
  id: string;
  /** The question asked after compaction. */
  question: string;
  /** What a correct answer says. */
  gold: string;
  /**
   * A distinctive string that appears in the conversation exactly where the
   * fact was planted — the handle the fairness check uses to prove the fact
   * really is in the summarized region and not in the preserved head or tail.
   *
   * Stated explicitly rather than extracted from `gold` by a heuristic: the
   * check it backs is what stops this bench scoring a rigged corpus, and a
   * heuristic that quietly returns nothing turns that check off without saying
   * so. Absent only for the unanswerable needles, which have nothing to find.
   *
   * Named `marker` rather than the obvious alternative. Two reasons, and the
   * boring one is decisive: a field whose NAME is a secret-ish word, assigned a
   * quoted string, is a credential as far as gitleaks' `generic-api-key` rule
   * is concerned — it failed the build on every entry here regardless of the
   * value, which is why the first fix (changing the value) did not help. The
   * better reason is that the word already means two other things in this
   * codebase, a credential and a unit of context, and this is neither.
   */
  marker?: string;
  /**
   * True when the fact was never in the conversation at all. The right answer
   * is "I don't know" — anything else is a confabulation, not a recall.
   */
  unanswerable: boolean;
  /** Where in the conversation the fact was planted, 0 = oldest. */
  depth?: number;
}

export interface BenchConversation {
  name: string;
  messages: ModelMessage[];
  needles: Needle[];
}

/** One planted fact: how it is said, and what it is later asked about. */
interface PlantedFact {
  statement: string;
  question: string;
  gold: string;
  /** See `Needle.marker`. Must appear in `statement` and nowhere else. */
  marker: string;
}

/**
 * The facts. Deliberately the kind a coding session actually turns on — a
 * path, a version, a decision and its reason, a reversal, a constraint — rather
 * than trivia, because those are what a lost summary costs someone.
 */
const FACTS: PlantedFact[] = [
  {
    statement:
      "One thing before we go further: the staging database is at db-staging-7.internal on port 5433, not 5432. The 5432 one is production and I don't want us touching it.",
    question: 'What host and port is the staging database on?',
    gold: 'db-staging-7.internal on port 5433',
    marker: 'db-staging-7.internal',
  },
  {
    statement:
      'Actually, scratch what I said about using Redis for the queue. Legal came back and said no new data stores this quarter, so we are doing it with a Postgres table and SKIP LOCKED.',
    question: 'What is the queue implemented with, and why not Redis?',
    gold: 'A Postgres table using SELECT ... FOR UPDATE SKIP LOCKED, because legal blocked new data stores this quarter',
    marker: 'SKIP LOCKED',
  },
  {
    statement:
      'Note for later: the flaky test is packages/billing/src/__tests__/proration.test.ts, and it only fails when the machine timezone is not UTC.',
    question: 'Which test is flaky and under what condition does it fail?',
    gold: 'packages/billing/src/__tests__/proration.test.ts, when the machine timezone is not UTC',
    marker: 'packages/billing/src/__tests__/proration.test.ts',
  },
  {
    statement:
      'Important constraint I forgot to mention: we are stuck on Node 20 in the deploy image until the platform team finishes their upgrade, so nothing that needs 22.',
    question: 'What Node version are we constrained to, and why?',
    gold: 'Node 20, because the deploy image cannot move until the platform team finishes their upgrade',
    marker: 'Node 20',
  },
  {
    // Deliberately NOT shaped like a Stripe/vendor id. A high-entropy
    // `cus_…`-style value reads as a credential to a secret scanner, and the
    // right answer to that is a corpus that does not look like one — not an
    // allowlist entry that quiets the scanner over this whole directory
    // forever. The fact still has to be specific enough that a summary either
    // kept it or did not, which a readable slug does fine.
    statement:
      'The account we are debugging is the northwind-eu-2 workspace. Every other one works fine, so please keep using that one for repros.',
    question: 'Which account are we using for repros?',
    gold: 'the northwind-eu-2 workspace',
    marker: 'northwind-eu-2',
  },
  {
    statement:
      'We decided to keep the old /v1/invoices endpoint alive until March 30th rather than deleting it now, because two partners still call it.',
    question: 'When is the old /v1/invoices endpoint going away, and why not sooner?',
    gold: 'March 30th, because two partners still call it',
    marker: 'March 30th',
  },
];

/** Questions about facts that were never in the conversation. */
const ABSENT: Array<{ question: string; gold: string }> = [
  {
    question: 'What did we decide about the mobile app release?',
    gold: 'Nothing — the conversation never discussed a mobile app release. The right answer is to say so.',
  },
  {
    question: 'Which cloud region is the cache cluster in?',
    gold: 'Unknown — the conversation never mentioned a cache cluster or its region. The right answer is to say so.',
  },
];

/** Filler exchanges: plausible agent work with nothing worth remembering. */
const FILLER_TASKS: Array<readonly [ask: string, file: string, command: string]> = [
  ['Can you check what that helper does?', 'src/util/format.ts', 'grep -n "export function" src/util/format.ts'],
  ['Run the unit tests for that package.', 'packages/api/src/index.ts', 'pnpm --filter @app/api test'],
  ['What does the build config look like?', 'tsconfig.json', 'cat tsconfig.json'],
  ['Is that dependency still used anywhere?', 'package.json', 'grep -rn "lodash" src/'],
  ['Show me the last few commits.', 'CHANGELOG.md', 'git log --oneline -5'],
  ['Any lint errors in there?', 'src/routes/billing.ts', 'pnpm lint src/routes/billing.ts'],
  ['How big is that file?', 'src/legacy/importer.ts', 'wc -l src/legacy/importer.ts'],
  ['Check whether the migration ran.', 'migrations/0042_add_index.sql', 'psql -c "select * from schema_migrations order by version desc limit 3"'],
];

function userMsg(text: string): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMsg(text: string): ModelMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

/** One filler exchange: ask → tool call → tool result → answer. */
function fillerExchange(i: number, outputChars: number): ModelMessage[] {
  const [ask, file, command] = FILLER_TASKS[i % FILLER_TASKS.length]!;
  const id = `call-${i}`;
  return [
    userMsg(`${ask} (round ${i})`),
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Let me look at ${file}.` },
        { type: 'tool-call', toolCallId: id, toolName: 'Bash', input: { command } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: 'Bash',
          output: { type: 'text', value: fakeOutput(file, i, outputChars) },
        },
      ],
    },
    assistantMsg(
      `${file} looks fine — nothing surprising in there. Want me to keep going?`,
    ),
  ];
}

/** Plausible, boring tool output of roughly `chars` characters. */
function fakeOutput(file: string, seed: number, chars: number): string {
  const lines: string[] = [];
  let n = 0;
  for (let i = 0; lines.join('\n').length < chars; i++) {
    n = (seed * 31 + i * 17) % 997;
    lines.push(
      `${file}:${i + 1}: ${'  '.repeat(i % 4)}const value_${n} = compute(${n}, options.flag_${n % 7});`,
    );
  }
  return lines.join('\n');
}

export interface BuildOptions {
  /** How many filler exchanges. Each is 4 messages. */
  exchanges: number;
  /** Roughly how many characters each tool result carries. */
  toolOutputChars: number;
  /** How many of `FACTS` to plant. Capped at the list length. */
  facts: number;
}

/**
 * Build one conversation.
 *
 * The facts are spread EVENLY across the filler rather than clustered, because
 * "the summary kept the first thing and dropped the rest" and "the summary kept
 * a random third of it" are different failures and only spread facts can tell
 * them apart. Nothing is planted in the first exchange or the last third — the
 * head and tail anchors preserve those verbatim, so a fact there would be
 * recalled for free.
 */
export function buildConversation(opts: BuildOptions): BenchConversation {
  const facts = FACTS.slice(0, Math.min(opts.facts, FACTS.length));
  const messages: ModelMessage[] = [];
  const needles: Needle[] = [];

  // The opening message is the head anchor: it states the task, which is what
  // a real first message does and what the anchor exists to preserve.
  messages.push(
    userMsg(
      'I need help finishing the billing refactor. I will feed you pieces of it as we go.',
    ),
  );

  // The summarized region is [1, 2/3 of the conversation). Plant inside it.
  const plantableEnd = Math.floor(opts.exchanges * 0.6);
  const spacing = Math.max(1, Math.floor((plantableEnd - 1) / (facts.length + 1)));

  let nextFact = 0;
  for (let i = 0; i < opts.exchanges; i++) {
    messages.push(...fillerExchange(i, opts.toolOutputChars));
    const plantHere =
      nextFact < facts.length && i >= (nextFact + 1) * spacing && i < plantableEnd;
    if (plantHere) {
      const fact = facts[nextFact]!;
      messages.push(
        userMsg(fact.statement),
        assistantMsg('Got it — noted.'),
      );
      needles.push({
        id: `fact-${nextFact}`,
        question: fact.question,
        gold: fact.gold,
        marker: fact.marker,
        unanswerable: false,
        depth: messages.length - 2,
      });
      nextFact++;
    }
  }

  for (const [i, absent] of ABSENT.entries()) {
    needles.push({
      id: `absent-${i}`,
      question: absent.question,
      gold: absent.gold,
      unanswerable: true,
    });
  }

  return {
    name: `billing-refactor-${opts.exchanges}x${opts.toolOutputChars}`,
    messages,
    needles,
  };
}

/** The question turn appended after compaction, phrased to allow abstention. */
export function questionMessage(question: string): ModelMessage {
  return userMsg(
    `${question}\n\n(Answer from this conversation only. If it does not contain ` +
      `the answer, say "I don't know" rather than guessing.)`,
  );
}
