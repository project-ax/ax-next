/**
 * THE WORDS FOR A REPLY WHOSE FILES WERE NOT SAVED (TASK-720).
 *
 * The reply finished, but the host refused to save the files it changed, and
 * the runner undid them. By the time the person reads this the files are
 * already gone from the agent's workspace, so each sentence says that plainly:
 * what was not kept, why, and the one thing that might help.
 *
 * Own file for the reason `stop-copy.ts` is: tests assert on these sentences,
 * and reaching a string through a component file imports the component's world.
 *
 * WHAT THEY MAY SAY. One fixed sentence per code, and `Record<SaveRefusedCode,
 * …>` so the compiler notices a fourth. Never the host veto's own message —
 * that one is worded for the model (it names paths and says what to try) and
 * never crosses to a person (TASK-719). No codes, no blame.
 *
 * `storage-full` mirrors `STORAGE_FULL_RULES` (`lib/storage-full-copy.ts`):
 * only an admin can make room, so it says that rather than inventing a chore.
 * `too-large` carries the one number here because it is not an admin's to
 * change — it is the most one reply can save (the host's 100 MiB upload
 * budget), and "try smaller files" is useless without a sense of how small.
 * `refused` is the catch-all (a check on the host said no): it says only what
 * we know.
 */
import type { SaveRefusedCode } from '@/lib/save-refused';

export const SAVE_REFUSED_COPY: Record<SaveRefusedCode, string> = {
  'storage-full':
    "Your storage is full, so we couldn't save the files from this reply. An admin can make more room, then you can try again.",
  'too-large':
    "The files from this reply were too big to save in one go (over 100 MB), so we didn't keep them. Try again with smaller files, or fewer at a time.",
  refused: "We couldn't save the file changes from this reply, so we undid them.",
};
