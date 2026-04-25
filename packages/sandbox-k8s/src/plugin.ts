import type { Plugin } from '@ax/core';
import { resolveConfig, type SandboxK8sConfig } from './config.js';
import { createDefaultK8sApi, type K8sCoreApi } from './k8s-api.js';
import {
  createOpenSession,
  makePidGenerator,
  type OpenSessionResult,
} from './open-session.js';

const PLUGIN_NAME = '@ax/sandbox-k8s';

export interface CreateSandboxK8sPluginOptions extends SandboxK8sConfig {
  /**
   * Override the k8s client. Tests pass a mock; production omits this and
   * the plugin loads kubeconfig (in-cluster first, then ~/.kube/config).
   */
  api?: K8sCoreApi;
}

export function createSandboxK8sPlugin(
  opts: CreateSandboxK8sPluginOptions = {},
): Plugin {
  const { api: apiOverride, ...rawConfig } = opts;
  const config = resolveConfig(rawConfig);

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['sandbox:open-session'],
      // Mirrors sandbox-subprocess. We DON'T list ipc:start / ipc:stop /
      // llm-proxy:start because the k8s pod runs its own listeners — those
      // host-side hooks are subprocess-impl-specific. Once the pod-side
      // HTTP server lands, the orchestration sketch may grow.
      calls: ['session:create', 'session:terminate'],
      subscribes: [],
    },
    async init({ bus }) {
      // Verified against the pinned `@kubernetes/client-node@1.4.0` (see
      // package.json — exact pin, no caret, no tilde). At this version the
      // library uses node-fetch and allocates a fresh http/https/proxy Agent
      // per request inside `applySecurityAuthentication` (see
      // node_modules/@kubernetes/client-node/dist/config.js: `createAgent`
      // and `applySecurityAuthentication`, called from each generated method
      // in dist/gen/apis/CoreV1Api.js). The Agent lives on the per-request
      // `requestContext`, not on the API client or KubeConfig — there is no
      // long-lived per-client Agent for us to `.destroy()`. So no `shutdown()`
      // slot is needed for this plugin.
      //
      // TODO: re-verify on any minor- or major-version bump of
      // `@kubernetes/client-node`. If the library starts caching an Agent on
      // the client for connection reuse, or moves back to axios with an
      // explicit instance, this plugin needs a `shutdown()` that destroys
      // whatever long-lived handle the new version retains.
      const api = apiOverride ?? (await createDefaultK8sApi());

      // I5: warn loudly when an operator opts out of gVisor. The
      // userspace kernel is the second isolation layer and the cluster
      // RBAC the first; running without it is supportable but is the
      // single biggest knob in this provider's threat model.
      if (config.runtimeClassName.length === 0) {
        // We don't have a logger at init time — ChatContext is per-request
        // and `init` runs before any chat. Emit on stderr; this is
        // boot-time, single-shot, and users grepping their logs will see
        // a clear marker.
        process.stderr.write(
          '[ax/sandbox-k8s] WARN: runtimeClassName is empty — pods will run on the host kernel without gVisor. ' +
            'This is supported only for trusted single-tenant deployments. Set runtimeClassName: "gvisor" to re-enable.\n',
        );
      }

      const nextPid = makePidGenerator();
      const impl = createOpenSession({ api, config, bus, nextPid });

      bus.registerService<unknown, OpenSessionResult>(
        'sandbox:open-session',
        PLUGIN_NAME,
        impl,
      );
    },
  };
}
