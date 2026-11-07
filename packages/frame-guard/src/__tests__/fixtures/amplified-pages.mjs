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
  // The heaviest single tokens there are: 4 MiB of script, of attribute value (a data URI).
  script4: () => `<!doctype html><script>${'a=1;'.repeat(CAP / 4 - 64)}</script>`,
  attr4: () => `<img src="data:image/png;base64,${'QUJD'.repeat(CAP / 4 - 64)}">`,
  // Many tokens of 20 to 40 KB, 4 MiB in all, of each kind parse5 builds a character at a time and the tree keeps.
  texts4: () => `<!doctype html>${`<p>${'w'.repeat(40_000)}</p>`.repeat(100)}`,
  comments4: () => `<!doctype html>${`<!--${'c'.repeat(40_000)}-->`.repeat(100)}`,
  // (Two names of different lengths on each tag: the tokenizer compares a new name with the ones before it on the tag, and
  // that reads two of the same length flat.)
  names4: () => `<!doctype html>${`<div a${'n'.repeat(20_000)} b${'n'.repeat(20_001)}>`.repeat(100)}`,
  // Text that is foster-parented in front of a table arrives in the tree by yet another call.
  fostered4: () => `<!doctype html><table>${`${'w'.repeat(40_000)}<i></i>`.repeat(100)}`,
  // Repeated <body> tags add their attributes to the first one: the values arrive by another way into the tree.
  bodies4: () => `<!doctype html><body>${Array.from({ length: 200 }, (_, i) => `<body a${i}='${'x'.repeat(20_000)}'>`).join('')}`,
  // The same tags with a quote for every character of the values: each goes out as `&quot;`, so the page is refused after
  // its FIRST parse and the second never reads it. What it needs is what the first parse holds of 4 MiB of attribute values
  // that were added to the first <body> a tag at a time.
  bodies4q: () => `<!doctype html><body>${Array.from({ length: 200 }, (_, i) => `<body a${i}='${'"'.repeat(20_000)}'>`).join('')}`,
};
