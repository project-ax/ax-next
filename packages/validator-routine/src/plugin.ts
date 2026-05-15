import type { Plugin } from '@ax/core';

export function createValidatorRoutinePlugin(): Plugin {
  return {
    manifest: {
      name: '@ax/validator-routine',
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['workspace:pre-apply'],
    },
    init() {
      // Task 3 wires the subscriber.
    },
  };
}
