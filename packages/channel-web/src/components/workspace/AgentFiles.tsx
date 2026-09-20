/**
 * Files the agent has, in both of the places it keeps them.
 *
 * TWO TIERS, and the tab used to show only one of them — the wrong one.
 *
 *   - "Files" is the agent's DURABLE tier. Since TASK-164 it is the agent's cwd
 *     and HOME, which means a deliverable lands here when nobody said where.
 *     It is a real filesystem, so it is a TREE and you walk it. Until this
 *     change it was invisible in the UI: the hook that reads it had no
 *     consumer, so the one place a person would look for "what did my agent
 *     make me" was the one place it wasn't.
 *   - "Agent workspace" is the git-backed tier AX manages. It arrives as one
 *     flat listing, minus AX's own machinery (`.ax/`, `.claude/`, memory).
 *
 * They are separate sections rather than one merged list because they are
 * genuinely different things with different durability, and a merged list would
 * have to lie about one of them to look tidy.
 *
 * Read-only on purpose: these are the agent's outputs, and the useful question
 * here is "what did it produce", not "let me edit it". Editing belongs to
 * Memory, where the human genuinely is an author.
 *
 * WHAT THIS TAB WILL NOT DO IS GUESS. There are several different things an
 * empty middle can mean, and each one gets its own sentence:
 *
 *   - the listing failed        → an error, with a way to retry.
 *   - no backend for that tier  → "we cannot reach it", and retrying is
 *                                 pointless, so we do not offer a button that
 *                                 pretends otherwise.
 *   - the listing is loading    → "Loading", not "nothing yet".
 *   - the agent has written none → the empty state, which is the ONLY one that
 *                                 makes a claim about the agent.
 *
 * Collapsing any of the others into the last would tell someone their agent has
 * produced nothing when we simply did not look. That is design rule H7, and it
 * is why each section takes an error object rather than an `entries.length === 0`
 * shortcut. It is also why the two sections fail INDEPENDENTLY: one tier being
 * unreadable is not a reason to blank the other, which is a different backend
 * that may be perfectly fine.
 *
 * The durable tier used to have a fifth case, and it was a hedge: at the tier
 * root it could not tell "the agent wrote nothing" from "this deployment
 * stores nothing", so it said both out loud and said it could not tell which.
 * That was the honest thing to draw over a hook that answered one word for
 * both. The hook now answers them separately (TASK-403 — see the header of
 * `lib/user-files.ts`), so the hedge is gone and each half gets the plain
 * sentence it always deserved.
 *
 * Everything on screen here is AGENT-AUTHORED. Filenames arrive already fenced
 * by the server (`name`), the raw `path` is a key we never render, and bodies
 * are rendered either as markdown through the package's shared renderer — with
 * images off and no artifact widening — or as plain preformatted text.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  Loader2,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Markdown } from '@/components/Markdown';
import { useFileDownload } from '@/lib/file-download';
import { useIsCompact } from '@/lib/use-compact';
import { useAgentFiles } from '@/lib/workspace-files';
import { parentDirOf, useAgentUserFiles, type UserFileBody } from '@/lib/user-files';
import type { FileTier, WorkspaceFileBody } from '@/lib/workspace-api';
import { cn } from '@/lib/utils';
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

/**
 * One file's body, whichever tier it came from.
 *
 * The two tiers' body shapes agree on the three fields that decide what is
 * drawn — `path`, `body`, `clipped` — so one renderer serves both. That is not
 * a coincidence: the server decodes both through the same `decodeFileBody`, so
 * "this is not text" and "this was cut short" mean the same thing on each.
 */
function FileBodyView({ file }: { file: WorkspaceFileBody | UserFileBody }) {
  if (file.clipped === 'binary') {
    return (
      <p className="text-[13px] text-muted-foreground">
        This one isn&rsquo;t text — it might be an image, a PDF, or something
        else we can&rsquo;t show as words. It is still there; we just have
        nothing readable to put on the screen.
      </p>
    );
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
 * One rail row. A button because it does something; `title` carries the fenced
 * label so a truncated name is still readable on hover.
 *
 * `ref` is React 19's plain prop rather than a `forwardRef`, and only the
 * SELECTED row is ever handed one: coming back from the phone's viewer has to
 * put focus on the row it came from, and that row is the only one the list can
 * name. See the focus effect in `AgentFiles`.
 */
function RailRow({
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
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const Icon = kind === 'dir' ? Folder : FileText;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'flex items-center gap-2 truncate rounded-md px-2.5 py-2 text-left text-[13px]',
        selected
          ? 'bg-primary-soft text-primary'
          : 'text-muted-foreground hover:bg-muted',
      )}
    >
      <Icon size={13} className="shrink-0" />
      <span className="truncate">{label}</span>
      {kind === 'dir' && (
        <ChevronRight size={12} className="ml-auto shrink-0 opacity-60" />
      )}
    </button>
  );
}

/** A section's own status line. Never the whole page — see the header. */
function SectionNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 py-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

export function AgentFiles({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const durable = useAgentUserFiles(agentId);
  const governed = useAgentFiles(agentId);

  /**
   * Below `md` this tab shows ONE pane at a time (TASK-455).
   *
   * THE ARITHMETIC. The list is `w-[260px] shrink-0`; on a 390px phone that
   * leaves the viewer 130px, and a 130px column cannot hold a file. It is the
   * fourth fixed-width column in this shell and the one TASK-404 deliberately
   * skipped, because the other three collapse by hiding and this one cannot:
   * both halves are content somebody came here for.
   *
   * WHY DRILL-IN AND NOT A SHEET, which is what TASK-404 did for the rail. The
   * rail is *supplementary* — the conversation is the thing, the rail is beside
   * it, so putting the rail behind a trigger leaves the screen showing the
   * point of the page. Here the list IS the point until a file is open: with
   * the list behind a trigger, opening the Files tab would land on a blank pane
   * reading "Pick a file to read it." and a button, which is a dead end
   * dressed as a screen. List first, viewer on tap, a way back — the pattern
   * every phone file browser already taught the reader.
   *
   * A FOLDER IS NOT A DRILL-IN. Stepping into `reports/` re-lists in place and
   * stays on the list; only opening a FILE crosses to the viewer. Two different
   * motions that happen to be one tap each, and conflating them would put the
   * reader in the viewer every time they tried to navigate.
   */
  const compact = useIsCompact();
  /**
   * Whether the phone is on the viewer side. It is a PREFERENCE, not the
   * truth: `showViewer` below also requires something to actually be selected,
   * so any path that drops the selection — an agent switch, a tier swap —
   * returns to the list on its own rather than stranding the reader on a pane
   * with nothing in it and a back button.
   */
  const [drilledIn, setDrilledIn] = useState(false);

  /*
    One viewer, two possible sources. Selecting in one tier closes the other, so
    the heading over the body always names the tier the body came from — a
    viewer showing a governed-tier file under a durable-tier breadcrumb would
    be a receipt for the wrong thing.
  */
  const selectDurable = (path: string) => {
    governed.open(null);
    durable.openFile(path);
    setDrilledIn(true);
  };
  const selectGoverned = (path: string) => {
    durable.openFile(null);
    governed.open(path);
    setDrilledIn(true);
  };

  const durableSelected = durable.filePath;
  const governedSelected =
    governed.files.find((f) => f.path === governed.openPath) ?? null;

  const hasSelection = durableSelected !== null || governedSelected !== null;
  /*
    Above `md` BOTH are true and this whole branch is inert — the two-column
    layout is exactly what it always was. Below it they are complements, which
    is what makes "one pane at a time" a property of the expression rather than
    of two `useState`s that have to be kept agreeing.
  */
  const showViewer = !compact || (drilledIn && hasSelection);
  const showList = !compact || !showViewer;

  /*
    THE SELECTION SURVIVES THE TRIP BACK, deliberately. Going back clears the
    pane, not the file: the row you were reading is still the highlighted one
    when the list comes back, so "where was I" is answered by the screen. It is
    also what gives the focus effect below something to aim at.
  */
  const backToList = () => setDrilledIn(false);

  /*
    FOCUS FOLLOWS THE PANE. Each of these two taps UNMOUNTS the control that
    was clicked, so without this `document.activeElement` falls back to
    `<body>` and a keyboard or screen-reader user is dropped at the top of the
    document on every drill-in and every drill-out. Going in lands on the way
    out; coming back lands on the row you came from.

    `useLayoutEffect`, not `useEffect` (TASK-451): a passive effect runs as a
    task AFTER commit, leaving a real window in which the target is mounted and
    focusable while focus is still on `<body>`.

    Gated on a CHANGE in `showViewer` rather than on its value, so an unrelated
    re-render — a listing settling, a body arriving — cannot yank focus out of
    whatever the reader is doing. And gated on `compact`, so crossing `md` on a
    resize updates the latch without stealing focus: above `md` both panes are
    on screen and nothing was unmounted to need rescuing.
  */
  const backRef = useRef<HTMLButtonElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const wasShowingViewer = useRef(showViewer);
  useLayoutEffect(() => {
    if (wasShowingViewer.current === showViewer) return;
    wasShowingViewer.current = showViewer;
    if (!compact) return;
    (showViewer ? backRef.current : selectedRowRef.current)?.focus();
  }, [compact, showViewer]);

  /*
    A `missing` on the TIER ROOT is not an error any more, it is the empty
    state. The hook only reports `missing` once the tier itself resolved
    (`unavailable` is the answer when it did not), so at the root it means one
    thing: this agent has not written anything yet. Drawing that in a red alert
    next to a separate, identically-meant "hasn't put any files here yet" would
    be two spellings of one fact for the reader to reconcile.

    It is keyed off `error.path`, NOT off `dirPath`. `dirPath` only moves on a
    SUCCESSFUL listing, so after a failed step into `reports/` it still reads
    `''` — and this would then call that failure the root's and tell somebody
    their agent has written nothing while the root listing they are looking at
    lists files.
  */
  const durableRootEmpty =
    durable.error !== null &&
    durable.error.kind === 'missing' &&
    durable.error.path === '';
  const durableError = durableRootEmpty ? null : durable.error;

  /* The breadcrumb trail for wherever we are in the durable tier. */
  const crumbs: Array<{ label: string; path: string }> = [
    { label: 'Files', path: '' },
  ];
  if (durable.dirPath !== '') {
    let acc = '';
    for (const seg of durable.dirPath.split('/')) {
      acc = acc === '' ? seg : `${acc}/${seg}`;
      crumbs.push({ label: seg, path: acc });
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      {showList && (
        <div
          className={cn(
            'flex flex-col gap-4 overflow-y-auto px-3 pb-6',
            /*
              The 260px is the desktop column. On a phone the list is the whole
              screen instead, and the divider goes with the column it divided.
            */
            compact ? 'w-full' : 'w-[260px] shrink-0 border-r border-border',
          )}
        >
          {/* ---- the DURABLE tier: the agent's own working files ---- */}
          <div className="flex flex-col">
            <SectionLabel>Files</SectionLabel>

            {/*
              Hidden when the root read came back missing. `dirPath` is the last
              SUCCESSFUL listing, so a root read that 404s from inside a folder
              would leave a trail reading "Files / reports" over a note saying
              this agent has put nothing anywhere — two true sentences that
              cannot both be describing the same screen.
            */}
            {durable.dirPath !== '' && !durableRootEmpty && (
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
                            onClick={() => durable.openDir(c.path)}
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

            {durableError !== null ? (
              <div className="px-1.5">
                <Alert variant="destructive">
                  <AlertDescription className="flex flex-col items-start gap-2 text-[12.5px]">
                    <span>
                      {durableError.kind === 'unavailable'
                        ? /*
                            Now a fact, not a guess: the tier did not resolve at
                            all in this deployment. There is nothing to come back
                            for, so no button — an offer to retry would send
                            somebody hunting for something that was never there.
                          */
                          `This server isn’t set up to keep ${agentName}’s files, so there’s nothing for us to open.`
                        : durableError.kind === 'missing'
                          ? /*
                              A `missing` that got this far is about a folder we
                              walked into, not about the tier. The root's version
                              is the empty state and never reaches here.
                            */
                            `That folder isn’t here any more. It may have been renamed or deleted since we drew this list.`
                          : `We could not read ${agentName}’s files. Nothing was lost; we just could not look right now.`}
                    </span>
                    {durableError.kind !== 'unavailable' && (
                      /*
                        The two buttons do DIFFERENT things, which is why they
                        are not one handler with two labels.

                        "Try again" re-reads where we are, because the read is
                        what failed. "Go back" leaves — and it has to leave to
                        the missing path's PARENT, not to `dirPath`. `dirPath` is
                        the last successful listing, so when a folder we were
                        already standing in vanishes and we re-request it, they
                        are the same path: a reload would re-fetch the folder
                        that just 404'd and land on its own error, a button that
                        loops on the thing it offers to escape.
                      */
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={
                          durableError.kind === 'missing'
                            ? () => durable.openDir(parentDirOf(durableError.path) ?? '')
                            : durable.reload
                        }
                        disabled={durable.loading}
                      >
                        {durable.loading
                          ? 'Trying…'
                          : durableError.kind === 'missing'
                            ? 'Go back'
                            : 'Try again'}
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              </div>
            ) : durableRootEmpty ? (
              /*
                A 404 on the tier root. Same sentence as a root listing that came
                back empty, because it is the same fact — and `entries` is NOT
                consulted here, since a failed listing leaves the previous
                folder's rows in it.
              */
              <SectionNote>{agentName} hasn’t put any files here yet.</SectionNote>
            ) : durable.loading && durable.entries.length === 0 ? (
              <SectionNote>Loading&hellip;</SectionNote>
            ) : durable.entries.length === 0 ? (
              /*
                Reachable only after a listing that actually succeeded, which is
                what makes it safe to say something about the agent here.
              */
              <SectionNote>
                {durable.dirPath === ''
                  ? `${agentName} hasn’t put any files here yet.`
                  : 'This folder is empty.'}
              </SectionNote>
            ) : (
              <div className="flex flex-col gap-0.5">
                {durable.entries.map((e) => (
                  <RailRow
                    key={e.path}
                    label={e.name}
                    kind={e.kind}
                    selected={e.path === durableSelected}
                    {...(e.path === durableSelected ? { ref: selectedRowRef } : {})}
                    onClick={() =>
                      e.kind === 'dir' ? durable.openDir(e.path) : selectDurable(e.path)
                    }
                  />
                ))}
                {durable.truncated && (
                  <SectionNote>
                    Showing the first {durable.entries.length}. There are more
                    files in this folder than we list here.
                  </SectionNote>
                )}
              </div>
            )}
          </div>

          {/* ---- the GOVERNED tier: the git-backed workspace AX manages ---- */}
          <div className="flex flex-col">
            <SectionLabel>Agent workspace</SectionLabel>

            {governed.error !== null ? (
              <div className="px-1.5">
                <Alert variant="destructive">
                  <AlertDescription className="flex flex-col items-start gap-2 text-[12.5px]">
                    <span>
                      {governed.error.kind === 'unavailable'
                        ? `We can’t reach ${agentName}’s workspace right now. Its files are safe — this server just isn’t able to open them.`
                        : `We could not read ${agentName}’s workspace. Nothing was lost; we just could not look right now.`}
                    </span>
                    {governed.error.kind === 'failed' && (
                      // Disabled while the retry is in flight, so the click has a
                      // visible consequence. A button that looks idle after you
                      // press it reads as a button that did nothing.
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={governed.reload}
                        disabled={governed.loading}
                      >
                        {governed.loading ? 'Trying…' : 'Try again'}
                      </Button>
                    )}
                    {/*
                      The raw detail used to be printed here: `workspace /board → 401`,
                      `send message → 401`. It said nothing a reader could act on, and
                      a status code in a mono span is how someone learns their session
                      expired by reading a number. `lib/http.ts` logs it to the console
                      for operators instead (TASK-288).
                    */}
                  </AlertDescription>
                </Alert>
              </div>
            ) : governed.loading && governed.files.length === 0 ? (
              <SectionNote>Loading&hellip;</SectionNote>
            ) : governed.files.length === 0 ? (
              <SectionNote>{agentName} has not written anything yet.</SectionNote>
            ) : (
              <div className="flex flex-col gap-0.5">
                {governed.files.map((f) => (
                  <RailRow
                    key={f.path}
                    label={f.name}
                    kind="file"
                    selected={f.path === governed.openPath}
                    {...(f.path === governed.openPath
                      ? { ref: selectedRowRef }
                      : {})}
                    onClick={() => selectGoverned(f.path)}
                  />
                ))}
                {governed.truncated && (
                  /*
                    Said out loud rather than swallowed. A list that stops at 500
                    and says nothing is a list that claims the agent wrote 500
                    files.
                  */
                  <SectionNote>
                    Showing the first {governed.files.length}. {agentName} has more
                    files than we list here.
                  </SectionNote>
                )}
              </div>
            )}
          </div>
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
            THE ONLY WAY OUT, so it is not inside `FileViewer`'s branches.

            On a phone the list is unmounted while this pane is up, which makes
            this control the entire exit. Put it below with the body and a
            failed open — or one stuck on "Opening…" — would be a screen with an
            error on it and nothing to press. It sits ABOVE the filename row
            rather than in it for a second reason: that row already truncates the
            filename at 390px and the Download button owns its right end, so a
            third control there would be taking width from a name that has none
            to give.

            "Back", not "All files". Back can legitimately land you inside
            `reports/` — you can open a file from any folder, and the list
            returns to the folder you left it on — so a label naming the root
            would be wrong exactly when the reader is deepest and least sure
            where they are. "Back" is true at every depth, and it does not
            collide with the three other things on this surface already called
            Files (the tab, the durable section, the breadcrumb root).
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
            THE KEY IS ON THE COMPONENT, and it has to be. `FileViewer` owns the
            download's state — the in-flight ref and the failure sentence — and
            both belong to ONE file. Without a key React reuses the same instance
            across a file switch (both branches render a `FileViewer` at the same
            position), and that state comes with it: the sentence "we could not
            download that" ends up over a file whose download was never
            attempted, which is the same lie this tab spends its whole existence
            avoiding, just pointed at a smaller thing. Worse, the in-flight ref
            survives too, so the next file's first Download click is swallowed
            while its button says "Getting it…".

            `tier` is part of the key because the two tiers are different stores
            and a path can exist in both — `notes.md` in the workspace is not
            `notes.md` in the agent's HOME.

            `agentId` is part of it for completeness rather than for a bug you
            can reproduce today: both file hooks drop their selection when the
            agent changes, so this pane unmounts before an identical path under a
            different agent could ever reach it. That reset lives in another
            file, this key does not depend on it, and no test can tell the
            difference — which is exactly why it is written down instead of
            claimed.
          */}
          {durableSelected !== null ? (
            <FileViewer
              key={`${agentId}:user-files:${durableSelected}`}
              rawPath={durableSelected}
              label={durable.file?.name ?? basename(durableSelected)}
              agentId={agentId}
              agentName={agentName}
              tier="user-files"
              loading={durable.fileLoading}
              failed={durable.fileError !== null}
              file={durable.file}
            />
          ) : governedSelected !== null ? (
            <FileViewer
              key={`${agentId}:workspace:${governedSelected.path}`}
              rawPath={governedSelected.path}
              label={governedSelected.name}
              agentId={agentId}
              agentName={agentName}
              tier="workspace"
              loading={governed.openLoading}
              failed={governed.openError !== null}
              file={governed.openFile}
            />
          ) : (
            /*
              Desktop only, in practice. Below `md` this pane is not mounted
              until something IS selected, so nothing-selected shows the list —
              which is the answer this sentence was asking the reader to go find.
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
 * Takes the raw key ONLY to address the download with, and never renders it —
 * `label` is the fenced string, and that is what goes on the screen. Same
 * split, same reason, as everywhere else on this surface.
 *
 * THE DOWNLOAD IS OFFERED FOR EVERY FILE, including one whose body we could
 * not show. Those are the files that need it most: "this one isn't text" is
 * exactly what a PDF looks like here, and until now that sentence was the end
 * of the road. The two reads are independent — a body we could not render says
 * nothing about bytes we can fetch — so the affordance does not hide behind
 * the preview succeeding.
 */
function FileViewer({
  rawPath,
  label,
  agentId,
  agentName,
  tier,
  loading,
  failed,
  file,
}: {
  rawPath: string;
  label: string;
  agentId: string;
  agentName: string;
  tier: FileTier;
  loading: boolean;
  failed: boolean;
  file: WorkspaceFileBody | UserFileBody | null;
}) {
  const download = useFileDownload({ agentId, agentName, tier, path: rawPath });
  return (
    /*
      No key here any more. There used to be one on this div, and it was not
      enough once this component held state: a key on the OUTPUT remounts the
      DOM, while the hook above it keeps running with the previous file's
      download in it. The key that matters is on `<FileViewer>` at both call
      sites — one mechanism, at the level that actually resets.
    */
    <div>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="truncate font-mono text-[13px]" title={basename(label)}>
          {basename(label)}
        </span>
        <Badge variant="secondary" className="shrink-0">
          written by {agentName}
        </Badge>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto shrink-0"
          onClick={download.start}
          disabled={download.busy}
        >
          {/*
            `data-icon` is INERT against the Button this repo has installed —
            that one sizes and spaces icons itself, with `[&_svg]:size-4` and
            `gap-2`. It is written anyway because it is the shadcn convention
            the upstream Button reads, and because the two existing icon
            buttons in this codebase spell it the same way
            (`AuthoredSkillsSection`). One spelling now beats a migration
            later; if the Button is ever updated, nothing here needs finding.
          */}
          <Download data-icon="inline-start" />
          {download.busy ? 'Getting it…' : 'Download'}
        </Button>
      </div>
      <div className="mb-5 truncate text-[12.5px] text-muted-foreground" title={label}>
        {label}
      </div>

      {/*
        A FIFTH THING, kept apart from the other four. This tab already tells
        "the listing failed", "no backend for this tier", "loading" and "the
        agent wrote nothing" apart, because collapsing any of them into another
        would make a claim about the agent that we cannot support. A download
        that did not happen is none of those — the file is listed, the body is
        on screen, and what failed is the handing-over. So it says so here, next
        to the button that did not work, and leaves the rest of the pane alone.
      */}
      {download.error !== null && (
        <Alert variant="destructive" className="mb-5">
          <AlertTriangle />
          <AlertDescription>{download.error}</AlertDescription>
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
          <Loader2 size={13} className="animate-spin" />
          Opening&hellip;
        </div>
      ) : (
        <div className="max-w-[680px] rounded-lg border border-border bg-card p-6 shadow-sm">
          <FileBodyView file={file} />
        </div>
      )}
    </div>
  );
}
