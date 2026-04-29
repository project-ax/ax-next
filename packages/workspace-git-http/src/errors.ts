// ---------------------------------------------------------------------------
// Host-side client errors. The host plugin (Task 12) maps these to
// PluginError on its way back to the orchestrator; the client surface itself
// stays narrow — connection-level / 5xx failures are WorkspaceServerUnavailableError,
// 4xx already gets translated into PluginError inside the client.
//
// We don't import @ax/ipc-protocol's HostUnavailableError here because
// this is a different transport (no unix socket option) and a different auth
// model (static service token, no session). The shape happens to be the same.
// ---------------------------------------------------------------------------

export class WorkspaceServerUnavailableError extends Error {
  override cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WorkspaceServerUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
