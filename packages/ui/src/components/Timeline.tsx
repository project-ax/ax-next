import { ArrowUpRight } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { Timestamp } from './Timestamp.js';

export interface TimelineProps {
  // Names the list for screen readers: usually the section's heading text.
  label: string;
  children: ReactNode;
}

// An ordered list: entries come newest first (or oldest first), and the order is part of what they say. role="list"
// because Safari/VoiceOver drops list semantics from an ol with list-style none.
export function Timeline({ label, children }: TimelineProps) {
  return (
    <ol role="list" aria-label={label} className="ax-m-none ax-p-none ax-list-none ax-font-sans">
      {children}
    </ol>
  );
}

// A link to the thing the entry is about. `label` is the whole accessible name: say which entry it belongs to
// ("See what it did, 5 min ago"), because a list of identical names tells people nothing.
export interface TimelineEntryAction {
  label: string;
  href: string;
  // Given the real click event: the caller decides whether to preventDefault (in-app routing). Never prevented here.
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export interface TimelineEntryProps {
  // A StatusMark, or a StatusBadge ("You", "Someone else"). Decorative marks go with sr-only words in `children`.
  mark: ReactNode;
  // What happened: plain text, clamped to two lines unless `full`. Anything the person must read whole goes in `detail`.
  children: ReactNode;
  // An extra line under the text, never clamped (a failure's reason).
  detail?: ReactNode;
  // Show `children` whole (line breaks kept) instead of clamping to two lines.
  full?: boolean;
  time: Date | string | number;
  // The moment the relative time counts from. Defaults to when the entry renders.
  now?: Date;
  action?: TimelineEntryAction;
}

const ACTION_BOX = 'ax-box-border ax-flex ax-h-control-sm ax-w-control-sm ax-shrink-0 ax-items-center ax-justify-center';

const LINK =
  ACTION_BOX +
  ' ax-rounded-md ax-text-fg-muted ax-no-underline hover:ax-bg-muted hover:ax-text-fg ' +
  'focus-visible:ax-outline focus-visible:ax-outline-2 focus-visible:ax-outline-offset-2 focus-visible:ax-outline-line-ring';

const TEXT: Record<'clamped' | 'full', string> = {
  clamped: 'ax-m-none ax-line-clamp-2 ax-break-words ax-whitespace-pre-wrap ax-text-body ax-text-fg',
  full: 'ax-m-none ax-break-words ax-whitespace-pre-wrap ax-text-body ax-text-fg',
};

/**
 * One entry in a `Timeline`: mark, text, time, and an optional link. The time is a `Timestamp` (relative, with the whole
 * date and time for screen readers and in its hover title), so entries need no separate hidden stamp. Without an action
 * an empty box holds its place, so the times line up down the list.
 */
export function TimelineEntry({ mark, children, detail, full = false, time, now, action }: TimelineEntryProps) {
  return (
    <li className="ax-m-none ax-box-border ax-flex ax-items-start ax-gap-md ax-py-sm">
      <div className="ax-flex ax-h-control-sm ax-shrink-0 ax-items-center">{mark}</div>
      <div className="ax-flex ax-min-w-none ax-flex-1 ax-flex-col">
        <p data-part="text" className={TEXT[full ? 'full' : 'clamped']}>
          {children}
        </p>
        {detail ? (
          <p data-part="detail" className="ax-m-none ax-break-words ax-whitespace-pre-wrap ax-text-meta ax-text-fg-muted">
            {detail}
          </p>
        ) : null}
      </div>
      <span className="ax-shrink-0 ax-whitespace-nowrap ax-pt-xs ax-text-caption ax-text-fg-muted">
        <Timestamp value={time} {...(now ? { now } : {})} />
      </span>
      {action ? (
        <a href={action.href} aria-label={action.label} title={action.label} className={LINK} onClick={action.onNavigate}>
          <ArrowUpRight aria-hidden="true" focusable="false" className="ax-h-lg ax-w-lg" />
        </a>
      ) : (
        <span aria-hidden="true" className={ACTION_BOX} />
      )}
    </li>
  );
}
