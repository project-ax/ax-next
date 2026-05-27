/** Reconstruct a skill's SKILL.md from its split storage (manifest + body).
 * Matches SkillEditor / orchestrator byte-for-byte. */
export function reconstructSkillMd(manifestYaml: string, bodyMd: string): string {
  return (
    '---\n' +
    manifestYaml +
    (manifestYaml.endsWith('\n') ? '' : '\n') +
    '---\n' +
    bodyMd
  );
}

export type DiffLineType = 'context' | 'add' | 'remove';
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** Line-level LCS diff. `before`/`after` are whole-file strings. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'remove', text: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) {
    out.push({ type: 'remove', text: a[i]! });
    i++;
  }
  while (j < n) {
    out.push({ type: 'add', text: b[j]! });
    j++;
  }
  return out;
}

export type BundleFileStatus = 'added' | 'removed' | 'modified' | 'unchanged';
export interface BundleFileEntry {
  path: string;
  status: BundleFileStatus;
  before: string | null; // current catalog content, null if newly added
  after: string | null; // submitted content, null if removed
}

/** Compare two path→contents maps. Result is sorted by path. */
export function compareBundles(
  before: Record<string, string>,
  after: Record<string, string>,
): BundleFileEntry[] {
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  return paths.map((path) => {
    const b = Object.prototype.hasOwnProperty.call(before, path) ? before[path]! : null;
    const a = Object.prototype.hasOwnProperty.call(after, path) ? after[path]! : null;
    let status: BundleFileStatus;
    if (b === null) status = 'added';
    else if (a === null) status = 'removed';
    else status = a === b ? 'unchanged' : 'modified';
    return { path, status, before: b, after: a };
  });
}
