import type { ServiceHandler } from '@ax/core';

export const MockServices = {
  basics(): Record<string, ServiceHandler> {
    return {
      'storage:get': async () => undefined,
      'storage:set': async () => undefined,
      'audit:write': async () => undefined,
      'eventbus:emit': async () => undefined,
    };
  },
};
