export { createRoutinesPlugin } from './plugin.js';
export { SKILL_REFLECTION_PROMPT, SKILL_REFLECTION_ROUTINE_NAME } from './reflection-prompt.js';
// Exported so the skill-crystallization canary in @ax/skills can drive the
// REAL routine fire path (source: 'routine' stamped host-side) against the
// real skills:propose, instead of re-implementing the fire flow in the test.
export { createFireRoutine, type FireDeps, type PendingFires } from './fire.js';
export type { StoredRoutine, AcceptedDispatch, DispatchOutcome, FireRow, FireSource, FireStatus, RoutinesConfig, TriggerSpec, ActiveHours } from './types.js';
