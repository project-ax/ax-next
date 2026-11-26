import { useId, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../internal/cx.js';
import { fileIcon, formatFileSize, splitFileName } from '../internal/file.js';
import { Spinner } from '../internal/Spinner.js';

export type FileTileVariant = 'card' | 'row' | 'chip';
export type FileTileStatus = 'ready' | 'working' | 'failed';

export interface FileTileProps {
  // Untrusted text (a filename off someone's disk, an artifact title): only ever a text child and the title attribute.
  // Clamp a pathological length before it gets here: CSS truncation doesn't shorten what a screen reader reads.
  name: string;
  // card: a full-width bordered tile. row: borderless, renders its own `li`, so it goes straight inside a `List`.
  // chip: inline, two lines, capped at 280px (or its container).
  variant: FileTileVariant;
  // Bytes, shown first on the second line ("1.2 KB · detail").
  size?: number;
  // A media type ("image/png") or an extension ("PDF", ".csv") for the icon. Without it, the name's extension decides.
  kind?: string;
  // The rest of the second line: the artifact's type, "Ready to send", "Downloading…", a failure sentence.
  detail?: string;
  // Give a tile whose state changes while it is on screen a status: its second line becomes one persistent polite
  // live region, so "Downloading…" -> "Download started" is announced. Leave it off for a tile that never changes.
  // working: busy (spinner, aria-busy, clicks ignored, focus kept). failed: the detail is danger text and wraps.
  status?: FileTileStatus;
  // 0–100, drawn as a progress bar while working.
  progress?: number;
  // The primary action (open, download). The whole tile is one button named "{actionLabel} {name}"; without onOpen
  // the tile is not interactive.
  onOpen?: () => void;
  // Default "Open".
  actionLabel?: string;
  // Controls of the tile's own (remove, retry). They sit above the tile's click layer: clicking one never opens it.
  trailing?: ReactNode;
  // An image thumbnail in the icon slot. Decorative (the name already names it), loaded lazily, never a link.
  previewUrl?: string;
}

const BOX: Record<FileTileVariant, string> = {
  card: 'ax-flex ax-w-full ax-gap-md ax-rounded-lg ax-border ax-border-solid ax-bg-surface-raised ax-p-md',
  row: 'ax-flex ax-min-h-touch ax-gap-md ax-rounded-md ax-px-sm ax-py-sm',
  chip: 'ax-inline-flex ax-max-w-file-chip ax-min-h-touch ax-gap-sm ax-rounded-md ax-border ax-border-solid ax-bg-surface-raised ax-px-sm ax-py-xs ax-align-middle',
};

const BORDER: Record<'idle' | 'failed', string> = {
  idle: 'ax-border-line-border',
  failed: 'ax-border-status-danger',
};

const ICON_BOX: Record<FileTileVariant, string> = {
  card: 'ax-h-control-md ax-w-control-md',
  row: 'ax-h-control-md ax-w-control-md',
  chip: 'ax-h-control-sm ax-w-control-sm',
};

const ICON_TONE: Record<'idle' | 'failed', string> = {
  idle: 'ax-text-fg-muted',
  failed: 'ax-text-status-danger',
};

const NAME_TEXT: Record<FileTileVariant, string> = {
  card: 'ax-text-body-strong',
  row: 'ax-text-body-strong',
  chip: 'ax-text-subheading',
};

const META_TEXT: Record<FileTileVariant, string> = {
  card: 'ax-text-meta',
  row: 'ax-text-meta',
  chip: 'ax-text-caption',
};

// A failure sentence wraps: it is the only thing telling the person what went wrong, so it is never cut off.
const META_TONE: Record<'idle' | 'failed', string> = {
  idle: 'ax-truncate ax-text-fg-muted',
  failed: 'ax-break-words ax-text-status-danger',
};

// The ::after is the click layer, as in ListRow: absolutely positioned against the tile (the nearest positioned
// ancestor, so the button itself stays unpositioned), it covers the whole tile, and a hit on it IS a hit on the button.
// The focus ring is drawn on it, inset, so it outlines the tile.
const ACTION =
  'ax-block ax-w-full ax-min-w-none ax-m-none ax-p-none ax-border-0 ax-bg-transparent ax-text-left ax-font-sans ax-text-fg ' +
  'ax-cursor-pointer focus-visible:ax-outline-none after:ax-absolute after:ax-inset-none after:ax-content-empty ' +
  'focus-visible:after:ax-outline focus-visible:after:ax-outline-2 focus-visible:after:ax-outline-line-ring focus-visible:after:ax-outline-offset-inset';

const LAYER_RADIUS: Record<FileTileVariant, string> = {
  card: 'after:ax-rounded-lg',
  row: 'after:ax-rounded-md',
  chip: 'after:ax-rounded-md',
};

const PROGRESS =
  'ax-mt-xs ax-block ax-h-xs ax-w-full ax-appearance-none ax-overflow-hidden ax-rounded-full ax-border-0 ax-bg-muted ' +
  'progress-track:ax-bg-muted progress-fill:ax-rounded-full progress-fill:ax-bg-accent';

// Busy tiles stay focusable (a `disabled` attribute would drop focus to <body>), so the click is swallowed here.
function suppress(e: MouseEvent<HTMLButtonElement>) {
  e.preventDefault();
}

/**
 * A file or artifact: icon (or thumbnail), name, and a "size · detail" line. With `onOpen` the whole tile is one
 * button; `trailing` controls sit beside it and stay independently clickable. The name's stem truncates and its
 * extension always shows (`report-q3-final-really-fi….csv`), with the full name in the title attribute.
 *
 * Tab order is DOM order: the tile's button, then its trailing controls.
 */
export function FileTile({
  name,
  variant,
  size,
  kind,
  detail,
  status,
  progress,
  onOpen,
  actionLabel = 'Open',
  trailing,
  previewUrl,
}: FileTileProps) {
  const metaId = useId();
  const [stem, extension] = splitFileName(name);
  const tone = status === 'failed' ? 'failed' : 'idle';
  const working = status === 'working';
  const meta = [size === undefined ? null : formatFileSize(size), detail].filter(Boolean).join(' · ');

  let glyph: ReactNode;
  if (working) {
    glyph = <Spinner className="ax-h-lg ax-w-lg" />;
  } else if (previewUrl !== undefined) {
    glyph = (
      <img
        src={previewUrl}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="ax-block ax-h-full ax-w-full ax-object-cover"
      />
    );
  } else {
    const Icon = fileIcon(kind ?? extension);
    glyph = <Icon aria-hidden="true" focusable="false" className="ax-h-lg ax-w-lg" />;
  }

  // Phrasing content only: this sits inside the button. It is raised above the button's own click layer so a hover on
  // the name reaches it and shows the full name; a click on it is still a click on the button it sits in.
  const nameNode = (
    <span title={name} className="ax-relative ax-z-10 ax-flex ax-min-w-none">
      <span className="ax-min-w-none ax-truncate">{stem}</span>
      {extension ? <span className="ax-shrink-0 ax-whitespace-nowrap">{extension}</span> : null}
    </span>
  );

  const primary = onOpen ? (
    <button
      type="button"
      aria-label={`${actionLabel} ${name}`}
      aria-describedby={meta ? metaId : undefined}
      aria-busy={working ? true : undefined}
      aria-disabled={working ? true : undefined}
      onClick={working ? suppress : () => onOpen()}
      className={cx(ACTION, LAYER_RADIUS[variant], NAME_TEXT[variant])}
    >
      {nameNode}
    </button>
  ) : (
    <span className={cx('ax-block ax-min-w-none ax-text-fg', NAME_TEXT[variant])}>{nameNode}</span>
  );

  // Rendered whenever there is a status, even empty, so the live region is the same element across every change.
  const metaNode =
    meta || status !== undefined ? (
      <span
        id={metaId}
        data-part="meta"
        {...(status !== undefined ? { role: 'status' } : {})}
        className={cx('ax-block', META_TEXT[variant], META_TONE[tone])}
      >
        {meta}
      </span>
    ) : null;

  const box = (
    <div
      className={cx(
        'ax-relative ax-isolate ax-box-border ax-items-center ax-font-sans',
        BOX[variant],
        variant !== 'row' && BORDER[tone],
        onOpen && !working && 'hover:ax-bg-muted',
      )}
    >
      <span
        data-part="icon"
        className={cx(
          'ax-flex ax-shrink-0 ax-items-center ax-justify-center ax-overflow-hidden ax-rounded-md ax-bg-muted',
          ICON_BOX[variant],
          ICON_TONE[tone],
        )}
      >
        {glyph}
      </span>
      <div data-part="text" className="ax-flex ax-min-w-none ax-flex-1 ax-flex-col">
        {primary}
        {metaNode}
        {working && progress !== undefined ? (
          <progress max={100} value={Math.round(Math.min(100, Math.max(0, progress)))} aria-label={name} className={PROGRESS} />
        ) : null}
      </div>
      {trailing ? (
        <div data-part="trailing" className="ax-relative ax-z-10 ax-flex ax-shrink-0 ax-items-center ax-gap-xs">
          {trailing}
        </div>
      ) : null}
    </div>
  );

  if (variant === 'row') return <li className="ax-m-none ax-p-none ax-border-0 ax-list-none">{box}</li>;
  return box;
}
