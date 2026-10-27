import { PluginError } from '@ax/core';
import { z } from 'zod';
import type { ResolvedSandboxK8sConfig } from './config.js';
import type { K8sCoreApi } from './k8s-api.js';
import { SANDBOX_SELECTOR, type SandboxCustomApi } from './agent-sandbox.js';
import { CLAIM_POOL_LABEL, SESSION_ID_ANNOTATION } from './storage-node/protocol.js';
import { RUNNER_COMPONENT_SELECTOR } from './sweep.js';

const inputSchema = z.object({ sessionId: z.string().min(1).max(1024) }).strict();
export const SessionStatusSchema = z.object({ state: z.enum(['running', 'stopped', 'unknown']) }).strict();
const envSchema = z.array(z.object({ name: z.string(), value: z.string().optional() }).passthrough());
const containersSchema = z.array(z.object({ env: envSchema.optional() }).passthrough());
const podsSchema = z.object({ items: z.array(z.object({
  spec: z.object({ containers: containersSchema }).passthrough(),
  status: z.object({ phase: z.string().optional() }).passthrough().optional(),
}).passthrough()) }).passthrough();
const resourcesSchema = z.object({ items: z.array(z.object({
  metadata: z.object({ labels: z.record(z.string()).optional(), annotations: z.record(z.string()).optional() }).passthrough(),
  spec: z.object({ podTemplate: z.object({ spec: z.object({ containers: containersSchema }).passthrough() }).passthrough().optional() }).passthrough().optional(),
}).passthrough()) }).passthrough();
const namesSession = (containers: z.infer<typeof containersSchema>, sessionId: string) =>
  containers.some(container => container.env?.some(env => env.name === 'AX_SESSION_ID' && env.value === sessionId));

/** Observe actual execution resources; a stored session binding alone is not liveness. */
export function createSessionStatus(api: K8sCoreApi, custom: SandboxCustomApi | undefined, config: ResolvedSandboxK8sConfig) {
  return async (_ctx: unknown, raw: unknown): Promise<z.infer<typeof SessionStatusSchema>> => {
    const input = inputSchema.safeParse(raw);
    if (!input.success) throw new PluginError({ code: 'invalid-payload', plugin: '@ax/sandbox-k8s', message: 'Invalid session status input.' });
    const { sessionId } = input.data;
    try {
      // Fixed namespace/selector; the opaque identity is compared exactly, never used as a label or path.
      const list = podsSchema.parse(await api.listNamespacedPod({ namespace: config.namespace, labelSelector: RUNNER_COMPONENT_SELECTOR }));
      const matching = list.items.filter(pod => namesSession(pod.spec.containers, sessionId));
      if (matching.some(pod => pod.status?.phase === 'Running' || pod.status?.phase === 'Pending')) return { state: 'running' };
      if (matching.length > 0) return { state: matching.every(pod => ['Succeeded', 'Failed'].includes(pod.status?.phase ?? '')) ? 'stopped' : 'unknown' };
      if (config.sharedPool) {
        if (!custom) return { state: 'unknown' };
        const claims = resourcesSchema.parse(await custom.listNamespacedCustomObject({ group: 'extensions.agents.x-k8s.io', version: 'v1beta1',
          plural: 'sandboxclaims', namespace: config.namespace, labelSelector: CLAIM_POOL_LABEL }));
        for (const claim of claims.items) {
          if (!claim.metadata.labels?.[CLAIM_POOL_LABEL]?.startsWith(config.sharedPool.prefix + '-')) continue;
          const identity = claim.metadata.annotations?.[SESSION_ID_ANNOTATION];
          // Old claims cannot be identified after a restart; absence of an annotation is not proof of death.
          if (!identity) return { state: 'unknown' };
          if (identity === sessionId) return { state: 'running' };
        }
      }
      if (config.backend === 'agent-sandbox') {
        if (!custom) return { state: 'unknown' };
        const parents = resourcesSchema.parse(await custom.listNamespacedCustomObject({ group: 'agents.x-k8s.io', version: config.agentSandboxApiVersion,
          plural: 'sandboxes', namespace: config.namespace, labelSelector: SANDBOX_SELECTOR }));
        for (const parent of parents.items) {
          const containers = parent.spec?.podTemplate?.spec.containers;
          if (!containers || namesSession(containers, sessionId)) return { state: 'unknown' }; // A controller may still create its pod.
        }
      }
      return { state: 'stopped' };
    } catch {
      // API failure, incomplete observations and unexpected shapes never release another execution's slot.
      return { state: 'unknown' };
    }
  };
}
