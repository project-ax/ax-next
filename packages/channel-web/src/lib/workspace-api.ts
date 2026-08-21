/**
 * Agent-workspace prototype — HTTP client.
 *
 * Deliberately ordinary fetch code. The whole point of standing the prototype
 * on a mock HTTP backend rather than component state is that THIS layer is the
 * only thing that changes when the real substrate lands: the routes move, the
 * shapes do not.
 */
import type {
  ActivityEvent,
  Decision,
  DemoScenario,
  ExecutionPath,
  MemoryDoc,
  PermissionRow,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceFile,
} from '../../mock/workspace-types';

export type {
  ActivityEvent,
  Decision,
  DemoScenario,
  MemoryDoc,
  PermissionRow,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceFile,
};

export interface BoardState {
  scenario: DemoScenario;
  agents: WorkspaceAgent[];
  decisions: Decision[];
  activity: ActivityEvent[];
  stoppedAll: boolean;
}

export interface AgentDetail {
  agent: WorkspaceAgent;
  permissions: PermissionRow[];
  stats: Array<{ label: string; value: string }>;
  past: Array<{
    id: string;
    title: string;
    meta: string;
    folded: number;
    msgs: ThreadMessage[];
  }>;
  thread: ThreadMessage[];
  files: WorkspaceFile[];
  memory: MemoryDoc[];
  suggestions: string[];
}

export interface ApproveResponse {
  decision: Decision;
  executed: boolean;
  path: ExecutionPath | null;
  event: ActivityEvent | null;
}

async function req<T>(
  path: string,
  init?: { method: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`/api/workspace${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(init.body),
        }
      : {}),
  });
  if (!res.ok) {
    throw new Error(`workspace ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export const workspaceApi = {
  board: () => req<BoardState>('/state'),
  agent: (id: string) => req<AgentDetail>(`/agents/${id}`),

  approve: (id: string) =>
    req<ApproveResponse>(`/decisions/${id}/approve`, { method: 'POST' }),
  dismiss: (id: string) =>
    req<{ decision: Decision; event: ActivityEvent | null }>(
      `/decisions/${id}/dismiss`,
      { method: 'POST' },
    ),
  undo: (id: string) =>
    req<{ decision: Decision; undone: boolean }>(`/decisions/${id}/undo`, {
      method: 'POST',
    }),

  send: (agentId: string, text: string) =>
    req<{ thread: ThreadMessage[] }>(`/agents/${agentId}/messages`, {
      method: 'POST',
      body: { text },
    }),
  pause: (agentId: string, paused: boolean) =>
    req<{ agent: WorkspaceAgent }>(`/agents/${agentId}/pause`, {
      method: 'POST',
      body: { paused },
    }),
  restart: (agentId: string) =>
    req<{ agent: WorkspaceAgent }>(`/agents/${agentId}/restart`, {
      method: 'POST',
    }),
  saveMemory: (agentId: string, name: string, body: string) =>
    req<{ saved: boolean }>(`/agents/${agentId}/memory`, {
      method: 'POST',
      body: { name, body },
    }),

  /** Auto-routing: proposes an agent for a free-text request. Never dispatches. */
  route: (text: string) =>
    req<{ agentId: string; agentName: string; why: string; confident: boolean }>(
      '/route',
      { method: 'POST', body: { text } },
    ),
  createAgent: (brief: string) =>
    req<{ agentId: string }>('/agents', { method: 'POST', body: { brief } }),

  stopAll: (stopped: boolean) =>
    req<{ stoppedAll: boolean }>('/stop-all', {
      method: 'POST',
      body: { stopped },
    }),
  setScenario: (scenario: DemoScenario) =>
    req<{ scenario: DemoScenario }>('/scenario', {
      method: 'POST',
      body: { scenario },
    }),
};
