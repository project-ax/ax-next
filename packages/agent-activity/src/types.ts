/**
 * The "Right now" line: what an agent is doing, in one short phrase, right
 * this second.
 *
 * The whole surface is display vocabulary — no transport, storage, or runner
 * words leak into it (Invariant 1). An alternate implementation backed by a
 * stream of runner step events, or one that always answers `null` in a
 * headless deployment, produces exactly this shape.
 */

/**
 * A real count, reported by the tool itself, over a total the tool itself knew
 * before it started. Never estimated, never a percentage, never an ETA.
 */
export interface ActivityCounter {
  done: number;
  total: number;
  /** The thing being counted, as a human would say it. "messages". */
  unit: string;
}

/**
 * Which tier produced the phrase. These name *tiers*, not implementations.
 *
 * - `declared` — the agent said what it is doing. PARKED, never produced today
 *   (see `deriveActivity`); kept in the union because it is the tier vocabulary
 *   the surface is designed around and a consumer's switch should already
 *   handle it.
 * - `tool` — the tool manifest's `activityPhrase`. Deterministic and free.
 * - `trigger` — the human-authored label for what started this work, or the
 *   universal floor. Always resolves.
 */
export type ActivitySource = 'declared' | 'tool' | 'trigger';

export interface AgentActivity {
  /** "Reading email". Present tense, an activity, never an outcome. */
  phrase: string;
  counter: ActivityCounter | null;
  /** ISO 8601 instant the current stretch of work began. */
  startedAt: string;
  source: ActivitySource;
  /**
   * True once the stream of steps has gone quiet long enough that the phrase
   * stopped being a claim about the present. When this is true the `phrase`
   * is the system's own ("No activity for 4 minutes"), not the tier's —
   * `source` still names the tier the line had resolved to, for debugging.
   */
  stale: boolean;
}

/** What the currently-running tool contributes to the line. */
export interface DeriveToolInput {
  /** The tool manifest's `activityPhrase`. */
  phrase: string;
  /** The tool manifest's `countable` — becomes `counter.unit`. */
  countable?: string | undefined;
  /**
   * What the TOOL reported about its own progress. Absent means no counter —
   * we never estimate one, and we never infer a total from anything the tool
   * did not state before it started.
   */
  reported?: { done: number; total: number } | undefined;
}

export interface DeriveInput {
  /** T1. Null when no tool is running or the tool carries no phrase. */
  tool: DeriveToolInput | null;
  /** T0. A human-authored label ("Morning email pass"), or null. */
  trigger: string | null;
  /** Epoch ms this stretch of work began. */
  startedAt: number;
  /** Epoch ms of the most recent step. Staleness is measured from here. */
  lastStepAt: number;
  /** Epoch ms "now" — injected, so the derivation is pure and testable. */
  now: number;
}

export interface AgentActivityGetInput {
  agentId: string;
}

export interface AgentActivityGetOutput {
  activity: AgentActivity | null;
}
