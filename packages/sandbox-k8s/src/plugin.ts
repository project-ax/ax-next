import type { Plugin } from '@ax/core';
import { OpenSessionResultSchema } from '@ax/sandbox-protocol';
import type {
  ReadUserFilesInput,
  ReadUserFilesOutput,
} from '@ax/sandbox-mount-protocol';
import type { ZodType } from 'zod';
import { resolveConfig, type SandboxK8sConfig } from './config.js';
import { createDefaultK8sApi, type K8sCoreApi } from './k8s-api.js';
import {
  createOpenSession,
  makePidGenerator,
  type OpenSessionResult,
} from './open-session.js';
import { startOrphanSweeper, type OrphanSweeperHandle } from './sweep.js';
import {
  cleanupUserFiles,
  ownerFromAgentId,
  readUserFiles,
} from './user-files-ops.js';

const PLUGIN_NAME = '@ax/sandbox-k8s';

// Structural twin of @ax/agents' AgentsDeletedEvent (I2 — no cross-plugin
// import; the bus is the API). We read only `agentId` (the per-agent subtree
// key) + `ownerId` (forwarded as the resolver owner's userId, which the
// resolvers ignore).
interface AgentsDeletedEvent {
  agentId: string;
  ownerId: string;
  ownerType: 'user' | 'team';
}

// See @ax/sandbox-protocol OpenSessionResultSchema: a `.passthrough()` schema
// that asserts only `runnerEndpoint` and lets the live `handle` ride through
// untouched (a strict schema would strip it). Cast to the hook's output type
// because the passthrough infer-type can't be proven assignable to the typed
// `OpenSessionResult` (its `handle` is a live object the schema doesn't model).
const OPEN_SESSION_RETURNS =
  OpenSessionResultSchema as unknown as ZodType<OpenSessionResult>;

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

  // TASK-170: held across init → shutdown so the periodic orphan-sweep timer is
  // cleared cleanly on kernel shutdown (the kernel calls shutdown() on SIGTERM).
  let sweeper: OrphanSweeperHandle | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // `sandbox:read-user-files` (filestore-user-files §11 host-read): the
      // host's READ-ONLY view of an agent's durable NFS user-files subtree, so
      // the web UI can serve those files without entering a live sandbox.
      // Realized by a short-lived pod that mounts the export read-only.
      registers: ['sandbox:open-session', 'sandbox:read-user-files'],
      // Mirrors sandbox-subprocess. We DON'T list ipc:start / ipc:stop /
      // llm-proxy:start because the k8s pod runs its own listeners — those
      // host-side hooks are subprocess-impl-specific. Once the pod-side
      // HTTP server lands, the orchestration sketch may grow.
      calls: ['session:create', 'session:terminate'],
      // filestore-user-files (design §4): when a mount-resolver plugin
      // (@ax/workspace-filestore) is loaded, open-session calls
      // `sandbox:resolve-mounts` and realizes each `nfs` mount as an inline
      // pod volume + subPath mount. Optional — without a resolver the pod gets
      // only the default emptyDir tiers; no durable per-agent user-files mount.
      // `sandbox:resolve-mounts` is the durable per-agent mount resolver. It's
      // optional for open-session (no resolver → no AX_USERFILES_ROOT) AND for
      // both §11 host-side ops below: `sandbox:read-user-files` and the
      // `agents:deleted` cleanup both call it to learn an agent's
      // server/exportPath/subPath, and degrade to a no-op when no resolver is
      // loaded.
      optionalCalls: [
        {
          hook: 'sandbox:resolve-mounts',
          degradation:
            'no durable per-agent user-files mount; AX_USERFILES_ROOT unset; ' +
            'host-read returns absent and agent-delete cleanup is a no-op',
        },
      ],
      // filestore-user-files §11 cleanup: when an agent is deleted, reclaim its
      // durable user-files subtree via a short-lived mount-and-rm pod. Fired by
      // @ax/agents AFTER the row is gone; isolated by HookBus.fire so a cleanup
      // failure never affects the delete.
      subscribes: ['agents:deleted'],
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
        // We don't have a logger at init time — AgentContext is per-request
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
        { timeoutMs: 300_000, returns: OPEN_SESSION_RETURNS },
      );

      // §11 host-read. Read-only end to end (the one-shot reader pod mounts the
      // export `readOnly: true` and the resolver realization is read-only); a
      // caller-supplied path is confined to the agent's own subtree. No durable
      // resolver loaded → `{ kind: 'absent' }`. The reader pod can take seconds
      // (pull + mount + read), so give the call a generous timeout like
      // open-session.
      bus.registerService<ReadUserFilesInput, ReadUserFilesOutput>(
        'sandbox:read-user-files',
        PLUGIN_NAME,
        async (ctx, input) => readUserFiles(ctx, bus, api, config, ctx.logger, input),
        { timeoutMs: 180_000 },
      );

      // §11 cleanup-on-agent-delete. A short-lived mount-and-rm pod removes
      // EXACTLY this agentId's subtree (validated single segment), never a
      // sibling's (cross-tenant safety, §9). Best-effort — a failure is logged,
      // never propagated (the delete already committed).
      bus.subscribe<AgentsDeletedEvent>(
        'agents:deleted',
        PLUGIN_NAME,
        async (ctx, event) => {
          await cleanupUserFiles(
            ctx,
            bus,
            api,
            config,
            ownerFromAgentId(event.agentId, event.ownerId),
            ctx.logger,
          );
          return undefined;
        },
      );

      // TASK-170: start the orphan-sweep. It reclaims terminated runner pods a
      // transient-failed delete left behind (runner pods have no
      // ownerReference, so nothing else GCs them). Disabled when the interval
      // is <= 0 (tests, or a deployment that reaps another way). Uses the
      // EXISTING pods list/delete grant; the list is label-scoped to runner
      // pods so it can never touch the host pod.
      if (config.orphanSweepIntervalMs > 0) {
        sweeper = startOrphanSweeper({
          api,
          namespace: config.namespace,
          intervalMs: config.orphanSweepIntervalMs,
          terminalAgeMs: config.orphanSweepTerminalAgeMs,
        });
      }
    },

    async shutdown() {
      // Stop the periodic sweep so the kernel/test harness can drain. The
      // bus's service registration needs no explicit unregister — the bus is
      // single-use per process. Idempotent: handle.stop() no-ops on a second
      // call, and we drop the reference so a re-init starts fresh.
      if (sweeper !== undefined) {
        await sweeper.stop();
        sweeper = undefined;
      }
    },
  };
}
