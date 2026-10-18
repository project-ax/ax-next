/**
 * One browsable tree of files: a list (with a breadcrumb) beside a viewer, and
 * on a phone one pane at a time with a way back.
 *
 * Extracted from `AgentFiles` (W3b) so a project's folder and an agent's
 * durable tier are drawn by the SAME code. What differs between them is passed
 * in, and nothing else:
 *
 *   - the data, as a `FileTreeState` (`useFileTree` over a reader);
 *   - the words — empty, unavailable, failed — so a project's browser never
 *     names an agent and the agent's tab keeps every sentence it had;
 *   - where a download's bytes come from, as a thunk per path.
 *
 * `AgentFiles` also hangs its second, flat tier (the governed workspace) off
 * the `extraList` / `extraViewer` slots; the project browser has none.
 *
 * Everything on screen here is AGENT-AUTHORED. Filenames arrive already fenced
 * by the server (`name`), the raw `path` is a key we use to address things and
 * never render as a name, and bodies are rendered either as markdown through
 * the package's shared renderer — with images off and no artifact widening —
 * or as plain preformatted text.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Markdown } from '@/components/Markdown';
import { useDownload, type DownloadThunk } from '@/lib/file-download';
import { formatBytes } from '@/lib/storage-copy';
import { useIsCompact } from '@/lib/use-compact';
import { parentDirOf, type FileTreeState, type UserFileBody } from '@/lib/user-files';
import type { WorkspaceFileBody } from '@/lib/workspace-api';
import { cn } from '@/lib/utils';
import { fenceLine } from '@/lib/fence-line';
import { SectionLabel } from './bits';

/**
 * Which bodies get rendered as a document rather than as source.
 *
 * Deliberately just markdown. A `.py` or a `.json` rendered through a markdown
 * parser is not "nicely formatted", it is quietly mangled — lines silently
 * joined into paragraphs, `#` comments promoted to headings. Source is shown
 * as source.
 */
function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/** The last path segment, for the viewer's heading. */
function basename(name: string): string {
  const cut = name.lastIndexOf('/');
  return cut === -1 ? name : name.slice(cut + 1);
}

const AGENT_BINARY_COPY = (
  <>
    This one isn&rsquo;t text — it might be an image, a PDF, or something
    else we can&rsquo;t show as words. It is still there; we just have
    nothing readable to put on the screen.
  </>
);

/**
 * One file's body, whichever tree it came from.
 *
 * The body shapes agree on the three fields that decide what is drawn —
 * `path`, `body`, `clipped` — so one renderer serves every tree. That is not a
 * coincidence: the server decodes them all through the same `decodeFileBody`,
 * so "this is not text" and "this was cut short" mean the same thing on each.
 */
export function FileBodyView({
  file,
  binaryCopy = AGENT_BINARY_COPY,
}: {
  file: WorkspaceFileBody | UserFileBody;
  binaryCopy?: ReactNode;
}) {
  if (file.clipped === 'binary') {
    return <p className="text-[13px] text-muted-foreground">{binaryCopy}</p>;
  }
  const body = file.body ?? '';
  return (
    <>
      {file.clipped === 'too-large' && (
        <Alert className="mb-4">
          <AlertDescription>
            This file is long, so we&rsquo;re showing the beginning of it. The
            rest is still there — we just stopped reading at a sensible place.
          </AlertDescription>
        </Alert>
      )}
      {body.trim().length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          This file is empty.
        </p>
      ) : isMarkdown(file.path) ? (
        <Markdown text={body} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted-foreground">
          {body}
        </pre>
      )}
    </>
  );
}

/**
 * One list row. A button because it does something; `title` carries the fenced
 * label so a truncated name is still readable on hover.
 *
 * `ref` is React 19's plain prop rather than a `forwardRef`, and only the
 * SELECTED row is ever handed one: coming back from the phone's viewer has to
 * put focus on the row it came from, and that row is the only one the list can
 * name. See the focus effect in `FileBrowser`.
 */
export function RailRow({
  label,
  selected,
  kind,
  onClick,
  ref,
}: {
  label: string;
  selected: boolean;
  kind: 'file' | 'dir';
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const Icon = kind === 'dir' ? Folder : FileText;
  return (
    <Button variant="ghost"
      ref={ref}
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'h-10 justify-start gap-2 overflow-hidden rounded-sm px-2.5 text-left text-[13px] font-normal max-md:h-11',
        selected
          ? 'bg-primary-soft text-primary'
          : 'text-muted-foreground hover:bg-muted',
      )}
    >
      <Icon size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {kind === 'dir' && (
        <ChevronRight size={12} className="ml-auto shrink-0 opacity-60" />
      )}
    </Button>
  );
}

/** A section's own status line. Never the whole page. */
export function SectionNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 py-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

export function FileListEmpty({ children }: { children: ReactNode }) {
  return <Empty className="p-3 md:p-3"><EmptyHeader><EmptyDescription>{children}</EmptyDescription></EmptyHeader></Empty>;
}

export function FileListLoading() {
  return <div className="space-y-2 py-2" aria-label="Loading files"><span className="sr-only">Loading…</span>{[0, 1, 2].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>;
}

/** The sentences a tree's list says, so no tree speaks in another's voice. */
export interface FileBrowserCopy {
  /** No backend for this tree in this deployment. No retry is offered. */
  unavailable: string;
  /** A listing that broke. Offered with "Try again". */
  failed: string;
  /** A folder we walked into (or a path we were sent to) that isn't there. */
  missing: string;
  /** The root, read successfully (or 404'd), with nothing in it. */
  emptyRoot: string;
  /** The first-N note under a cut-short listing. */
  truncated: (shown: number) => string;
  /** What a file that isn't text says in the viewer. */
  binary?: ReactNode;
}

/** What a row slot outside the tree needs to join the pane and focus logic. */
export interface FileBrowserSlotArgs {
  /** Spread onto the selected row (as `ref`) so focus can come back to it. */
  rowRef: RefObject<HTMLButtonElement | null>;
  /** Cross to the viewer — call it when a row outside the tree opens a file. */
  drillIn: () => void;
}

export function FileBrowser({
  tree,
  treeKey,
  copy,
  download,
  downloadFailure,
  viewerBadge,
  sectionLabel,
  showTrail = true,
  onOpenDir,
  onOpenFile,
  onBeforeOpenFile,
  drillOnFile = false,
  extraList,
  extraViewer = null,
}: {
  tree: FileTreeState;
  /**
   * Names the tree, for the viewer's key: one file's download state must never
   * survive onto another tree's file at the same path.
   */
  treeKey: string;
  copy: FileBrowserCopy;
  /** Where a file's bytes come from, by raw path. */
  download: (path: string) => DownloadThunk;
  downloadFailure: (e: unknown) => string;
  /** A small label beside the open file's name ("written by Scout"). */
  viewerBadge?: string;
  /** A heading over the tree's rows. */
  sectionLabel?: string;
  /** The list's own folder trail. Off when the page already draws one. */
  showTrail?: boolean;
  /** Override navigation (the project browser routes it through the URL). */
  onOpenDir?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  /** Called before a tree file opens — `AgentFiles` closes its other tier. */
  onBeforeOpenFile?: () => void;
  /** On a phone, go to the viewer whenever a file opens, however it opened. */
  drillOnFile?: boolean;
  /** More list sections, under the tree's. */
  extraList?: (args: FileBrowserSlotArgs) => ReactNode;
  /** A viewer for something selected outside the tree; `null` when nothing is. */
  extraViewer?: ReactNode;
}) {
  const openDir = onOpenDir ?? tree.openDir;
  const openFile = onOpenFile ?? tree.openFile;

  /**
   * Below `md` this shows ONE pane at a time (TASK-455).
   *
   * THE ARITHMETIC. The list is `w-[260px] shrink-0`; on a 390px phone that
   * leaves the viewer 130px, and a 130px column cannot hold a file. Both halves
   * are content somebody came here for, so neither can hide behind a trigger:
   * list first, viewer on tap, a way back — the pattern every phone file
   * browser already taught the reader.
   *
   * A FOLDER IS NOT A DRILL-IN. Stepping into `reports/` re-lists in place and
   * stays on the list; only opening a FILE crosses to the viewer.
   */
  const compact = useIsCompact();
  /**
   * Whether the phone is on the viewer side. A PREFERENCE, not the truth:
   * `showViewer` also requires something to actually be selected, so any path
   * that drops the selection returns to the list on its own rather than
   * stranding the reader on a pane with nothing in it and a back button.
   */
  const [drilledIn, setDrilledIn] = useState(false);
  const drillIn = () => setDrilledIn(true);

  useEffect(() => {
    if (drillOnFile && tree.filePath !== null) setDrilledIn(true);
  }, [drillOnFile, tree.filePath]);

  const selectFile = (path: string) => {
    onBeforeOpenFile?.();
    openFile(path);
    setDrilledIn(true);
  };

  const selected = tree.filePath;
  const hasSelection = selected !== null || extraViewer !== null;
  /*
    Above `md` BOTH are true and this whole branch is inert. Below it they are
    complements, which is what makes "one pane at a time" a property of the
    expression rather than of two `useState`s that have to be kept agreeing.
  */
  const showViewer = !compact || (drilledIn && hasSelection);
  const showList = !compact || !showViewer;

  /*
    THE SELECTION SURVIVES THE TRIP BACK, deliberately. Going back clears the
    pane, not the file: the row you were reading is still the highlighted one
    when the list comes back, so "where was I" is answered by the screen.
  */
  const backToList = () => setDrilledIn(false);

  /*
    FOCUS FOLLOWS THE PANE. Each of these two taps UNMOUNTS the control that
    was clicked, so without this focus falls back to `<body>`. Going in lands on
    the way out; coming back lands on the row you came from.

    `useLayoutEffect` (TASK-451): a passive effect leaves a window in which the
    target is mounted while focus is still on `<body>`. Gated on a CHANGE in
    `showViewer`, so an unrelated re-render cannot yank focus, and on
    `compact`, so crossing `md` on a resize does not steal it.
  */
  const backRef = useRef<HTMLButtonElement>(null);
  /*
    ONE REF, HANDED TO WHICHEVER ROW IS SELECTED — the tree's or a slot's.
    `.current` can legitimately be null: the selected row is only rendered when
    the listing is showing rows, so the optional call below is what keeps a
    drill-out into an errored listing from throwing.
  */
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const wasShowingViewer = useRef(showViewer);
  useLayoutEffect(() => {
    if (wasShowingViewer.current === showViewer) return;
    wasShowingViewer.current = showViewer;
    if (!compact) return;
    (showViewer ? backRef.current : selectedRowRef.current)?.focus();
  }, [compact, showViewer]);

  /*
    A `missing` on the ROOT is not an error, it is the empty state: the hook
    reports `missing` only once the tree itself resolved (`unavailable` is the
    answer when it did not), so at the root it means nothing is here yet.

    Keyed off `error.path`, NOT `dirPath`: `dirPath` only moves on a SUCCESSFUL
    listing, so after a failed step into `reports/` it still reads `''`.
  */
  const rootEmpty =
    tree.error !== null && tree.error.kind === 'missing' && tree.error.path === '';
  const listError = rootEmpty ? null : tree.error;

  const crumbs: Array<{ label: string; path: string }> = [{ label: 'Files', path: '' }];
  if (tree.dirPath !== '') {
    let acc = '';
    for (const seg of tree.dirPath.split('/')) {
      acc = acc === '' ? seg : `${acc}/${seg}`;
      // The segment is a raw, agent-written name: fence it for display; the
      // raw path stays the navigation key.
      crumbs.push({ label: fenceLine(seg, 120) ?? '…', path: acc });
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      {showList && (
        <div
          className={cn(
            'flex flex-col gap-4 overflow-y-auto px-3 pb-6',
            compact ? 'w-full' : 'w-[260px] shrink-0 border-r border-border',
          )}
        >
          <div className="flex flex-col">
            {sectionLabel !== undefined && <SectionLabel>{sectionLabel}</SectionLabel>}

            {/*
              Hidden when the root read came back missing: a trail reading
              "Files / reports" over a note saying nothing is anywhere would be
              two true sentences that cannot describe the same screen.
            */}
            {showTrail && tree.dirPath !== '' && !rootEmpty && (
              <Breadcrumb className="mb-1.5 px-2.5">
                <BreadcrumbList className="text-[12px]">
                  {crumbs.map((c, i) => (
                    <BreadcrumbItem key={c.path}>
                      {i === crumbs.length - 1 ? (
                        /* Both crumbs carry `title`: a nested folder truncates to
                           nothing legible otherwise (TASK-436). */
                        <BreadcrumbPage className="truncate" title={c.label}>
                          {c.label}
                        </BreadcrumbPage>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="truncate hover:text-foreground"
                            title={c.label}
                            onClick={() => openDir(c.path)}
                          >
                            {c.label}
                          </button>
                          <BreadcrumbSeparator />
                        </>
                      )}
                    </BreadcrumbItem>
                  ))}
                </BreadcrumbList>
              </Breadcrumb>
            )}

            {listError !== null ? (
              <div className="px-1.5">
                <Alert variant="destructive">
                  <AlertDescription className="flex flex-col items-start gap-2 text-[12.5px]">
                    <span>
                      {listError.kind === 'unavailable'
                        ? copy.unavailable
                        : listError.kind === 'missing'
                          ? copy.missing
                          : copy.failed}
                    </span>
                    {listError.kind !== 'unavailable' && (
                      /*
                        "Try again" re-reads where we are, because the read is
                        what failed. "Go back" leaves — to the missing path's
                        PARENT, not to `dirPath`, which may be the very folder
                        that just vanished (a button that loops on the thing it
                        offers to escape).
                      */
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={
                          listError.kind === 'missing'
                            ? () => openDir(parentDirOf(listError.path) ?? '')
                            : tree.reload
                        }
                        disabled={tree.loading}
                      >
                        {tree.loading
                          ? 'Trying…'
                          : listError.kind === 'missing'
                            ? 'Go back'
                            : 'Try again'}
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              </div>
            ) : rootEmpty ? (
              /*
                A 404 on the root. Same sentence as a root listing that came back
                empty, because it is the same fact — and `entries` is NOT
                consulted, since a failed listing leaves the previous rows in it.
              */
              <FileListEmpty>{copy.emptyRoot}</FileListEmpty>
            ) : tree.loading && tree.entries.length === 0 ? (
              <FileListLoading />
            ) : tree.entries.length === 0 ? (
              <FileListEmpty>
                {tree.dirPath === '' ? copy.emptyRoot : 'This folder is empty.'}
              </FileListEmpty>
            ) : (
              <div className="flex flex-col gap-0.5">
                {tree.entries.map((e) => (
                  <RailRow
                    key={e.path}
                    label={e.name}
                    kind={e.kind}
                    selected={e.path === selected}
                    {...(e.path === selected ? { ref: selectedRowRef } : {})}
                    onClick={() => (e.kind === 'dir' ? openDir(e.path) : selectFile(e.path))}
                  />
                ))}
                {tree.truncated && <SectionNote>{copy.truncated(tree.entries.length)}</SectionNote>}
              </div>
            )}
          </div>

          {extraList?.({ rowRef: selectedRowRef, drillIn })}
        </div>
      )}

      {showViewer && (
        <div
          className={cn(
            'flex-1 overflow-y-auto pb-8 pt-5',
            // 48px of side padding out of 390px is a tenth of the screen.
            compact ? 'px-4' : 'px-6',
          )}
        >
          {/*
            THE ONLY WAY OUT on a phone, so it is not inside the viewer's
            branches: a failed open, or one stuck on "Opening…", must still have
            something to press. "Back", not "All files" — back can land inside
            `reports/`, so a label naming the root would be wrong exactly when
            the reader is deepest.
          */}
          {compact && (
            <Button
              ref={backRef}
              variant="ghost"
              size="sm"
              className="-ml-2 mb-3"
              onClick={backToList}
            >
              <ChevronLeft data-icon="inline-start" />
              Back
            </Button>
          )}
          {/*
            THE KEY IS ON THE COMPONENT: `FileViewer` owns the download's state,
            and both the failure sentence and the in-flight guard belong to ONE
            file. Without it React reuses the instance across a file switch and
            the last file's "we could not download that" lands on this one.
          */}
          {selected !== null ? (
            <FileViewer
              key={`${treeKey}:${selected}`}
              // The fenced name only: the loaded file's, else the listing's
              // entry. Never `selected` (the raw, agent-written path) — it may
              // carry bidi or control characters.
              label={tree.file?.name ?? tree.entries.find((e) => e.path === selected)?.name ?? ''}
              badge={viewerBadge}
              loading={tree.fileLoading}
              failed={tree.fileError !== null}
              file={tree.file}
              download={download(selected)}
              downloadFailure={downloadFailure}
              binaryCopy={copy.binary}
            />
          ) : extraViewer !== null ? (
            extraViewer
          ) : (
            /*
              Desktop only, in practice: below `md` this pane is not mounted
              until something IS selected.
            */
            <p className="text-[13px] text-muted-foreground">
              Pick a file to read it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The right-hand pane for whichever file is open.
 *
 * The raw key reaches it only inside `download` (the thunk addresses the
 * bytes); `label` is the fenced string, and that is what goes on the screen.
 *
 * THE DOWNLOAD IS OFFERED FOR EVERY FILE, including one whose body we could
 * not show — those are the files that need it most. The one exception is a
 * file the server has already said it won't hand over (`downloadable: false`,
 * a project file over the download limit): a button that can only fail is
 * worse than its size and a plain sentence.
 */
export function FileViewer({
  label,
  badge,
  loading,
  failed,
  file,
  download,
  downloadFailure,
  binaryCopy,
}: {
  label: string;
  badge?: string | undefined;
  loading: boolean;
  failed: boolean;
  file: WorkspaceFileBody | UserFileBody | null;
  download: DownloadThunk;
  downloadFailure: (e: unknown) => string;
  binaryCopy?: ReactNode;
}) {
  const dl = useDownload(download, downloadFailure);
  const tooBig = file !== null && 'downloadable' in file && file.downloadable === false;
  const size = file !== null && 'size' in file && typeof file.size === 'number' ? file.size : null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="truncate font-mono text-[13px]" title={basename(label)}>
          {basename(label)}
        </span>
        {badge !== undefined && (
          <Badge variant="secondary" className="shrink-0">
            {badge}
          </Badge>
        )}
        {tooBig ? (
          <span className="ml-auto shrink-0 text-[12.5px] text-muted-foreground">
            {size !== null ? `${formatBytes(size)} · ` : ''}Too big to download here
          </span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto shrink-0"
            onClick={dl.start}
            disabled={dl.busy}
          >
            <Download data-icon="inline-start" />
            {dl.busy ? 'Getting it…' : 'Download'}
          </Button>
        )}
      </div>
      {/* The label is the fenced display name (never the raw path, which may
          carry bidi or control characters), so it's drawn once; the
          breadcrumb shows where the file is. */}
      {label !== basename(label) ? (
        <div className="mb-5 truncate text-[12.5px] text-muted-foreground" title={label}>
          {label}
        </div>
      ) : (
        <div className="mb-4" />
      )}

      {/*
        A download that did not happen is its own thing: the file is listed,
        the body is on screen, and what failed is the handing-over. So it says
        so here, next to the button, and leaves the rest of the pane alone.
      */}
      {dl.error !== null && (
        <Alert variant="destructive" className="mb-5">
          <AlertTriangle />
          <AlertDescription>{dl.error}</AlertDescription>
        </Alert>
      )}

      {failed ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              We could not open that file. It may have been rewritten or
              deleted since this list was drawn.
            </span>
          </AlertDescription>
        </Alert>
      ) : loading || file === null ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner aria-hidden="true" className="size-3.5" />
          Opening&hellip;
        </div>
      ) : (
        <div className="max-w-[680px] rounded-lg border border-border bg-card p-6 shadow-sm">
          <FileBodyView file={file} binaryCopy={binaryCopy ?? AGENT_BINARY_COPY} />
        </div>
      )}
    </div>
  );
}
