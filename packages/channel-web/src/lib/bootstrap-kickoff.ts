/**
 * The first message a freshly-bootstrapped agent receives. One spelling,
 * exported, so `WorkspaceShell` sends exactly this text when kicking off a
 * just-created agent (see `workspaceApi.sendMessage` call sites there).
 */
export const KICKOFF_TEXT = 'hi';
