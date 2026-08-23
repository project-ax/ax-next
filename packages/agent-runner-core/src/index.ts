// @ax/agent-runner-core — loop-agnostic runner machinery.
//
// Everything a runner does that is NOT the agent loop: workspace
// materialize/commit/bundle, the transcript delta protocol, uploads, the
// skills projection, proxy bootstrap, prompt composition, and the tool
// policy. Shared by @ax/agent-claude-sdk-runner and @ax/agent-aisdk-runner.
//
// This package must never import @anthropic-ai/claude-agent-sdk.
export { buildHomeBinEnv } from './home-bin-env.js';
export { buildTtyHintEnv } from './tty-hint-env.js';
export { buildToolCacheEnv } from './tool-cache-env.js';
export { commitTrace } from './commit-trace.js';
export { readRunnerEnv, MissingEnvError } from './env.js';
export type { RunnerEnv } from './env.js';
export { createLocalDispatcher } from './local-dispatcher.js';
export type { LocalDispatcher } from './local-dispatcher.js';
export { writeProxyCaFromEnv } from './proxy-ca-from-env.js';
export { translateContentBlocks } from './attachment-translation.js';
export type { WorkspaceReader } from './attachment-translation.js';
export {
  materializeUploads,
  resolveMaterializedPath,
  uploadsBaseDir,
} from './materialize-uploads.js';
export { buildPythonVenvEnv, scaffoldPythonVenv } from './python-venv.js';
export * from './identity-templates.js';
export {
  commitTurnAndBundle,
  materializeWorkspace,
  scaffoldSdkProjectsSymlink,
  scaffoldWorkspaceGitignore,
} from './git-workspace.js';
export { commitNotifyWithResync, flushWorkspaceToHost } from './commit-notify-resync.js';
export type { FlushOutcome } from './commit-notify-resync.js';
export { setupProxy } from './proxy-startup.js';
export { createInboxLoop } from './inbox-loop.js';
export type { InboxLoop, InboxLoopEntry, InboxLoopOptions } from './inbox-loop.js';
export { materializeInstalledSkillsFromEnv, validateMcpEntry } from './installed-skills.js';
export { buildSystemPrompt } from './prompt-engine.js';
export { createSkillProposeExecutor } from './skill-propose-executor.js';
export { createArtifactPublishExecutor } from './artifact-publish-executor.js';
export type {
  ArtifactPublishOutput,
  CreateArtifactPublishExecutorOptions,
} from './artifact-publish-executor.js';
export { createToolPolicy } from './tool-policy.js';
export type {
  ToolPolicy,
  PreToolVerdict,
  DenyCause,
  CreateToolPolicyOptions,
} from './tool-policy.js';
export { decisionResolvedTurn, sanitizeDecisionNote } from './decision-turn.js';
export { createHoldLatch, drainHoldLatch } from './hold-latch.js';
export type { HoldLatch } from './hold-latch.js';
export { resolveGovernedPaths, resolveAttachmentPaths } from './governed-paths.js';
export { buildEgressBlockNote } from './egress-note.js';
export {
  shipTranscriptDelta,
  replaceWholeTranscript,
  restoreTranscriptForResume,
  splitCompleteLines,
  hashBytes,
} from './transcript-delta.js';
export type {
  TranscriptSource,
  TranscriptShipState,
  TranscriptWriteOutcome,
  ShipDeltaResult,
} from './transcript-delta.js';
export type { ProxyStartup } from './proxy-startup.js';
export { runRunner } from './run-runner.js';
export type {
  EndTurnInput,
  Loop,
  LoopContext,
  LoopOutcome,
  LoopUserMessage,
  RunnerDeps,
  RunnerSeams,
  StreamChunk,
} from './run-runner.js';
