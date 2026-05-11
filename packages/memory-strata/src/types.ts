// Type surface for @ax/memory-strata. Phase 1 introduced the core
// frontmatter + Observation shapes. Phase 2A widens MemoryFileType and
// adds DocFrontmatter / DocFile for promoted fact pages.
//
// Frontmatter shape mirrors the design doc's "Document Format" section,
// trimmed to fields the Observer + bootstrap actually populate. Later
// phases will add `last_accessed`, `access_count`, `importance`, etc.
// as those processes land — they're not load-bearing today.

export type MemoryFileType =
  | 'system/agent'
  | 'system/user'
  | 'system/session'
  | 'system/recent'
  | 'inbox/observation'
  | 'docs/entity'
  | 'docs/preference'
  | 'docs/decision'
  | 'docs/episode'
  | 'docs/general';

/** Subset of {@link MemoryFileType} covering promoted fact pages under `docs/`. */
export type DocFileType =
  | 'docs/entity'
  | 'docs/preference'
  | 'docs/decision'
  | 'docs/episode'
  | 'docs/general';

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
  /** One-sentence summary; future retrieval will key off this. */
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

/**
 * Frontmatter for a promoted `docs/<category>/<slug>.md` page. Written by
 * the Phase 2A merge process; extended by retrieval (Phase 2B) and the
 * Promoter (Phase 4). All timestamps are ISO-8601 strings (UTC).
 */
export interface DocFrontmatter {
  /** `<category>/<slug>` — globally addressable across the agent's docs tree. */
  id: string;
  type: DocFileType;
  created: string;
  updated: string;
  /** Running max of merged observations' confidence. */
  confidence: number;
  /** Phase 2A never auto-pins docs; see YAGNI ('Promoter' is Phase 4). */
  pinned: false;
  /** Initial value: first observation's `summary`; not LLM-rewritten in 2A. */
  summary: string;
  subject: string;
  factType: string;
  /** Inbox observation ids merged into this doc, in order. */
  source_observations: string[];
  supersedes?: string[];
  superseded_by?: string;
}

/**
 * A fully-parsed `docs/<category>/<slug>.md` file as returned by the
 * doc-store reader. Used internally by the Phase 2A merge process and
 * later by retrieval passes (Phase 2B+).
 */
export interface DocFile {
  /** Workspace-relative path. */
  path: string;
  frontmatter: DocFrontmatter;
  /** Raw body text (everything after the closing `---` line). */
  body: string;
}
