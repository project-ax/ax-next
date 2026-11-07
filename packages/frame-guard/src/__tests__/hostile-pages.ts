// Pages that hurt the transform in ways that are not a matter of size alone.
// Kept apart from the tests so a child process (fixtures/run-page.ts) can build
// the same page the test describes.

/**
 * Twenty formatting elements, each with a big attribute made of quotes (written
 * out, a quote in an attribute is the six characters `&quot;`), closed by their
 * parent, then every `<div><span></div>` after that brings all twenty back. parse5
 * gives each copy the SAME attribute list, so the tree is small, but written out
 * every copy repeats it: 80 copies of 20 x 200 KiB of quotes (a 4 MiB page, 3 repeats) is
 * 16.8 million quotes, which the serializer turns into 100 MB of `&quot;` one
 * character at a time (a rope of 16.8 million strings, over half a gigabyte of heap).
 * Counting the quotes as one character each, the result looked like 16 MiB, which
 * is inside the output limit; it is 100 MiB (TASK-1082, second review, finding 1).
 */
export function escapeAmplification(totalBytes: number, repeats: number): string {
  const each = Math.floor((totalBytes - 2000) / 20);
  let page = '<div>';
  for (let i = 0; i < 20; i++) page += `<b x=${i} y='${'"'.repeat(each)}'>`;
  return `${page}</div>${'<div><span></div>'.repeat(repeats)}`;
}
