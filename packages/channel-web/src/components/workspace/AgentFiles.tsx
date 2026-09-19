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
import {
  AlertTriangle,
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
import { useAgentFiles } from '@/lib/workspace-files';
import { useAgentUserFiles, type UserFileBody } from '@/lib/user-files';
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
 */
function RailRow({
  label,
  selected,
  kind,
  onClick,
}: {
  label: string;
  selected: boolean;
  kind: 'file' | 'dir';
  onClick: () => void;
}) {
  const Icon = kind === 'dir' ? Folder : FileText;
  return (
    <button
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

  /*
    One viewer, two possible sources. Selecting in one tier closes the other, so
    the heading over the body always names the tier the body came from — a
    viewer showing a governed-tier file under a durable-tier breadcrumb would
    be a receipt for the wrong thing.
  */
  const selectDurable = (path: string) => {
    governed.open(null);
    durable.openFile(path);
  };
  const selectGoverned = (path: string) => {
    durable.openFile(null);
    governed.open(path);
  };

  const durableSelected = durable.filePath;
  const governedSelected =
    governed.files.find((f) => f.path === governed.openPath) ?? null;

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
      <div className="flex w-[260px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border px-3 pb-6">
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
                      <BreadcrumbPage className="truncate">{c.label}</BreadcrumbPage>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="truncate hover:text-foreground"
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
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={durable.reload}
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

      <div className="flex-1 overflow-y-auto px-6 pb-8 pt-5">
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
          <p className="text-[13px] text-muted-foreground">
            Pick a file to read it.
          </p>
        )}
      </div>
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
        <span className="truncate font-mono text-[13px]">{basename(label)}</span>
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
      <div className="mb-5 truncate text-[12.5px] text-muted-foreground">
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
