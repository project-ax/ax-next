import { httpJson, httpVoid } from './http';
import { workspaceApi } from './workspace-api';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
};

const conversationPath = (id: string) => {
  if (!id || id === '.' || id === '..')
    throw new Error('Invalid conversation id');
  return `/api/chat/conversations/${encodeURIComponent(id)}`;
};
export const conversationControls = {
  create: (agentId: string) =>
    httpJson<{ conversationId: string }>('/api/chat/conversations', {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ agentId }),
    }),
  rename: (id: string, title: string) =>
    httpVoid(conversationPath(id), {
      method: 'PATCH',
      headers: writeHeaders,
      body: JSON.stringify({ title }),
    }),
  delete: (id: string) => httpVoid(conversationPath(id), { method: 'DELETE', headers: writeHeaders }),
  /**
   * W3e — move a chat into a project, to another one, or out (`null`).
   * Refusals throw an `HttpError` carrying the status: 404 for a chat or
   * project the person can't reach, 409 for a routine's chat, 503 when this
   * deployment has no projects.
   */
  setProject: (id: string, projectId: string | null) =>
    httpJson<{ projectId: string | null }>(`${conversationPath(id)}/project`, {
      method: 'PUT',
      headers: writeHeaders,
      body: JSON.stringify({ projectId }),
    }),
  /**
   * W3e — the projects a chat with `agentId` can move into: the person's
   * projects that agent is a member of (the server refuses the rest, the same
   * rule as starting a chat in one), most recently updated first.
   */
  moveTargets: async (agentId: string) => {
    const { projects } = await workspaceApi.listProjects();
    return projects.filter((p) => p.members.some((m) => m.agentId === agentId));
  },
  export: async (agentId: string, id: string) => {
    const detail = await workspaceApi.agent(agentId, id);
    const body = detail.thread
      .flatMap((m) => {
        if (m.kind !== 'user' && m.kind !== 'agent') return [];
        return [
          `${m.kind === 'user' ? 'You' : detail.agent.name}\n${m.text}\n`,
        ];
      })
      .join('\n');
    const url = URL.createObjectURL(
      new Blob([body], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'conversation.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
