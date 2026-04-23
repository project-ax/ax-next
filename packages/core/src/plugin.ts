import { z } from 'zod';
import type { HookBus } from './hook-bus.js';

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  registers: z.array(z.string()).default([]),
  calls: z.array(z.string()).default([]),
  subscribes: z.array(z.string()).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface PluginInitContext {
  bus: HookBus;
  config: unknown;
}

export interface Plugin {
  manifest: PluginManifest;
  init(ctx: PluginInitContext): Promise<void> | void;
}
