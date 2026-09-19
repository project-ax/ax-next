/**
 * Browsing the agent's DURABLE user-files tier — its cwd and HOME.
 *
 * The sibling of `useAgentFiles`, and deliberately not the same hook. That one
 * reads the git-backed tier AX manages and gets a FLAT list back in one call.
 * This one reads the tier the agent actually works in, whose backing hook
 * answers ONE directory at a time — so this hook owns a cursor (which
 * directory are we in) and a history (how do we go back up), and it fetches
 * again on every step.
 *
 * Same discipline as its sibling on the thing that matters: an error is a state
 * of its own and never collapses into "empty". `entries` is only meaningful
 * while `error` is `null`.
 *
 * WHAT `missing` MEANS, and why it is its own kind. The backing hook still
 * answers ONE thing for every path-shaped absence — never written, since
 * deleted, resolved outside the agent's own subtree — and that collapse is
 * deliberate: on a mount that holds every tenant's subtree, a response that
 * distinguished a well-formed path from a missing one would be a way to map
 * somebody else's files. So `missing` means "the tier is there and that path
 * is not in it", and nothing finer.
 *
 * IT USED TO MEAN LESS THAN THAT. `absent` also covered "this deployment has
 * no durable tier at all", so at the tier root we could not tell "the agent
 * has written nothing" from "there is nothing to write to", and the tab said
 * both and said it could not tell which — on every deployment, working ones
 * included (TASK-403). The hook now answers `unavailable` for the no-tier
 * case, which costs no secrecy because it is decided before any path is looked
 * at and is therefore the same answer for every path. So a `missing` at the
 * root now means exactly one thing: the tier is wired, and this agent has not
 * written anything into it yet.
 *
 * AND A BROKEN READ IS `failed`, not either of the above. A realization whose
 * storage will not answer throws, the route turns that into a 5xx, and it
 * lands here as `failed` with a retry. "We could not look" must never be
 * spelled the same way as "there is nothing to see".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { userFacingMessage } from './http';
import { workspaceApi, WorkspaceApiError } from './workspace-api';
import type { UserFileEntry, UserFilesAnswer } from './workspace-types';

/**
 * What went wrong, in the reader's language plus the raw detail.
 *
 * Three kinds, because three different sentences are true:
 *
 *   - `unavailable` — this deployment keeps no durable files for this agent at
 *     all: no sandbox provider that can read the tier, or no tier resolved for
 *     the agent. Retrying will never help, so the UI offers no button.
 *   - `missing`     — the tier is there and this path is not in it. At the
 *     ROOT that is the agent having written nothing yet, which is not an error
 *     at all and the tab draws it as the empty state.
 *   - `failed`      — something broke. Retrying might help, so it gets a
 *     button.
 *
 * `path` rides along because the sentence depends on WHICH path failed, and
 * the hook's `dirPath` cannot answer that: it only moves on success, so after
 * a failed step into `reports/` it still reads `''`. A component that checked
 * `dirPath === ''` to recognise the root would call that failure the root's
 * and tell the reader their agent has written nothing, while the root listing
 * it is standing on says otherwise.
 */
export interface UserFilesError {
  kind: 'unavailable' | 'missing' | 'failed';
  /** The tier path the failed read asked for. `''` is the tier root. */
  path: string;
  detail: string;
}

function toUserFilesError(e: unknown, path: string): UserFilesError {
  const detail = userFacingMessage(e, 'user-files');
  if (e instanceof WorkspaceApiError) {
    if (e.status === 503) return { kind: 'unavailable', path, detail };
    if (e.status === 404) return { kind: 'missing', path, detail };
  }
  return { kind: 'failed', path, detail };
}

/** A file's text as this tier serves it. */
export type UserFileBody = Extract<UserFilesAnswer, { kind: 'file' }>;

export interface AgentUserFilesState {
  /** The directory currently listed. `''` is the tier root. */
  dirPath: string;
  entries: UserFileEntry[];
  /** `true` when the directory holds more children than one response carries. */
  truncated: boolean;
  loading: boolean;
  /** Separate from empty `entries`: "we could not read it" is not "there is nothing". */
  error: UserFilesError | null;

  /** Walk into a directory (or back to `''`, the root). */
  openDir: (path: string) => void;

  /** The `path` of the file currently open, or `null`. */
  filePath: string | null;
  openFile: (path: string | null) => void;
  file: UserFileBody | null;
  fileLoading: boolean;
  fileError: UserFilesError | null;

  reload: () => void;
}

export function useAgentUserFiles(agentId: string): AgentUserFilesState {
  const [dirPath, setDirPath] = useState('');
  const [entries, setEntries] = useState<UserFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UserFilesError | null>(null);

  const [filePath, setFilePath] = useState<string | null>(null);
  const [file, setFile] = useState<UserFileBody | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<UserFilesError | null>(null);

  /**
   * Bumped on every fetch; a response is applied only when it is still the most
   * recent request. A ref rather than a boolean because a third request can
   * land while a stale second is outstanding, and a boolean cannot tell those
   * apart. Same guard, same reason, as `useAgentFiles`.
   */
  const listRequest = useRef(0);
  const bodyRequest = useRef(0);

  const loadDir = useCallback(
    (path: string) => {
      const id = ++listRequest.current;
      setLoading(true);
      void (async () => {
        try {
          const answer = await workspaceApi.userFiles(agentId, path);
          if (listRequest.current !== id) return;
          if (answer.kind === 'file') {
            /*
              We asked for a directory and got a file. Not a crash and not a
              silent empty: the path is real, it is just not a folder, so open
              it as what it is rather than drawing an empty folder over it.
            */
            setFile(answer);
            setFilePath(answer.path);
            setFileError(null);
            setError(null);
            return;
          }
          setEntries(answer.entries);
          setTruncated(answer.truncated);
          setDirPath(answer.path);
          setError(null);
        } catch (e) {
          if (listRequest.current !== id) return;
          // `entries` is NOT cleared here — but it is never rendered while
          // `error` is set, so a stale listing cannot pass for a fresh one.
          setError(toUserFilesError(e, path));
        } finally {
          if (listRequest.current === id) setLoading(false);
        }
      })();
    },
    [agentId],
  );

  useEffect(() => {
    // A new agent is a new tier. Drop everything first, so the previous
    // agent's files are never on screen under this agent's name.
    setDirPath('');
    setEntries([]);
    setTruncated(false);
    setError(null);
    setFilePath(null);
    setFile(null);
    setFileError(null);
    loadDir('');
  }, [loadDir]);

  useEffect(() => {
    if (filePath === null) {
      setFile(null);
      setFileError(null);
      setFileLoading(false);
      return;
    }
    const id = ++bodyRequest.current;
    setFileError(null);
    setFileLoading(true);
    void (async () => {
      try {
        const answer = await workspaceApi.userFiles(agentId, filePath);
        if (bodyRequest.current !== id) return;
        if (answer.kind === 'dir') {
          // It turned into a directory between the listing and the click.
          // Navigate rather than render a file view over a folder.
          setFilePath(null);
          setEntries(answer.entries);
          setTruncated(answer.truncated);
          setDirPath(answer.path);
          return;
        }
        setFile(answer);
      } catch (e) {
        if (bodyRequest.current !== id) return;
        setFileError(toUserFilesError(e, filePath));
      } finally {
        if (bodyRequest.current === id) setFileLoading(false);
      }
    })();
  }, [agentId, filePath]);

  const openDir = useCallback(
    (path: string) => {
      // Walking into a folder closes whatever file was open: the viewer would
      // otherwise keep showing a file from a directory the reader has left.
      setFilePath(null);
      setFile(null);
      setFileError(null);
      loadDir(path);
    },
    [loadDir],
  );

  const reload = useCallback(() => {
    loadDir(dirPath);
  }, [loadDir, dirPath]);

  return {
    dirPath,
    entries,
    truncated,
    loading,
    error,
    openDir,
    filePath,
    openFile: setFilePath,
    file,
    fileLoading,
    fileError,
    reload,
  };
}

/**
 * The parent directory of a raw key, or `null` at the root.
 *
 * Exported so the breadcrumb and the "up" affordance agree on one answer, and
 * so it can be tested without a render.
 */
export function parentDirOf(path: string): string | null {
  if (path === '') return null;
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}
