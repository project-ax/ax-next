import type { RecallEngine, RecallResult } from "./recall.js";
import {
  DEFAULT_DISPOSITION,
  DEFAULT_EVIDENCE_ROWS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  INFINITY_SENTINEL,
  estimateTokens,
  memoryStatement,
  type DispositionProfile,
  type EpistemicNetwork,
  type GenerateFn,
  type MemoryTuple,
  type RecallOptions,
} from "../types.js";

export interface CompiledEvidence {
  table: string;
  rows: MemoryTuple[];
  tokens: number;
}

const NETWORK_TAG: Record<EpistemicNetwork, string> = {
  world: "FACT",
  experience: "FACT",
  observation: "OBS",
  opinion: "OPIN",
};

const MS_PER_DAY = 86_400_000;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function utcMidnight(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Months between two dates, fractional — whole calendar months plus the leftover expressed
 * as a fraction of the month it lands in.
 *
 * Counting only whole months rounds everything down (56 days would read "1 month"); dividing
 * days by an average month length drifts on February. This does neither.
 */
function monthsBetween(from: Date, to: Date): number {
  const whole =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) -
    (to.getUTCDate() < from.getUTCDate() ? 1 : 0);
  const advanced = Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + whole, from.getUTCDate());
  const next = Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + whole + 1, from.getUTCDate());
  const span = (next - advanced) / MS_PER_DAY;
  const remainder = (utcMidnight(to) - advanced) / MS_PER_DAY;
  return span > 0 ? whole + remainder / span : whole;
}

/**
 * How far `fromIso` sits from the reference time `toIso`, in the unit a person would use.
 *
 * The answerer runs at minimal reasoning effort and cannot reliably subtract two ISO strings,
 * so the elapsed time is computed here and handed to it as text. The unit ladder matters:
 * LongMemEval gold answers are phrased "3 weeks ago" / "5 months", so 20 days has to render
 * as weeks and 154 days as months for the answer to match.
 */
export function relativeTime(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "";

  const days = Math.round((utcMidnight(to) - utcMidnight(from)) / MS_PER_DAY);
  if (days === 0) return "today";
  const past = days > 0;
  const magnitude = Math.abs(days);

  let span: string;
  if (magnitude < 14) {
    span = plural(magnitude, "day");
  } else if (magnitude < 56) {
    // Up to eight weeks people still count in weeks ("3 weeks ago"); past that, months.
    span = plural(Math.round(magnitude / 7), "week");
  } else {
    const months = Math.round(monthsBetween(past ? from : to, past ? to : from));
    // Months stay the unit up to two years — deliberately, so "12 months ago" rather than
    // "1 year ago": months are what these questions ask for ("how many months ago did I...").
    if (months < 24) {
      span = plural(months, "month");
    } else {
      const years = Math.floor(months / 12);
      const remainder = months % 12;
      span =
        remainder === 0
          ? plural(years, "year")
          : `${plural(years, "year")} ${plural(remainder, "month")}`;
    }
  }
  return past ? `${span} ago` : `in ${span}`;
}

/**
 * The "When" cell: the date a statement became true, its weekday, and — when a reference
 * time is known — how long before that reference it was.
 *
 * This deliberately replaces the raw bi-temporal interval. "2023-11-01 to infinity" reads as
 * storage bookkeeping, and the answerer treated it as such: it refused questions about events
 * whose date was sitting in that column, reporting that the table "doesn't specify when".
 */
export function formatWhen(tuple: MemoryTuple, asOf?: string): string {
  const date = tuple.validStart.slice(0, 10);
  const weekday = WEEKDAY_SHORT[new Date(tuple.validStart).getUTCDay()] ?? "";
  const relative = asOf ? `, ${relativeTime(tuple.validStart, asOf)}` : "";
  const when = `${date} (${weekday}${relative})`;
  return tuple.validEnd === INFINITY_SENTINEL
    ? when
    : `${when} → superseded ${tuple.validEnd.slice(0, 10)}`;
}

export interface EvidenceRowOptions {
  asOf?: string;
}

export function evidenceTableRow(tuple: MemoryTuple, options: EvidenceRowOptions = {}): string {
  const statement = memoryStatement(tuple.subject, tuple.predicate, tuple.object);
  return `| [${NETWORK_TAG[tuple.network]}] | ${formatWhen(tuple, options.asOf)} | ${statement} |`;
}

export interface CompileEvidenceOptions {
  maxTokens?: number;
  /** Reference "now" used to render each row's elapsed time. */
  asOf?: string;
  /**
   * Render oldest-first instead of in rank order. Off by default: a "what is it now" question
   * reads the first row as the answer, and putting the oldest value there invites treating a
   * superseded value as current.
   */
  chronological?: boolean;
  /**
   * Append verbatim source dialogue for the top N ranked rows that have it.
   *
   * Extraction is lossy and terminal — a detail the extractor compressed out of a fact cannot
   * be recovered by any amount of retrieval depth. Measured at n=100 with a terse extractor,
   * 30 of 56 answerable failures had the gold nowhere in the bank. Excerpts are capped at the
   * TOP rows because they are expensive: they are charged against the same token budget as the
   * rows, so each one costs rows.
   */
  sourceExcerpts?: number;
}

/**
 * Verbatim dialogue behind the top-ranked rows, keyed by the statement so the model can tie an
 * excerpt to its row without needing row numbers in the table.
 */
function buildExcerptBlock(tuples: MemoryTuple[], limit: number): string {
  if (limit <= 0) return "";
  const lines: string[] = [];
  for (const tuple of tuples) {
    if (lines.length >= limit) break;
    if (!tuple.sourceChunk) continue;
    const statement = memoryStatement(tuple.subject, tuple.predicate, tuple.object);
    lines.push(`- [${statement}] "${tuple.sourceChunk}"`);
  }
  if (lines.length === 0) return "";
  return [
    "Source excerpts — the original wording behind the top rows above. A row is a summary and",
    "may have dropped a detail its excerpt still carries; prefer the excerpt when they differ.",
    ...lines,
  ].join("\n");
}

export function compileEvidenceTable(
  tuples: MemoryTuple[],
  options: CompileEvidenceOptions = {},
): CompiledEvidence {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const header = ["| Network | When | Statement |", "| :---- | :---- | :---- |"];
  // Excerpts come off the TOP of the ranked list and are fixed before rows are trimmed: they
  // are the reason this option exists, so rows pay for them rather than the other way round.
  const excerptBlock = buildExcerptBlock(tuples, options.sourceExcerpts ?? 0);

  const render = (rows: MemoryTuple[]): string =>
    [
      ...header,
      ...rows.map((tuple) =>
        evidenceTableRow(tuple, {
          ...(options.asOf ? { asOf: options.asOf } : {}),
        }),
      ),
      ...(excerptBlock ? ["", excerptBlock] : []),
    ].join("\n");

  // Trim by RANK: the tail of `tuples` is the least relevant. Ordering happens afterwards, so
  // that chronological presentation never costs us the top-ranked row.
  let included = tuples.length;
  while (included > 0 && estimateTokens(render(tuples.slice(0, included))) > maxTokens) {
    included -= 1;
  }

  const kept = tuples.slice(0, included);
  const rows = options.chronological
    ? [...kept].sort((a, b) => a.validStart.localeCompare(b.validStart) || a.id.localeCompare(b.id))
    : kept;
  const table = render(rows);

  return { table, rows, tokens: estimateTokens(table) };
}

const SKEPTICISM_GUIDANCE: Record<number, string> = {
  1: "accept the evidence table at face value",
  2: "generally trust the evidence table",
  3: "trust the evidence table but hedge where rows are thin or indirect",
  4: "require explicit confirmation from the table before asserting anything",
  5: "treat every claim as unverified unless the table states it outright; flag all uncertainty",
};

const LITERALISM_GUIDANCE: Record<number, string> = {
  1: "interpret questions loosely and allow reasonable inference from table content",
  2: "lean toward the plain meaning of the table",
  3: "answer from what the table says with only modest interpretation",
  4: "match questions to table wording closely; avoid interpretive leaps",
  5: "answer only what is written nearly verbatim in the table; paraphrase nothing",
};

const EMPATHY_GUIDANCE: Record<number, string> = {
  1: "be terse and purely factual",
  2: "be brief but courteous",
  3: "be clear and even-handed",
  4: "be warm and acknowledge the user's perspective",
  5: "be supportive and considerate of how the answer lands emotionally",
};

export interface ReflectPromptOptions {
  /** Reference "now". Without it the model has no way to resolve "last Saturday" or "how long ago". */
  asOf?: string;
}

export function buildReflectSystemPrompt(
  table: string,
  disposition: DispositionProfile = DEFAULT_DISPOSITION,
  options: ReflectPromptOptions = {},
): string {
  const clamp = (value: number): number => Math.min(5, Math.max(1, Math.round(value)));
  const asOfDate = options.asOf ? new Date(options.asOf) : null;
  const today =
    asOfDate && !Number.isNaN(asOfDate.getTime())
      ? `Today is ${options.asOf?.slice(0, 10)} (${WEEKDAY_LONG[asOfDate.getUTCDay()]}).`
      : null;

  return [
    "You are a memory-grounded assistant. Answer using ONLY the evidence table below.",
    ...(today
      ? [
          "",
          `${today} Resolve every relative expression in the question — "last Saturday", "how many`,
          '  weeks ago", "how long since" — against that date.',
        ]
      : []),
    "",
    "Operational directives:",
    "1. Ground all claims in the evidence table. Never invent entities, events, dates, or preferences.",
    "2. When the table contains evidence bearing on the question, answer DIRECTLY and concretely:",
    "   synthesize the relevant facts into a genuine answer — a recommendation, a summary, or an explanation.",
    "   Synthesizing table facts is grounding, not invention.",
    `3. Output exactly [DATA_ABSENT] ONLY when nothing in the table bears on the question.`,
    "   Do not hedge, deflect, or refuse when relevant evidence exists.",
    "4. Modulate your perspective using the agent's disposition ratings:",
    `   - Skepticism (S=${clamp(disposition.skepticism)}/5): ${SKEPTICISM_GUIDANCE[clamp(disposition.skepticism)]}`,
    `   - Literalism (L=${clamp(disposition.literalism)}/5): ${LITERALISM_GUIDANCE[clamp(disposition.literalism)]}`,
    `   - Empathy (E=${clamp(disposition.empathy)}/5): ${EMPATHY_GUIDANCE[clamp(disposition.empathy)]}`,
    "5. Single pass: answer once, in prose. Do not ask follow-up questions or request more evidence.",
    `6. The When column is when each statement became true: its date, that date's weekday${
      today ? ", and how long before today it was" : ""
    }.`,
    "   Every row is dated — do not claim a dated statement is undated. To compare two rows,",
    "   subtract their dates yourself; only the distance from today is precomputed.",
    "",
    "Evidence table:",
    table,
  ].join("\n");
}

export function createOpenAIAnswerer(
  options: { apiKey?: string; model?: string } = {},
): GenerateFn {
  return async ({ system, prompt }) => {
    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const provider = createOpenAI({ apiKey: options.apiKey });
    const { text } = await generateText({
      model: provider(options.model ?? process.env.DEM_GENERATE_MODEL ?? "gpt-4o-mini"),
      system,
      prompt,
    });
    return text;
  };
}

export interface ReflectResult {
  question: string;
  answer: string;
  abstained: boolean;
  evidence: MemoryTuple[];
  evidenceTable: string;
  tokens: number;
}

export interface ReflectEngineOptions {
  disposition?: DispositionProfile;
  maxContextTokens?: number;
  sourceExcerpts?: number;
}

export class ReflectEngine {
  private readonly disposition: DispositionProfile;
  private readonly maxContextTokens: number;
  private readonly sourceExcerpts: number;

  constructor(
    private readonly recallEngine: RecallEngine,
    private readonly generate: GenerateFn | null,
    options: ReflectEngineOptions = {},
  ) {
    this.disposition = options.disposition ?? DEFAULT_DISPOSITION;
    this.maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.sourceExcerpts = options.sourceExcerpts ?? 0;
  }

  async reflect(question: string, options: RecallOptions = {}): Promise<ReflectResult> {
    // `compileEvidenceTable` below trims by TOKEN BUDGET in rank order, so a caller can fill
    // the budget by passing a larger `limit` (see DEFAULT_EVIDENCE_ROW_CAP). The default stays
    // small because filling it was measured score-neutral at 1.93x the answer-prompt tokens.
    const recallResult: RecallResult = await this.recallEngine.recall(question, {
      ...options,
      limit: options.limit ?? DEFAULT_EVIDENCE_ROWS,
    });
    // A caller who time-travels to an anchor is asking "as of then" — that instant is the
    // epistemic present, so it doubles as the reference time when no explicit asOf is given.
    const asOf = recallResult.asOf ?? recallResult.temporalAnchor;
    const evidence = compileEvidenceTable(recallResult.tuples, {
      maxTokens: options.maxContextTokens ?? this.maxContextTokens,
      ...(options.sourceExcerpts !== undefined
        ? { sourceExcerpts: options.sourceExcerpts }
        : this.sourceExcerpts > 0
          ? { sourceExcerpts: this.sourceExcerpts }
          : {}),
      ...(asOf ? { asOf } : {}),
    });

    if (evidence.rows.length === 0) {
      return {
        question,
        answer: "[DATA_ABSENT]",
        abstained: true,
        evidence: [],
        evidenceTable: evidence.table,
        tokens: evidence.tokens,
      };
    }

    const system = buildReflectSystemPrompt(evidence.table, this.disposition, {
      ...(asOf ? { asOf } : {}),
    });
    const answer = this.generate
      ? await this.generate({ system, prompt: question })
      : await createOpenAIAnswerer()({ system, prompt: question });

    return {
      question,
      answer,
      abstained: false,
      evidence: evidence.rows,
      evidenceTable: evidence.table,
      tokens: evidence.tokens,
    };
  }
}
