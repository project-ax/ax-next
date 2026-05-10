// Phase 1 type surface for @ax/memory-strata.
//
// Frontmatter shape mirrors the design doc's "Document Format" section,
// trimmed to fields the Observer + bootstrap actually populate. Later
// phases (Consolidator, Retriever) will add `supersedes`, `superseded_by`,
// `last_accessed`, `access_count`, `importance`, etc. as those processes
// land — they're not load-bearing today.

export type MemoryFileType =
  | 'system/agent'
  | 'system/user'
  | 'system/session'
  | 'inbox/observation';

/**
 * Canonical Strata frontmatter fields written by Phase 1. All timestamps
 * are ISO-8601 strings (UTC). Booleans are explicit so a missing value
 * never silently means "false".
 */
export interface MemoryFrontmatter {
  /** Slug-style id; for inbox observations a UUID; for system files a fixed name. */
  id: string;
  /** Discriminator. */
  type: MemoryFileType;
  /** When this file was first written. */
  created: string;
  /** Observer-assigned 0..1; bootstrap always writes 1.0. */
  confidence: number;
  /** Hot-tier files are pinned; inbox observations are not. */
  pinned: boolean;
  /** One-sentence summary; the Retriever will key off this in Phase 2. */
  summary: string;
  /** Free-form classification used by the Observer to bucket facts. */
  subject?: string;
  /** Loose category — entity / preference / decision / episode / general. */
  factType?: string;
  /** Conversation messages this fact was extracted from. */
  source_messages?: number;
  /** When the underlying event happened (may equal `created`). */
  event_time?: string;
  /** When this row was captured (always equals `created` for now). */
  recorded_at?: string;
  /** True when the Observer's LLM call exceeded its deadline. */
  late?: boolean;
}

/**
 * One Observer extraction. The Observer's LLM is asked to return a list
 * of these shapes (loosely — we coerce defensively). Each surviving
 * Observation lands in `inbox/<ISO>.md` after the sensitive-content gate
 * approves it.
 */
export interface Observation {
  fact: string;
  subject: string;
  factType: 'entity' | 'preference' | 'decision' | 'episode' | 'general';
  confidence: number;
}
