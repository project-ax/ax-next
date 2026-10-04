export { createChatOrchestratorPlugin } from './plugin.js';
export type {
  ChatOrchestratorConfig,
  ResolvedSkillForOrch,
  AgentInvokeInput,
  ApplyCapabilityGrantInput,
  ApplyCapabilityGrantOutput,
  AgentInterruptInput,
  AgentInterruptOutput,
  ApplyAuthoredCapabilityGrantInput,
  ApplyAuthoredCapabilityGrantOutput,
} from './orchestrator.js';
export { KNOWN_PROVIDERS, type KnownProvider } from './orchestrator.js';
// TASK-807 — the host's "which vault refs does this connector spend" derivation,
// exported so the connector-credential-refs contract test (in @ax/channel-web,
// where the rail's own copy lives) can run it against the other two copies. A
// pure function over a capabilities literal; no bus, no state.
export { connectorCredentialSlots } from './connector-union.js';
