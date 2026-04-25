import { createWorkspaceGitListener } from './listener.js';

export interface CreateWorkspaceGitServerOptions {
  repoRoot: string;
  host: string;
  /** Pass 0 to let the OS assign a free port; readback via `server.port`. */
  port: number;
  token: string;
}

export interface WorkspaceGitServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function createWorkspaceGitServer(
  opts: CreateWorkspaceGitServerOptions,
): Promise<WorkspaceGitServer> {
  return createWorkspaceGitListener(opts);
}
