export { createRoutinesPlugin } from './plugin.js';
export { SKILL_REFLECTION_PROMPT } from './reflection-prompt.js';
// Exported so the skill-crystallization canary in @ax/skills can drive the
// REAL routine fire path (source: 'routine' stamped host-side) against the
// real skills:propose, instead of re-implementing the fire flow in the test.
export { createFireRoutine, type FireDeps, type PendingFires } from './fire.js';
export type {
  RoutineRow,
  FireRow,
  FireSource,
  FireStatus,
  FireNowInput,
  FireNowOutput,
  ListInput,
  ListOutput,
  RoutinesConfig,
  TriggerSpec,
  ActiveHours,
  DefaultRoutineSummary,
  DefaultRoutineDetail,
  RoutinesListDefaultsInput,
  RoutinesListDefaultsOutput,
  RoutinesGetDefaultInput,
  RoutinesGetDefaultOutput,
  RoutinesUpsertDefaultInput,
  RoutinesUpsertDefaultOutput,
  RoutinesDeleteDefaultInput,
  RoutinesDeleteDefaultOutput,
  RoutinesSetAgentDefaultEnabledInput,
  RoutinesSetAgentDefaultEnabledOutput,
  AgentDefaultRoutineState,
  RoutinesListAgentDefaultsInput,
  RoutinesListAgentDefaultsOutput,
} from './types.js';
