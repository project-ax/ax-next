/**
 * Files the agent wrote, in the workspace it owns.
 *
 * Read-only on purpose: these are the agent's outputs, and the useful question
 * a human asks here is "what did it actually produce", not "let me edit it".
 * Editing belongs to Memory, where the human genuinely is an author.
 *
 * WHAT THIS TAB WILL NOT DO IS GUESS. There are four different things an empty
 * middle of this screen can mean, and each one gets its own sentence:
 *
 *   - the listing failed        → an error, with a way to retry.
 *   - no workspace backend      → "we cannot reach it", and retrying is
 *                                 pointless, so we do not offer a button that
 *                                 pretends otherwise.
 *   - the listing is loading    → "Loading", not "nothing yet".
 *   - the agent has written none → the empty state, which is the ONLY one of
 *                                 the four that makes a claim about the agent.
 *
 * Collapsing any of the first three into the fourth would tell someone their
 * agent has produced nothing when we simply did not look. That is design rule
 * H7, and it is why this component takes an error object rather than an
 * `files.length === 0` shortcut.
 *
 * Everything on screen here is AGENT-AUTHORED. Filenames arrive already fenced
 * by the server (`name`), the raw `path` is a key we never render, and bodies
 * are rendered either as markdown through the package's shared renderer — with
 * images off and no artifact widening — or as plain preformatted text.
 */
import { AlertTriangle, FileText, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { useAgentFiles } from '@/lib/workspace-files';
import type { WorkspaceFileBody } from '@/lib/workspace-api';
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

function FileBodyView({ file }: { file: WorkspaceFileBody }) {
  if (file.clipped === 'binary') {
    return (
      <p className="text-[13px] text-muted-foreground">
        This one isn&rsquo;t text — it might be an image, a PDF, or something
        else we can&rsquo;t show as words. It is still in the agent&rsquo;s
        workspace; we just have nothing readable to put on the screen.
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

export function AgentFiles({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const {
    files,
    truncated,
    loading,
    error,
    openPath,
    open,
    openFile,
    openLoading,
    openError,
    reload,
  } = useAgentFiles(agentId);

  if (error !== null) {
    return (
      <div className="flex flex-1 items-start justify-center p-6">
        <Alert variant="destructive" className="max-w-[520px]">
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>
              {error.kind === 'unavailable'
                ? `We can’t reach ${agentName}’s workspace right now. Its files are safe — this server just isn’t able to open them.`
                : `We could not read ${agentName}’s files. Nothing was lost; we just could not look right now.`}
            </span>
            {error.kind === 'failed' && (
              <Button variant="secondary" size="sm" onClick={reload}>
                Try again
              </Button>
            )}
            <span className="font-mono text-[11px] text-muted-foreground">
              {error.detail}
            </span>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (loading && files.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        Loading&hellip;
      </div>
    );
  }

  /*
    The only branch that makes a claim about the agent — and it is reachable
    only after a listing that actually succeeded.
  */
  if (files.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 px-6 py-10 text-center">
        <p className="text-[13.5px] text-muted-foreground">
          {agentName} has not written anything yet.
        </p>
        <p className="mx-auto max-w-[420px] text-[12.5px] leading-relaxed text-muted-foreground">
          When it writes a file in its own workspace, we will show it here.
        </p>
      </div>
    );
  }

  const selected = files.find((f) => f.path === openPath) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-border px-3 pb-6">
        <SectionLabel>Workspace</SectionLabel>
        <div className="flex flex-col gap-0.5">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => open(f.path)}
              title={f.name}
              className={cn(
                'flex items-center gap-2 truncate rounded-md px-2.5 py-2 text-left text-[13px]',
                f.path === openPath
                  ? 'bg-primary-soft text-primary'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <FileText size={13} className="shrink-0" />
              <span className="truncate">{f.name}</span>
            </button>
          ))}
        </div>
        {truncated && (
          /*
            Said out loud rather than swallowed. A list that stops at 500 and
            says nothing is a list that claims the agent wrote 500 files.
          */
          <p className="mt-3 px-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            Showing the first {files.length}. {agentName} has more files than we
            list here.
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8 pt-5">
        {selected === null ? (
          <p className="text-[13px] text-muted-foreground">
            Pick a file to read it.
          </p>
        ) : (
          <>
            <div className="mb-1 flex items-center gap-2.5">
              <span className="truncate font-mono text-[13px]">
                {basename(selected.name)}
              </span>
              <Badge variant="secondary" className="shrink-0">
                written by {agentName}
              </Badge>
            </div>
            <div className="mb-5 truncate text-[12.5px] text-muted-foreground">
              {selected.name}
            </div>

            {openError !== null ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription className="flex flex-col items-start gap-2">
                  <span>
                    We could not open that file. It may have been rewritten or
                    deleted since this list was drawn.
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {openError.detail}
                  </span>
                </AlertDescription>
              </Alert>
            ) : openLoading || openFile === null ? (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                Opening&hellip;
              </div>
            ) : (
              <div className="max-w-[680px] rounded-lg border border-border bg-card p-6 shadow-sm">
                <FileBodyView file={openFile} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
