import { describe, expect, it } from 'vitest';
import * as limits from '../limits.js';

describe('connector-directory limits', () => {
  it('every cap is pinned', () => {
    expect({ ...limits }).toEqual({
      TITLE_MAX: 120,
      DESCRIPTION_MAX: 500,
      URL_MAX: 2048,
      VERSION_MAX: 255,
      ID_MAX: 200,
      KEY_HEADER_MAX: 64,
      MAX_REMOTES_CONSIDERED: 16,
      MAX_HEADERS_CONSIDERED: 32,
      MAX_ROWS: 100_000,
      PAGE_LIMIT: 100,
      MAX_PAGE_BYTES: 4 * 1024 * 1024,
      MAX_PAGES_PER_SYNC: 2_000,
      MAX_CURSOR_CHARS: 512,
      REQUEST_TIMEOUT_MS: 30_000,
      PAGE_RETRY_BACKOFF_MS: [1_000, 4_000],
      SYNC_BUDGET_MS: 30 * 60_000,
      WATERMARK_OVERLAP_MS: 10 * 60_000,
      DEFAULT_SYNC_INTERVAL_MS: 60 * 60_000,
      DEFAULT_SYNC_INITIAL_DELAY_MS: 10_000,
      DEFAULT_REGISTRY_URL: 'https://registry.modelcontextprotocol.io',
    });
  });
});
