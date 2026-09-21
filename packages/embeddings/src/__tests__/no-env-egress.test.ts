// The card's egress acceptance criterion, enforced instead of asserted.
//
// "Egress goes to fixed hosts through the existing egress lock with
// credential-store credentials; a test OR A REVIEW NOTE demonstrates there is
// no raw `fetch` + env-var path."
//
// A review note demonstrates it once, for one reviewer, on one day. These
// tests demonstrate it on every CI run, which matters because the failure mode
// is a future one-line convenience — `config.token ?? process.env.VERTEX_TOKEN`
// — added by someone debugging a credential-store problem at 2am and never
// taken out. That is not hypothetical: `@ax/web-tools` has exactly that line
// (`cfg.apiKey ?? process.env.ANTHROPIC_API_KEY`), and it got there the same
// honest way.
//
// The credential store is the ONLY source of egress credentials here, so that
// a deployment cannot accidentally acquire them from the host's environment —
// and since this package is what carries user memory off-cluster, "accidental"
// is doing a lot of work in that sentence.
//
// These read source text rather than behavior, which is unusual and
// deliberate: the property is "this code path does not exist", and you cannot
// write a behavioral test for the absence of a fallback you have not written.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBED_ENDPOINTS, RERANK_ENDPOINTS } from '../endpoints.js';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Every `.ts` file under `src/`, at any depth, excluding the test directory.
 *
 * RECURSIVE ON PURPOSE. The first version of this read only the top level,
 * which meant a future `src/drivers/vertex.ts` — exactly where a new provider
 * driver would go, and exactly the file most likely to reach for an env var —
 * would have been silently unchecked while every assertion here still passed
 * green. A guard with a blind spot over the code it is guarding is worse than
 * no guard, because it also stops anyone from looking.
 */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Source with line comments and block comments stripped, so prose about `process.env` does not trip us. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the package has no environment-variable egress path', () => {
  it('finds source files to check at all', () => {
    // Guards the guard: a glob that silently matches nothing would make every
    // assertion below vacuously true, which is the classic way a test like
    // this rots into decoration.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.map((f) => f.split('/').pop())).toEqual(
      expect.arrayContaining(['plugin.ts', 'remote.ts', 'endpoints.ts', 'validate.ts', 'wire.ts']),
    );
  });

  it.each(['process.env', 'process[', 'import.meta.env'])(
    'never reads %s in any source file',
    (needle) => {
      const offenders = sourceFiles().filter((file) => codeOf(file).includes(needle));
      expect(offenders).toEqual([]);
    },
  );

  it('spawns no processes and touches no filesystem', () => {
    // Not egress, but the same claim in the security note, and equally cheap
    // to keep honest.
    for (const needle of ['child_process', 'node:fs', "from 'fs'", 'require(']) {
      const offenders = sourceFiles().filter((file) => codeOf(file).includes(needle));
      expect(offenders, `${needle} should not appear in src/`).toEqual([]);
    }
  });
});

describe('every outbound URL is HTTPS to a host from the frozen table', () => {
  it('builds URLs only from `endpoint.host`, never from a config string', () => {
    // A `baseUrl` config field is a fetch-to-anywhere primitive wearing a
    // config's clothes: one compromised settings row and everyone's memory
    // flows to somebody else's endpoint. The hosts are a table and a
    // deployment picks a KEY.
    const remote = codeOf(join(SRC, 'remote.ts'));
    const urls = remote.match(/`https?:\/\/[^`]*`/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('`https://${endpoint.host}')).toBe(true);
    }
    // No plaintext HTTP anywhere, template or literal.
    expect(remote).not.toMatch(/http:\/\//);
  });

  it('declares exactly the two hosts the security note names', () => {
    // If a third host is added, this test fails and whoever added it has to
    // update SECURITY.md's "what leaves, and where to" table in the same
    // commit. That coupling is the entire point.
    expect(Object.values(EMBED_ENDPOINTS).map((e) => e.host)).toEqual([
      'us-central1-aiplatform.googleapis.com',
    ]);
    expect(Object.values(RERANK_ENDPOINTS).map((e) => e.host)).toEqual(['api.cohere.com']);
  });

  it('freezes the tables, so nothing can add a host at runtime', () => {
    expect(Object.isFrozen(EMBED_ENDPOINTS)).toBe(true);
    expect(Object.isFrozen(RERANK_ENDPOINTS)).toBe(true);
    for (const entry of Object.values(EMBED_ENDPOINTS)) expect(Object.isFrozen(entry)).toBe(true);
    for (const entry of Object.values(RERANK_ENDPOINTS)) expect(Object.isFrozen(entry)).toBe(true);
  });
});
