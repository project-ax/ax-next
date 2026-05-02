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
// Identity match is EXACT on BOTH name AND email. We do NOT
// substring-match (would let `evil-ax-runner` slip through) and we do
// NOT lowercase (the env pins exact case). Checking the email closes
// a spoofing gap: a compromised sandbox that bypasses the pod-spec
// env could fake the name with a different email; pinning both
// matches the full pod-spec identity (GIT_AUTHOR_NAME +
// GIT_AUTHOR_EMAIL pair).
// ---------------------------------------------------------------------------

import { runGit } from './git-spawn.js';

const EXPECTED_NAME = 'ax-runner';
const EXPECTED_EMAIL = 'ax-runner@example.com';

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
    const { authorName, authorEmail, committerName, committerEmail } =
      parseAuthorCommitter(cat.stdout.toString('utf8'));
    if (authorName !== EXPECTED_NAME || authorEmail !== EXPECTED_EMAIL) {
      throw new Error(
        `bundle commit ${oid} has author=${JSON.stringify(authorName + ' <' + authorEmail + '>')}; expected ${EXPECTED_NAME} <${EXPECTED_EMAIL}>`,
      );
    }
    if (
      committerName !== EXPECTED_NAME ||
      committerEmail !== EXPECTED_EMAIL
    ) {
      throw new Error(
        `bundle commit ${oid} has committer=${JSON.stringify(committerName + ' <' + committerEmail + '>')}; expected ${EXPECTED_NAME} <${EXPECTED_EMAIL}>`,
      );
    }
  }
}

/**
 * Parse the author + committer name + email out of a `git cat-file -p`
 * blob. Format (canonical):
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
 * The email is everything between `<` and `>`.
 *
 * Exported for unit testing without spawning git.
 */
export function parseAuthorCommitter(catFileBody: string): {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
} {
  const lines = catFileBody.split('\n');
  let authorName = '';
  let authorEmail = '';
  let committerName = '';
  let committerEmail = '';
  for (const line of lines) {
    if (line.startsWith('author ')) {
      const parsed = extractIdent(line.slice('author '.length));
      authorName = parsed.name;
      authorEmail = parsed.email;
    } else if (line.startsWith('committer ')) {
      const parsed = extractIdent(line.slice('committer '.length));
      committerName = parsed.name;
      committerEmail = parsed.email;
    } else if (line.length === 0) {
      // First blank line ends the header block; message follows.
      break;
    }
  }
  return { authorName, authorEmail, committerName, committerEmail };
}

function extractIdent(rest: string): { name: string; email: string } {
  // `<name> <<email>> <ts> <tz>` — split at ` <` (name end) and `>`
  // (email end).
  const lt = rest.indexOf(' <');
  if (lt < 0) {
    // Malformed — git produces well-formed output, but be defensive.
    return { name: rest, email: '' };
  }
  const name = rest.slice(0, lt);
  const afterLt = rest.slice(lt + 2);
  const gt = afterLt.indexOf('>');
  if (gt < 0) {
    return { name, email: '' };
  }
  const email = afterLt.slice(0, gt);
  return { name, email };
}
