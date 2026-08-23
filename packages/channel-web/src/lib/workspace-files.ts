/**
 * The Files tab's two reads: the listing, and whichever file is open.
 *
 * Shaped after `useActivityFeed` — same stale-request discipline, same rule
 * that an error is a state of its own and never collapses into "empty".
 * Rendering "has not written anything yet" over a failed listing is the exact
 * lie this surface exists to stop telling, so `files` is only ever meaningful
 * while `error` is `null`.
 *
 * Bodies are fetched ONE AT A TIME, on selection, and not cached. A workspace
 * can hold hundreds of files and megabytes of text; pulling all of it so the
 * reader can look at one document would be a strange way to save a round trip.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { userFacingMessage } from './http';
import { workspaceApi, WorkspaceApiError } from './workspace-api';
import type { WorkspaceFileBody, WorkspaceFileSummary } from './workspace-types';

/**
 * What went wrong, in the reader's language plus the raw detail.
 *
 * `unavailable` is a genuinely different sentence from `failed`: it means the
 * deployment is not running a workspace backend at all, so no amount of
 * retrying will produce a file. Telling someone to try again in that case
 * sends them hunting for something that was never going to be there.
 */
export interface FilesError {
  kind: 'unavailable' | 'failed';
  detail: string;
}

function toFilesError(e: unknown): FilesError {
  const detail = userFacingMessage(e, 'workspace-files');
  if (e instanceof WorkspaceApiError && e.status === 503) {
    return { kind: 'unavailable', detail };
  }
  return { kind: 'failed', detail };
}

export interface AgentFilesState {
  files: WorkspaceFileSummary[];
  /** `true` when the agent has more files than one listing carries. */
  truncated: boolean;
  loading: boolean;
  /** Separate from an empty `files`: "we could not read it" is not "there is nothing". */
  error: FilesError | null;

  /** The `path` of the row currently open, or `null`. */
  openPath: string | null;
  open: (path: string | null) => void;
  /** The open file's text. `null` while it is still being fetched. */
  openFile: WorkspaceFileBody | null;
  openLoading: boolean;
  openError: FilesError | null;

  reload: () => void;
}

export function useAgentFiles(agentId: string): AgentFilesState {
  const [files, setFiles] = useState<WorkspaceFileSummary[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FilesError | null>(null);

  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<WorkspaceFileBody | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  const [openError, setOpenError] = useState<FilesError | null>(null);

  /**
   * Bumped on every listing fetch. A response is applied only when it is still
   * the most recent request — a ref rather than a boolean because a third
   * request can land while a stale second is outstanding, and a boolean cannot
   * tell those apart. Same guard, and the same reason, as `useActivityFeed`.
   */
  const listRequest = useRef(0);
  const bodyRequest = useRef(0);

  const load = useCallback(() => {
    const id = ++listRequest.current;
    setLoading(true);
    void (async () => {
      try {
        const page = await workspaceApi.files(agentId);
        if (listRequest.current !== id) return;
        setFiles(page.files);
        setTruncated(page.truncated);
        setError(null);
      } catch (e) {
        if (listRequest.current !== id) return;
        // The list is NOT cleared on failure of a reload — but it is never
        // rendered while `error` is set, so a stale list cannot be mistaken
        // for a fresh one.
        setError(toFilesError(e));
      } finally {
        if (listRequest.current === id) setLoading(false);
      }
    })();
  }, [agentId]);

  useEffect(() => {
    // A new agent is a new workspace. Drop everything first so the previous
    // agent's file list is never on screen under this agent's name.
    setFiles([]);
    setTruncated(false);
    setError(null);
    setOpenPath(null);
    setOpenFile(null);
    setOpenError(null);
    load();
  }, [load]);

  useEffect(() => {
    if (openPath === null) {
      setOpenFile(null);
      setOpenError(null);
      setOpenLoading(false);
      return;
    }
    const id = ++bodyRequest.current;
    setOpenFile(null);
    setOpenError(null);
    setOpenLoading(true);
    void (async () => {
      try {
        const body = await workspaceApi.file(agentId, openPath);
        if (bodyRequest.current !== id) return;
        setOpenFile(body);
      } catch (e) {
        if (bodyRequest.current !== id) return;
        setOpenError(toFilesError(e));
      } finally {
        if (bodyRequest.current === id) setOpenLoading(false);
      }
    })();
  }, [agentId, openPath]);

  return {
    files,
    truncated,
    loading,
    error,
    openPath,
    open: setOpenPath,
    openFile,
    openLoading,
    openError,
    reload: load,
  };
}
