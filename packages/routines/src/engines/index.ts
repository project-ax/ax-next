import type { TriggerSpec } from '@ax/validator-routine';
import { intervalEngine, type TriggerEngine } from './interval.js';

export { type TriggerEngine } from './interval.js';

export function engineFor(spec: TriggerSpec): TriggerEngine | null {
  switch (spec.kind) {
    case 'interval': return intervalEngine;
    case 'cron':     return null; // Task 7
    case 'webhook':  return null; // Phase C
    default:         return null;
  }
}
