import { useCallback, useEffect, useRef, useState } from 'react';
import { HttpError, logRequestFailure } from './http';
import { workspaceApi } from './workspace-api';
import type { ArtifactDetail, ArtifactSummary } from './workspace-types';

export interface ArtifactState {
  /** `gone`: a 404 — deleted, or not ours to see (the server says the same for both). */
  status: 'loading' | 'ready' | 'gone' | 'failed';
  artifact: ArtifactDetail | null;
  /** Read again, showing the loading state. */
  reload(): void;
  /** Read again quietly, keeping what's on screen until the answer lands. */
  refresh(): void;
  /** Fold a summary a write answered with (rename, link) into what's shown. */
  apply(summary: ArtifactSummary): void;
}

/**
 * One artifact's detail and versions. A response is applied only while it is
 * the most recent request (the house pattern), so a quick reopen never lets a
 * stale answer paint over a fresh one.
 *
 * `recheckKey`: whenever it moves, read again quietly — the agent may have
 * published a new version while the viewer stayed open (Goal 4).
 */
export function useArtifact(artifactId: string, recheckKey = 0): ArtifactState {
  const [status, setStatus] = useState<ArtifactState['status']>('loading');
  const [artifact, setArtifact] = useState<ArtifactDetail | null>(null);
  const request = useRef(0);

  const read = useCallback(
    (quiet: boolean) => {
      const id = ++request.current;
      if (!quiet) setStatus('loading');
      void (async () => {
        try {
          const next = await workspaceApi.artifact(artifactId);
          if (request.current !== id) return;
          setArtifact(next);
          setStatus('ready');
        } catch (e) {
          if (request.current !== id) return;
          logRequestFailure(e, 'artifact');
          const gone = e instanceof HttpError && e.status === 404;
          // A quiet re-read that blips keeps what's on screen; a 404 never does.
          if (quiet && !gone) return;
          setArtifact(null);
          setStatus(gone ? 'gone' : 'failed');
        }
      })();
    },
    [artifactId],
  );

  useEffect(() => {
    setArtifact(null);
    read(false);
    return () => {
      request.current++;
    };
  }, [read]);

  // Not on mount (the read above covers it): only when the key moves after.
  const seenKey = useRef(recheckKey);
  useEffect(() => {
    if (seenKey.current === recheckKey) return;
    seenKey.current = recheckKey;
    read(true);
  }, [recheckKey, read]);

  const apply = useCallback((summary: ArtifactSummary) => {
    setArtifact((prev) => (prev === null ? prev : { ...prev, ...pickSummary(summary) }));
  }, []);

  return {
    status,
    artifact,
    reload: useCallback(() => read(false), [read]),
    refresh: useCallback(() => read(true), [read]),
    apply,
  };
}

/** Only summary fields, so a detail passed as a summary can't swap the version list. */
function pickSummary(s: ArtifactSummary): ArtifactSummary {
  return {
    artifactId: s.artifactId,
    agentId: s.agentId,
    title: s.title,
    mediaType: s.mediaType,
    kind: s.kind,
    preview: s.preview,
    extension: s.extension,
    currentVersion: s.currentVersion,
    sizeBytes: s.sizeBytes,
    linkOn: s.linkOn,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
