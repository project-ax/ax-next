import type { Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/onboarding';

/**
 * Bootstrap onboarding plugin.
 *
 * Tasks 2.2–2.9 fill in the services, routes, and SPA this plugin provides.
 * Task 2.10 wires it into the CLI and k8s presets, closing the half-wired window.
 */
export function createOnboardingPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // Tasks 2.2–2.7 will add service hooks here.
      registers: [],
      // Tasks 2.4–2.7 will add bus.call() targets here.
      calls: [],
      // No subscriptions at scaffold time.
      subscribes: [],
    },

    async init() {
      // No-op — Tasks 2.2+ fill this in.
    },

    async shutdown() {
      // No-op — Tasks 2.2+ fill this in.
    },
  };
}
