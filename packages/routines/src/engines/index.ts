import type { RoutineSchedule as TriggerSpec } from '@ax/routines-contract';
import { intervalEngine, type TriggerEngine } from './interval.js';
import { cronEngine } from './cron.js';

export { type TriggerEngine } from './interval.js';

export function engineFor(spec: TriggerSpec): TriggerEngine | null {
  switch (spec.kind) {
    case 'interval': return intervalEngine;
    case 'cron':     return cronEngine;
    default:         return null;
  }
}
