/**
 * RunWarning — "this run went without a connector", as one quiet line.
 *
 * A routine that went without a connector (its sign-in is missing or has
 * expired) still ran and finished. That is information for the person who owns
 * the agent, not a failure, so it is NOT drawn in the destructive register the
 * `error` line uses: muted text with a small warning mark in the project's
 * `warning` token — the same pairing `bits.tsx` uses for its trust line.
 *
 * UNTRUSTED TEXT. The host builds the sentence from connector names (which an
 * admin or a person authors), strips control / format / bidi characters and
 * caps it at 300 characters — but this still treats it as hostile: it is only
 * ever a React text node, never markup, never markdown. The full sentence is
 * also in `title`, because a list row truncates it to one line.
 *
 * The mark is decorative (`aria-hidden`); a visually hidden "Warning:" keeps
 * the line from reading as ordinary prose to a screen reader.
 */
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export function RunWarning({
  text,
  truncate = false,
  className,
}: {
  text: string;
  /** One line with an ellipsis (a list row). Off: wrap, so the whole sentence reads. */
  truncate?: boolean;
  /** Layout only. */
  className?: string;
}) {
  return (
    <span
      data-testid="routine-warning"
      title={text}
      className={cn(
        'flex min-w-0 items-start gap-1 text-[11.5px] text-muted-foreground',
        className,
      )}
    >
      <TriangleAlert aria-hidden="true" className="mt-[2px] size-3 shrink-0 text-warning" />
      <span className={cn('min-w-0', truncate ? 'truncate' : 'break-words')}>
        <span className="sr-only">Warning: </span>
        {text}
      </span>
    </span>
  );
}
