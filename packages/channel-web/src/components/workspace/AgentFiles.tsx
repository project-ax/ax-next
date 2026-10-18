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
 * The list/viewer/phone machinery is `FileBrowser` (W3b), shared with a
 * project's files; this file owns the two tiers and the agent's sentences.
 *
 * Everything on screen here is AGENT-AUTHORED. Filenames arrive already fenced
 * by the server (`name`), the raw `path` is a key we never render, and bodies
 * are rendered either as markdown through the package's shared renderer — with
 * images off and no artifact widening — or as plain preformatted text.
 */
import { useCallback, useEffect } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { downloadFailureMessage } from '@/lib/file-download';
import { useAgentFiles } from '@/lib/workspace-files';
import { useAgentUserFiles } from '@/lib/user-files';
import { workspaceApi } from '@/lib/workspace-api';
import { SectionLabel } from './bits';
import {
  FileBrowser,
  FileListEmpty,
  FileListLoading,
  FileViewer,
  RailRow,
  SectionNote,
  type FileBrowserCopy,
} from './FileBrowser';

export function AgentFiles({
  agentId,
  agentName,
  onCount,
}: {
  agentId: string;
  agentName: string;
  onCount?: (count: number | null) => void;
}) {
  const durable = useAgentUserFiles(agentId);
  const governed = useAgentFiles(agentId);
  const count = durable.loading || governed.loading || durable.error || governed.error
    ? null : durable.entries.filter(entry => entry.kind === 'file').length + governed.files.length;
  useEffect(() => { onCount?.(count); }, [count, onCount]);

  const failure = useCallback((e: unknown) => downloadFailureMessage(e, agentName), [agentName]);

  /*
    The durable tier's sentences. `unavailable` is a fact, not a guess — the
    tier did not resolve at all in this deployment, so no retry is offered. A
    `missing` that reaches the list is about a folder we walked into; the
    root's version is the empty state.
  */
  const copy: FileBrowserCopy = {
    unavailable: `This server isn’t set up to keep ${agentName}’s files, so there’s nothing for us to open.`,
    missing: 'That folder isn’t here any more. It may have been renamed or deleted since we drew this list.',
    failed: `We could not read ${agentName}’s files. Nothing was lost; we just could not look right now.`,
    emptyRoot: `${agentName} hasn’t put any files here yet.`,
    truncated: (n) => `Showing the first ${n}. There are more files in this folder than we list here.`,
  };

  /*
    One viewer, two possible sources. Selecting in one tier closes the other, so
    the heading over the body always names the tier the body came from.
  */
  const governedSelected =
    governed.files.find((f) => f.path === governed.openPath) ?? null;

  return (
    <FileBrowser
      tree={durable}
      /*
        The key under the viewer: the tier is part of it because the two tiers
        are different stores and a path can exist in both, and the agent is
        part of it for completeness — both hooks drop their selection when the
        agent changes, so this pane unmounts first anyway.
      */
      treeKey={`${agentId}:user-files`}
      copy={copy}
      download={(path) => () => workspaceApi.downloadFile(agentId, 'user-files', path)}
      downloadFailure={failure}
      viewerBadge={`written by ${agentName}`}
      sectionLabel="Files"
      onBeforeOpenFile={() => governed.open(null)}
      extraViewer={
        governedSelected === null ? null : (
          <FileViewer
            key={`${agentId}:workspace:${governedSelected.path}`}
            label={governedSelected.name}
            badge={`written by ${agentName}`}
            loading={governed.openLoading}
            failed={governed.openError !== null}
            file={governed.openFile}
            download={() => workspaceApi.downloadFile(agentId, 'workspace', governedSelected.path)}
            downloadFailure={failure}
          />
        )
      }
      extraList={({ rowRef, drillIn }) => (
        /* ---- the GOVERNED tier: the git-backed workspace AX manages ---- */
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
                    // visible consequence.
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
                    No raw detail here (`workspace /board → 401`): `lib/http.ts`
                    logs it to the console for operators instead (TASK-288).
                  */}
                </AlertDescription>
              </Alert>
            </div>
          ) : governed.loading && governed.files.length === 0 ? (
            <FileListLoading />
          ) : governed.files.length === 0 ? (
            <FileListEmpty>{agentName} has not written anything yet.</FileListEmpty>
          ) : (
            <div className="flex flex-col gap-0.5">
              {governed.files.map((f) => (
                <RailRow
                  key={f.path}
                  label={f.name}
                  kind="file"
                  selected={f.path === governed.openPath}
                  {...(f.path === governed.openPath ? { ref: rowRef } : {})}
                  onClick={() => {
                    durable.openFile(null);
                    governed.open(f.path);
                    drillIn();
                  }}
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
      )}
    />
  );
}
