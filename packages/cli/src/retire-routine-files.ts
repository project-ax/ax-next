import { isAbsolute } from 'node:path';
import { retireRoutineFiles } from '@ax/workspace-git-core';

/** Runs without booting plugins, connecting to a DB, or consulting online quota. */
export async function runRetireRoutineFilesCommand({ argv, out = line => process.stdout.write(`${line}\n`), err = line => process.stderr.write(`${line}\n`) }: {
  argv: string[]; out?: (line: string) => void; err?: (line: string) => void;
}): Promise<number> {
  let repoRoot: string | undefined;
  let apply = false;
  let valid = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo-root' && repoRoot === undefined) repoRoot = argv[++i];
    else if (argv[i] === '--apply' && !apply) apply = true;
    else valid = false;
  }
  if (!valid || !repoRoot || !isAbsolute(repoRoot)) {
    err('usage: ax retire-routine-files --repo-root <absolute-root> [--apply] (host must be stopped)');
    return 2;
  }
  try {
    const result = await retireRoutineFiles({ repoRoot, dryRun: !apply, now: new Date() });
    out(JSON.stringify({ dryRun: !apply, ...result }));
    return result.failures.length ? 1 : 0;
  } catch {
    err('maintenance-failed');
    return 1;
  }
}
