import { useCallback, useEffect, useRef, useState } from 'react';
import { logRequestFailure } from './http';
import { workspaceApi } from './workspace-api';
import type { ArtifactSummary } from './workspace-types';

export interface AgentArtifactsState {
  status: 'loading' | 'ready' | 'failed';
  artifacts: ArtifactSummary[];
  reload(): void;
}

/**
 * The agent's artifacts, newest first. A response is applied only while it is
 * the most recent request (the house pattern), so an agent switch or a quick
 * retry never lets a stale answer paint over a fresh one.
 *
 * `recheckKey`: whenever it moves, read again quietly — the rows stay on
 * screen, and a failed quiet read keeps them (the next move tries again).
 */
export function useAgentArtifacts(agentId: string, recheckKey = 0): AgentArtifactsState {
  const [status, setStatus] = useState<AgentArtifactsState['status']>('loading');
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const request = useRef(0);

  const read = useCallback((quiet: boolean) => {
    const id = ++request.current;
    if (!quiet) setStatus('loading');
    void (async () => {
      try {
        const list = await workspaceApi.artifacts(agentId);
        if (request.current !== id) return;
        setArtifacts(
          [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
        );
        setStatus('ready');
      } catch (e) {
        if (request.current !== id) return;
        logRequestFailure(e, 'artifacts');
        if (quiet) return;
        // Never show the previous agent's (or an old) list under a failure.
        setArtifacts([]);
        setStatus('failed');
      }
    })();
  }, [agentId]);

  useEffect(() => {
    setArtifacts([]);
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

  return { status, artifacts, reload: useCallback(() => read(false), [read]) };
}
