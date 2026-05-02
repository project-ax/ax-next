// ---------------------------------------------------------------------------
// Bundle author/committer verifier (Phase 3).
//
// Every commit reachable via `<baselineCommit>..HEAD` MUST be authored AND
// committed by `ax-runner`. The runner pod's GIT_AUTHOR_*/GIT_COMMITTER_*
// env (set by sandbox-k8s pod-spec) pins the identity at the source; this
// verifier is the host-side check that the pin held.
//
// Why both author AND committer: in git-land they can differ (rebase,
// cherry-pick, amend by a different person). For our turn-end bundle
// they MUST match — anything else means either:
//   1. Someone bypassed the pod-spec env (defense-in-depth check fires).
//   2. The runner is forwarding commits authored elsewhere (we don't
//      do that today; if we ever do, this check has to be relaxed
//      explicitly with a new contract — not by accident).
//
// Surface: this function operates against a scratch repo prepared by
// `prepareScratchRepo` (see bundler/scratch.ts) — that helper reconstructs
// the baseline state and loads the thin bundle. We're handed `repoPath`
// (where the scratch lives) and `baselineCommit` (the SHA to walk from);
// we run `git rev-list <baselineCommit>..HEAD` and verify each commit.
//
// Identity match is EXACT: the parser pulls the name field (the part
// before `<email>`) and string-compares to `ax-runner`. We do NOT
// substring-match (would let `evil-ax-runner` slip through) and we do
// NOT lowercase (the env pins exact case). The email is captured into
// the diagnostic but not part of the equality check — names are the
// authoritative identity anchor here.
// ---------------------------------------------------------------------------

import { runGit } from './git-spawn.js';

const EXPECTED_IDENTITY = 'ax-runner';

/**
 * Verify every commit in `<baselineCommit>..HEAD` is authored AND
 * committed by `ax-runner`. Throws if any commit fails the check.
 *
 * Caller owns the scratch repo (created via `prepareScratchRepo`).
 */
export async function verifyBundleAuthor(input: {
  repoPath: string;
  baselineCommit: string;
}): Promise<void> {
  const { repoPath, baselineCommit } = input;

  const range = `${baselineCommit}..HEAD`;
  const revList = await runGit(['rev-list', range], { cwd: repoPath });
  if (revList.code !== 0) {
    throw new Error(
      `git rev-list ${range} failed (exit=${revList.code}): ${revList.stderr}`,
    );
  }
  const oids = revList.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (oids.length === 0) {
    // Bundle range is empty (baseline == HEAD). The runner short-circuits
    // empty turns before sending, so this should be rare; tolerate.
    return;
  }

  for (const oid of oids) {
    const cat = await runGit(['cat-file', '-p', oid], { cwd: repoPath });
    if (cat.code !== 0) {
      throw new Error(
        `git cat-file -p ${oid} failed (exit=${cat.code}): ${cat.stderr}`,
      );
    }
    const { authorName, committerName } = parseAuthorCommitter(
      cat.stdout.toString('utf8'),
    );
    if (authorName !== EXPECTED_IDENTITY) {
      throw new Error(
        `bundle commit ${oid} has author=${JSON.stringify(authorName)}; expected ${EXPECTED_IDENTITY}`,
      );
    }
    if (committerName !== EXPECTED_IDENTITY) {
      throw new Error(
        `bundle commit ${oid} has committer=${JSON.stringify(committerName)}; expected ${EXPECTED_IDENTITY}`,
      );
    }
  }
}

/**
 * Parse the author + committer name out of a `git cat-file -p` blob.
 * Format (canonical):
 *   tree <oid>
 *   parent <oid>
 *   author <name> <<email>> <ts> <tz>
 *   committer <name> <<email>> <ts> <tz>
 *   <blank line>
 *   <message>
 *
 * The name is everything between `author ` (or `committer `) and the
 * ` <` that opens the email. Names with spaces are valid (`First Last`),
 * but cannot contain `<` (git escapes those during commit creation).
 *
 * Exported for unit testing without spawning git.
 */
export function parseAuthorCommitter(catFileBody: string): {
  authorName: string;
  committerName: string;
} {
  const lines = catFileBody.split('\n');
  let authorName = '';
  let committerName = '';
  for (const line of lines) {
    if (line.startsWith('author ')) {
      authorName = extractName(line.slice('author '.length));
    } else if (line.startsWith('committer ')) {
      committerName = extractName(line.slice('committer '.length));
    } else if (line.length === 0) {
      // First blank line ends the header block; message follows.
      break;
    }
  }
  return { authorName, committerName };
}

function extractName(rest: string): string {
  // `<name> <<email>> <ts> <tz>` — the name is everything before ` <`.
  const idx = rest.indexOf(' <');
  if (idx < 0) {
    // Malformed line — git produces well-formed output, but be defensive.
    return rest;
  }
  return rest.slice(0, idx);
}
