import { randomUUID } from 'node:crypto';
import { PluginError, type Logger } from '@ax/core';
import type { ResolvedSandboxK8sConfig } from './config.js';
import type { K8sCoreApi } from './k8s-api.js';
import { killPod, isPodGoneError } from './kill.js';
import type { PodSpec } from './pod-spec.js';
import { GKE_SANDBOX_NODE_PLACEMENT } from './agent-sandbox.js';

/**
 * GKE's Sandbox hardening policy forbids root init containers. Run only the
 * existing, fixed CAP_CHOWN steps as short-lived host-managed Pods BEFORE
 * creating the Sandbox. Each mounts the same per-agent subtree, receives no
 * session/proxy credential, and has no model-driven code. No policy exemption.
 */
export async function prepareAgentSandboxMounts(
  api: K8sCoreApi, pod: PodSpec, config: ResolvedSandboxK8sConfig, log: Logger,
): Promise<PodSpec> {
  const inits = (pod.spec.initContainers ?? []) as Array<Record<string, unknown>>;
  const ownershipInits = inits.filter((init) => /^ax-mount-\d+-chown$/.test(String(init.name)));
  for (const init of ownershipInits) {
    const name = `ax-mount-prepare-${randomUUID().slice(0, 8)}`;
    const mounts = init.volumeMounts as Array<{ name: string }>;
    const volumeNames = new Set(mounts.map((mount) => mount.name));
    const volumes = (pod.spec.volumes as Array<{ name: string }>).filter((volume) => volumeNames.has(volume.name));
    const body = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name, namespace: config.namespace, labels: pod.metadata.labels },
      spec: {
        runtimeClassName: 'gvisor', automountServiceAccountToken: false, hostNetwork: false,
        ...GKE_SANDBOX_NODE_PLACEMENT,
        restartPolicy: 'Never', activeDeadlineSeconds: Math.ceil(config.readinessTimeoutMs / 1000),
        ...(pod.spec.imagePullSecrets ? { imagePullSecrets: pod.spec.imagePullSecrets } : {}),
        containers: [{ ...init, name: 'ownership',
          resources: { requests: { cpu: config.cpuRequest, memory: config.memoryRequest },
            limits: { cpu: config.cpuLimit, memory: config.memoryLimit } } }],
        volumes,
      },
    };
    await api.createNamespacedPod({ namespace: config.namespace, body });
    const deadline = Date.now() + config.readinessTimeoutMs;
    try {
      for (;;) {
        let observed;
        try {
          observed = await api.readNamespacedPod({ namespace: config.namespace, name }) as {
            status?: { phase?: string; containerStatuses?: Array<{ state?: { terminated?: { exitCode?: number } } }> };
          };
        } catch (err) {
          if (isPodGoneError(err)) throw new Error('ownership preparation pod disappeared');
          if (Date.now() >= deadline) throw err;
        }
        const phase = observed?.status?.phase;
        if (phase === 'Succeeded' || phase === 'Failed') {
          const code = observed?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
          if (phase !== 'Succeeded' || code !== 0) throw new Error('ownership preparation did not succeed with exit code 0');
          break;
        }
        if (Date.now() >= deadline) throw new Error('ownership preparation timed out');
        await new Promise((resolve) => setTimeout(resolve, config.readinessPollMs));
      }
    } catch (cause) {
      throw new PluginError({ code: 'sandbox-mount-prepare-failed', plugin: '@ax/sandbox-k8s',
        message: 'We could not prepare the agent’s writable file mount.', cause });
    } finally {
      await killPod({ api, podName: name, namespace: config.namespace, podLog: log }).catch(() => undefined);
    }
  }
  return { ...pod, spec: { ...pod.spec, initContainers: inits.filter((init) => !ownershipInits.includes(init)) } };
}
