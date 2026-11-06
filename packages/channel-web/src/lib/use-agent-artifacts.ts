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
 */
export function useAgentArtifacts(agentId: string): AgentArtifactsState {
  const [status, setStatus] = useState<AgentArtifactsState['status']>('loading');
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const request = useRef(0);

  const load = useCallback(() => {
    const id = ++request.current;
    setStatus('loading');
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
        // Never show the previous agent's (or an old) list under a failure.
        setArtifacts([]);
        setStatus('failed');
      }
    })();
  }, [agentId]);

  useEffect(() => {
    setArtifacts([]);
    load();
    return () => {
      request.current++;
    };
  }, [load]);

  return { status, artifacts, reload: load };
}
