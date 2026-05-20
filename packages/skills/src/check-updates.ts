import { parseSkillManifest } from './manifest.js';
import type { SkillDetail, SkillsCheckForUpdatesOutput } from './types.js';

/**
 * Skill-source fetcher. The function takes a URL and returns a fetch-like
 * response shape (subset of the global fetch Response: `ok`, `status`, `text()`).
 * Injected at the call site so tests can hand in a stub; production wiring uses
 * `globalThis.fetch`.
 */
export interface FetchFn {
  (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/**
 * Compare the locally-stored skill against its declared `sourceUrl`.
 *
 * Returns:
 *   - `{ available: false, currentVersion }` if no sourceUrl is set.
 *   - `{ available: false, currentVersion, latestVersion }` if the fetched
 *     remote manifest's version is <= the stored version.
 *   - `{ available: true, currentVersion, latestVersion, latestSkillMd }` if
 *     the remote manifest declares a strictly higher version.
 *
 * Throws if the fetch errors, the remote body is missing the frontmatter
 * fence, or the remote manifest fails parsing. The admin-routes layer maps
 * these to HTTP 5xx (NOT a 200 with available:false — we want the operator
 * to see the failure, not silently treat it as "no update").
 */
export async function checkForUpdates(
  detail: SkillDetail,
  deps: { fetch: FetchFn },
): Promise<SkillsCheckForUpdatesOutput> {
  const currentVersion = detail.version;
  if (detail.sourceUrl === undefined) {
    return { available: false, currentVersion };
  }
  const r = await deps.fetch(detail.sourceUrl);
  if (!r.ok) {
    throw new Error(`skill-source-fetch-failed: ${detail.sourceUrl} returned ${r.status}`);
  }
  const text = await r.text();
  // Same fence regex as admin-routes splitSkillMd. Inline to avoid a
  // cross-file dep on a private helper.
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (m === null) {
    throw new Error(`skill-source-missing-frontmatter: ${detail.sourceUrl}`);
  }
  const parsed = parseSkillManifest(m[1] ?? '');
  if (!parsed.ok) {
    throw new Error(`skill-source-manifest-invalid: ${parsed.code}: ${parsed.message}`);
  }
  if (parsed.value.version <= currentVersion) {
    return { available: false, currentVersion, latestVersion: parsed.value.version };
  }
  return {
    available: true,
    currentVersion,
    latestVersion: parsed.value.version,
    latestSkillMd: text,
  };
}
