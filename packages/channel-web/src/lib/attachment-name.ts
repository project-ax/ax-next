/**
 * attachment-name — one bound on how long a filename may be when it is drawn.
 *
 * This lived privately inside `components/workspace/WorkspaceAttachmentChip.tsx`
 * until TASK-431, which needed the same bound in `components/AttachmentChip.tsx`
 * — a component BOTH shells render (chat's transcript through `Thread.tsx`, the
 * agent view's through `AgentConversation.tsx`). A chat component reaching into
 * `components/workspace/` for it would have been the only import of that shape
 * in the tree, and the wrong direction besides: the workspace chip is the
 * specific one, the transcript chip the shared one. So it moved here, next to
 * `fence-line.ts`, which moved for the same reason and out of the same drawer
 * (invariant 4: one source of truth per concept).
 *
 * Not the same tool as `fenceLine`, and the difference matters. `fenceLine`
 * fences text arriving from across a trust boundary: it strips the characters
 * that let a string rewrite the surface it is drawn on, flattens whitespace,
 * and may return `null` when nothing legible survives. This is only a length
 * bound on a filename — it makes no claim about the CONTENT of the name and
 * removes nothing from it. Reach for `fenceLine` when the question is "can this
 * string lie about what it is"; reach for this when the question is "how long
 * may it be".
 */

/**
 * Filenames come off the person's own disk, so they can be any length at all.
 * `truncate` would hide the overflow visually while leaving the whole thing in
 * the accessibility tree and in the `aria-label` — a screen reader announcing
 * four hundred characters is its own kind of broken. Clamp first, then
 * truncate for the ordinary case.
 *
 * Deliberately its own constant rather than a shared one with
 * `FILE_LABEL_MAX_CHARS` or `CONVERSATION_TITLE_MAX_CHARS`, which happen to sit
 * at the same number today. They bound different things for different reasons
 * and are free to move apart.
 */
export const ATTACHMENT_NAME_MAX_CHARS = 120;

/**
 * The cap counts UTF-16 units, which is what `String.length` and every
 * `maxlength`-shaped bound downstream count, so a clamped name is bounded by
 * the number the constant says. Slicing by UTF-16 unit can land BETWEEN the two
 * halves of a surrogate pair, though, and a lone half is ill-formed UTF-16 —
 * out of a function whose whole job is "a name a person can read", that would
 * be a poor joke. So an orphaned leading half is dropped, costing at most one
 * character of an already-truncated name.
 */
export function clampAttachmentName(name: string): string {
  if (name.length <= ATTACHMENT_NAME_MAX_CHARS) return name;
  let head = name.slice(0, ATTACHMENT_NAME_MAX_CHARS - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}…`;
}
