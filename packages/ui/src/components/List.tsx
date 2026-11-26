import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { createContext, useContext, useState, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { IconButton } from './IconButton.js';

export type ListDensity = 'comfortable' | 'compact';

export interface ListProps {
  // Names the list for screen readers: usually the section's heading text.
  label: string;
  density?: ListDensity;
  children: ReactNode;
}

const DensityContext = createContext<ListDensity>('comfortable');

// List owns the dividers: divide-y is a sibling selector (`> * ~ *`), so rows 2..n get a top border and the last row
// never has one after it. role="list" because Safari/VoiceOver drops list semantics from a ul with list-style none.
export function List({ label, density = 'comfortable', children }: ListProps) {
  return (
    <DensityContext.Provider value={density}>
      <ul
        role="list"
        aria-label={label}
        className="ax-m-none ax-p-none ax-list-none ax-font-sans ax-divide-y ax-divide-solid ax-divide-line-soft"
      >
        {children}
      </ul>
    </DensityContext.Provider>
  );
}

interface ListRowCommon {
  title: string;
  // One line under the title, muted (a Timestamp, "3 tools"). Under the click layer on actionable rows: see ListRowProps.
  meta?: ReactNode;
  // Up to two lines, clamped.
  description?: string;
  // Avatar, StatusMark, file icon. Decorative or labelled; under the click layer on actionable rows.
  leading?: ReactNode;
  // Buttons, a Switch, a toggle group, a row menu. Sits above the click layer, so it stays independently clickable.
  trailing?: ReactNode;
}

// The content renders below the row, inside the same li.
interface ExpandableBase {
  content: ReactNode;
  defaultOpen?: boolean;
}

// One primary action per row at most. An openable row (onOpen, or href with an optional onNavigate) keeps its title for
// that action, so expanding needs its own chevron button, named by `label` ("Show details for {title}"). A row with no
// action makes the title itself the expand toggle (named by the title), and the chevron is a decorative indicator, so
// `label` is not accepted there.
type ListRowAction =
  | { onOpen: () => void; href?: never; onNavigate?: never; expandable?: ExpandableBase & { label: string } }
  | {
      href: string;
      // The link's click handler, given the real click event: the caller decides whether to preventDefault (in-app
      // routing) and lets modifier clicks through. ListRow itself never prevents the default.
      onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
      onOpen?: never;
      expandable?: ExpandableBase & { label: string };
    }
  | { onOpen?: never; href?: never; onNavigate?: never; expandable?: ExpandableBase & { label?: never } };

/**
 * A row in a `List`. The title is the row's only primary control: a button (`onOpen`), a link (`href`, optionally
 * `onNavigate`), or, for a row with only `expandable`, the expand toggle. Its click layer covers the whole row box.
 *
 * - `meta`, `description` and `leading` sit under that layer on actionable rows: give them no interactive content
 *   (a link there can't be clicked, and a `Timestamp`'s hover title is covered). Controls go in `trailing`.
 * - Under `exactOptionalPropertyTypes`, pass a conditional action by spreading it, not as `onOpen={maybe}`:
 *   `<ListRow title={t} {...(canOpen ? { onOpen: () => open(id) } : {})} />`.
 */
export type ListRowProps = ListRowCommon & ListRowAction;

const ROW: Record<ListDensity, string> = {
  comfortable: 'ax-min-h-touch ax-gap-md ax-py-md',
  compact: 'ax-min-h-touch md:ax-min-h-none ax-gap-sm ax-py-xs',
};

const TITLE_TEXT: Record<ListDensity, string> = {
  comfortable: 'ax-text-body-strong',
  compact: 'ax-text-body',
};

const CONTENT: Record<ListDensity, string> = {
  comfortable: 'ax-px-sm ax-pb-md',
  compact: 'ax-px-sm ax-pb-sm',
};

// Shared by the button, the link and the expand-only toggle. The ::after is the stretched layer: absolutely positioned
// against the row (the nearest positioned ancestor, so the title itself must stay unpositioned), it covers the whole row
// and takes every click that doesn't land on trailing. Being the title's own pseudo-element, a hit on it IS a hit on the title, so the
// row hover underlines the title and the focus ring is drawn around the whole row, inset so a flush Card can't clip it.
// The title's overflow-hidden (truncate) doesn't clip the layer: its containing block is an ancestor of the title.
const ACTION =
  'ax-block ax-w-full ax-truncate ax-m-none ax-p-none ax-border-0 ax-bg-transparent ax-text-left ax-font-sans ax-text-fg ' +
  'ax-no-underline ax-cursor-pointer hover:ax-underline focus-visible:ax-outline-none ' +
  'after:ax-absolute after:ax-inset-none after:ax-content-empty after:ax-rounded-md ' +
  'focus-visible:after:ax-outline focus-visible:after:ax-outline-2 focus-visible:after:ax-outline-line-ring focus-visible:after:ax-outline-offset-inset';

// The row's own controls sit above the stretched layer. Their z-index only competes inside the row: the row box is
// isolated (its own stacking context), so a sticky header or overlay elsewhere on the page still paints over them.
const ABOVE = 'ax-relative ax-z-10 ax-flex ax-shrink-0 ax-items-center';

// Decorative chevron for a row whose title is the expand toggle: it sits under the click layer, so it toggles too. Its
// box matches the IconButton toggle's size, so chevrons line up across rows with and without an action.
const INDICATOR_BOX: Record<ListDensity, string> = {
  comfortable: 'ax-flex ax-h-control-md ax-w-control-md ax-shrink-0 ax-items-center ax-justify-center',
  compact: 'ax-flex ax-h-control-sm ax-w-control-sm ax-shrink-0 ax-items-center ax-justify-center',
};
const INDICATOR = 'ax-h-lg ax-w-lg ax-text-fg-muted';

// Tab order is DOM order: the title control, then trailing controls, then (openable rows only) the expand button.
export function ListRow({ title, meta, description, leading, trailing, expandable, onOpen, href, onNavigate }: ListRowProps) {
  const density = useContext(DensityContext);
  const [open, setOpen] = useState(expandable?.defaultOpen ?? false);
  const Chevron = open ? ChevronUp : ChevronDown;

  const titleClass = cx(ACTION, TITLE_TEXT[density]);
  let titleNode: ReactNode;
  if (onOpen) {
    titleNode = (
      <button type="button" title={title} className={titleClass} onClick={() => onOpen()}>
        {title}
      </button>
    );
  } else if (href !== undefined) {
    titleNode = (
      <a href={href} title={title} className={titleClass} onClick={onNavigate}>
        {title}
      </a>
    );
  } else if (expandable) {
    // Expand-only row: the whole row is one toggle (one Tab stop), named by the title, like a disclosure.
    titleNode = (
      <Collapsible.Trigger title={title} className={titleClass}>
        {title}
      </Collapsible.Trigger>
    );
  } else {
    titleNode = (
      <span title={title} className={cx('ax-block ax-truncate ax-text-fg', TITLE_TEXT[density])}>
        {title}
      </span>
    );
  }

  let toggle: ReactNode = null;
  if (expandable?.label !== undefined) {
    toggle = (
      <div className={ABOVE}>
        <Collapsible.Trigger asChild>
          <IconButton label={expandable.label} icon={Chevron} size={density === 'compact' ? 'sm' : 'md'} />
        </Collapsible.Trigger>
      </div>
    );
  } else if (expandable) {
    toggle = (
      <span className={INDICATOR_BOX[density]}>
        <Chevron aria-hidden="true" focusable="false" data-part="indicator" className={INDICATOR} />
      </span>
    );
  }

  const row = (
    <div className={cx('ax-relative ax-isolate ax-box-border ax-flex ax-items-center ax-px-sm', ROW[density])}>
      {leading ? <div className="ax-flex ax-shrink-0 ax-items-center">{leading}</div> : null}
      <div className="ax-flex ax-min-w-none ax-flex-1 ax-flex-col">
        {titleNode}
        {meta ? (
          <div data-part="meta" className="ax-truncate ax-text-meta ax-text-fg-muted">
            {meta}
          </div>
        ) : null}
        {description ? (
          <p data-part="description" className="ax-m-none ax-line-clamp-2 ax-break-words ax-text-meta ax-text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      {trailing ? <div className={cx(ABOVE, 'ax-gap-sm')}>{trailing}</div> : null}
      {toggle}
    </div>
  );

  const LI = 'ax-m-none ax-p-none ax-border-0';
  if (!expandable) return <li className={LI}>{row}</li>;
  return (
    <Collapsible.Root asChild open={open} onOpenChange={setOpen}>
      <li className={LI}>
        {row}
        <Collapsible.Content className={cx('ax-text-body ax-text-fg', CONTENT[density])}>{expandable.content}</Collapsible.Content>
      </li>
    </Collapsible.Root>
  );
}
