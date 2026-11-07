// Pages whose pass-1 output is a multiple of the page, because parse5 gives every rebuilt copy of a formatting
// element the SAME attribute list and each copy writes it out again. Plain JavaScript so a child process can run it
// without a loader (fixtures/pool-shape.mjs). Each page is at most 4 MiB as UTF-8, the most the content origin hands
// the transform.
const MiB = 1024 * 1024;
const CAP = 4 * MiB;

/**
 * `n` formatting elements with big plain attributes (nothing in them to escape, so the page and its output are
 * the same length per copy), closed by their parent, then `k` x `<div><span></div>`, each of which brings all `n`
 * back: the page is (k + 1) times its attributes once it is written out, and a second pass tokenizes all of it,
 * the attributes one character at a time.
 */
export function amplified(k = 3, n = 20, ch = 'a', budget = CAP - 4000) {
  const each = Math.floor(budget / n / Buffer.byteLength(ch));
  let page = '<div>';
  for (let i = 0; i < n; i++) page += `<b x=${i} y='${ch.repeat(each)}'>`;
  return `${page}</div>${'<div><span></div>'.repeat(k)}`;
}

/** The shapes the third review sent, by the name it gave them. Which of them come back refused is the test's to say. */
export const shapes = {
  amp1: () => amplified(1), // written out twice over
  amp2: () => amplified(2),
  amp3: () => amplified(3),
  amp2_x10: () => amplified(2, 10), // the review's: ten elements of 420 KB, written out three times, 12.6 MB for pass 2
  amp2_x40: () => amplified(2, 40),
  amp3_x50: () => amplified(3, 50),
  amp3_twobyte: () => amplified(3, 20, 'ā'), // two bytes a character in the page, one in the string
  // The most a page that is let through can be: half a heavy script, half attributes written out once more. 1.5 times the page.
  mixed: () => `<script>${'a=1;'.repeat(512 * 1024)}</script>${amplified(1, 20, 'a', 2 * MiB - 4000)}`,
  // The heaviest single tokens there are: 4 MiB of script, of text, of attribute value (a data URI), of comment.
  script4: () => `<!doctype html><script>${'a=1;'.repeat(CAP / 4 - 64)}</script>`,
  attr4: () => `<img src="data:image/png;base64,${'QUJD'.repeat(CAP / 4 - 64)}">`,
};
