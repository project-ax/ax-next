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
