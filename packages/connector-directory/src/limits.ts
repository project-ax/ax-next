/**
 * Every cap the directory sync enforces, as one named constant each.
 *
 * The registry is a third party: these exist to stop a hostile or broken one,
 * so they sit well above what the live registry measured on 2026-11-09 (see
 * `.claude/memory/decisions/2026-11-09-TASK-1100.md`). Lengths are UTF-16 code
 * units unless the name says bytes.
 */

// ── One stored listing ──────────────────────────────────────────────────────

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 500;
export const URL_MAX = 2048;
export const VERSION_MAX = 255;
/** A server name: the registry's own limit. */
export const ID_MAX = 200;
/** The same limit the connectors' `headerName` rule uses. */
export const KEY_HEADER_MAX = 64;

/** How many of one listing's remotes are looked at. */
export const MAX_REMOTES_CONSIDERED = 16;
/** How many of one remote's headers are looked at. */
export const MAX_HEADERS_CONSIDERED = 32;

// ── One sync ────────────────────────────────────────────────────────────────

/** Rows in the mirror; past it, NEW names are skipped (updates still apply). */
export const MAX_ROWS = 100_000;
/** Entries asked for per page (the registry's maximum). */
export const PAGE_LIMIT = 100;
/** Decoded body bytes read per page. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PAGES_PER_SYNC = 2_000;
/** The registry's own `nextCursor`, which we only ever send back. */
export const MAX_CURSOR_CHARS = 512;

export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * The wait before each retry of one page after a transient failure, in order:
 * one entry per retry, so a page is asked for at most three times. Waits
 * never outlast the run budget (they end when it does).
 */
export const PAGE_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 4_000]);
export const SYNC_BUDGET_MS = 30 * 60_000;
/** How far before the last checkpoint an incremental sync starts asking. */
export const WATERMARK_OVERLAP_MS = 10 * 60_000;

export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60_000;
export const DEFAULT_SYNC_INITIAL_DELAY_MS = 10_000;

export const DEFAULT_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
