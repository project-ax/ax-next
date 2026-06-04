import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  createLogger,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
// Real backend renderers — the descriptor that reaches `sandbox:open-session`
// is rendered through the SAME pure translation functions production uses, so
// the canary proves the neutral descriptor survives the round trip into a
// concrete backend shape WITHOUT smuggling backend vocabulary.
import { descriptorsToComposeProject } from '@ax/sandbox-subprocess';
import { buildPodSpec, resolveConfig } from '@ax/sandbox-k8s';
// The CANONICAL descriptor validator (TASK-150). The canary loads the REAL
// plugin so the orchestrator's `services:validate` pass is exercised, not a
// stub that would let a malformed/forbidden-vocab descriptor through.
import { createValidatorServicePlugin } from '@ax/validator-service';
import type { ServiceDescriptorParsed } from '@ax/sandbox-protocol';
import { createChatOrchestratorPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-155 — dev-services-in-sandbox CI canary (closes the I3 half-wired window).
//
// The full declared-services path, end to end, in CI (no real cluster):
//
//   connector(`services` capability)
//     → orchestrator effective-connector resolve + foldConnectorCaps (S5)
//     → `services:validate` (the REAL @ax/validator-service)
//     → `sandbox:open-session.services`
//     → a backend renders it (the REAL @ax/sandbox-subprocess compose
//       translation AND the REAL @ax/sandbox-k8s pod-spec builder).
//
// Two paths under test:
//   - HAPPY: a connector declaring JVM Kafka + Mongo (I7 — broker-agnostic;
//     the descriptor carries NO broker/scheduler vocabulary). The descriptors
//     reach the backend and BOTH renderers produce a valid shape with NONE of
//     the forbidden backend vocabulary smuggled in.
//   - ERROR: two connectors declaring the SAME service name →
//     ConnectorServiceCollisionError in the fold → terminated
//     (connector-services-invalid) + a chat:turn-error broadcast (so the SSE
//     client doesn't hang). Pending/unapproved connectors never reach the fold,
//     so this is the only producer-side error the canary can trigger.
// ---------------------------------------------------------------------------

const TEST_AGENT = {
  id: 'svc-canary-agent',
  ownerId: 'svc-canary-user',
  ownerType: 'user' as const,
  visibility: 'personal' as const,
  displayName: 'Services Canary',
  allowedTools: ['file.read'],
  mcpConfigIds: [],
  model: 'claude-sonnet-4-7',
  workspaceRef: null,
};

// Forbidden backend vocabulary the neutral descriptor must NEVER carry (the
// @ax/validator-service rejection list, I2). We assert the descriptor that
// reaches the backend is free of these even though both backends legitimately
// EMIT some of them in their own rendered output.
const FORBIDDEN_VOCAB = [
  'pod',
  'container',
  'securityContext',
  'runtimeClassName',
  'volume',
  'emptyDir',
  'initContainers',
  'restartPolicy',
  'privileged',
];

function canaryCtx(sessionId: string) {
  return makeAgentContext({
    sessionId,
    agentId: TEST_AGENT.id,
    userId: TEST_AGENT.ownerId,
    logger: createLogger({ reqId: 'svc-canary', writer: () => undefined }),
  });
}

const DIGEST = '@sha256:' + 'a'.repeat(64);

// I7 — a JVM broker (Kafka) + a database (Mongo), digest-pinned (I8), with a
// loopback dev port + a writable scratch path each. The descriptor is
// broker/backend-AGNOSTIC: it names an image, ports, env, a healthcheck, and a
// writable path — and nothing else. No `restartPolicy`, no `securityContext`,
// no `volume`/`emptyDir` — those are the BACKEND's concern, rendered downstream.
const KAFKA_SVC: ServiceDescriptorParsed = {
  name: 'kafka',
  image: 'apache/kafka' + DIGEST,
  ports: [9092],
  env: { KAFKA_NODE_ID: '1', KAFKA_PROCESS_ROLES: 'broker,controller' },
  healthcheck: { kind: 'tcp', port: 9092 },
  writablePaths: ['/var/lib/kafka/data'],
};
const MONGO_SVC: ServiceDescriptorParsed = {
  name: 'mongo',
  image: 'mongo' + DIGEST,
  ports: [27017],
  env: { MONGO_INITDB_ROOT_USERNAME: 'dev' },
  healthcheck: { kind: 'exec', command: ['mongosh', '--eval', 'db.runCommand({ ping: 1 })'] },
  writablePaths: ['/data/db'],
};

interface ServicesCanaryMocks {
  services: Record<string, ServiceHandler>;
  trace: {
    sandboxOpen: number;
    lastServices: ServiceDescriptorParsed[] | undefined;
    turnErrors: Array<{ reqId: string; reason: string; detail?: string }>;
  };
  /** TASK-160 — when set, `sandbox:open-session` throws this instead of
   *  succeeding (simulates a backend self-diagnosed sidecar failure). */
  openSessionThrows: { current: unknown };
}

// Connector capabilities shaped exactly like @ax/connectors' ResolveOutput
// (structural mirror, I2). The orchestrator folds the `services` field verbatim.
function connectorCaps(services: ServiceDescriptorParsed[]): Record<string, unknown> {
  return {
    allowedHosts: [],
    credentials: [],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
    services,
  };
}

// Build a self-contained orchestrator harness. `defaultConnectors` are returned
// from `connectors:list-defaults` (admin-curated, approved — they feed the
// fold). `sandbox:open-session` captures `input.services` and fires chat:end so
// the orchestrator's waiter resolves. A `chat:turn-error` subscriber records the
// broadcasts so the error path can assert the SSE got an error frame.
function buildMocks(
  busRef: { current: HookBus | null },
  defaultConnectors: Array<{ id: string; capabilities: Record<string, unknown> }>,
): ServicesCanaryMocks {
  const trace: ServicesCanaryMocks['trace'] = {
    sandboxOpen: 0,
    lastServices: undefined,
    turnErrors: [],
  };
  const openSessionThrows: { current: unknown } = { current: undefined };

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
    'connectors:list-defaults': async () => ({ connectors: defaultConnectors }),
    'session:queue-work': async () => ({ cursor: 0 }),
    'session:terminate': async () => ({}),
    'proxy:open-session': async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:54321',
      caCertPem: 'CA',
      envMap: {},
    }),
    'proxy:close-session': async () => ({}),
    'sandbox:open-session': async (ctx, input: unknown) => {
      trace.sandboxOpen += 1;
      const i = input as { sessionId: string; services?: ServiceDescriptorParsed[] };
      trace.lastServices = i.services;
      // TASK-160 — simulate a backend that self-diagnosed a sidecar failure.
      if (openSessionThrows.current !== undefined) {
        throw openSessionThrows.current;
      }
      const originatingReqId = ctx.reqId;
      // Resolve the orchestrator's waiter on the next tick.
      setImmediate(() => {
        void busRef.current!.fire(
          'chat:end',
          makeAgentContext({
            sessionId: i.sessionId,
            agentId: TEST_AGENT.id,
            userId: TEST_AGENT.ownerId,
            reqId: originatingReqId,
            logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
          }),
          { outcome: { kind: 'complete', messages: [] } },
        );
      });
      return {
        runnerEndpoint: 'http://127.0.0.1:54321',
        handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
      };
    },
  };

  return { services, trace, openSessionThrows };
}

async function makeHarness(
  busRef: { current: HookBus | null },
  mocks: ServicesCanaryMocks,
): Promise<Awaited<ReturnType<typeof createTestHarness>>> {
  const h = await createTestHarness({
    services: mocks.services,
    plugins: [
      // The REAL canonical descriptor validator — the orchestrator's
      // services:validate pass runs against this, not a stub.
      createValidatorServicePlugin(),
      createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', chatTimeoutMs: 5_000 }),
    ],
  });
  busRef.current = h.bus;
  // Record every chat:turn-error broadcast (undeclared subscriber event).
  h.bus.subscribe('chat:turn-error', '@ax/services-canary-spy', async (_ctx, payload) => {
    const p = payload as { reqId: string; reason: string; detail?: string };
    mocks.trace.turnErrors.push({
      reqId: p.reqId,
      reason: p.reason,
      ...(p.detail !== undefined ? { detail: p.detail } : {}),
    });
    return undefined;
  });
  return h;
}

describe('dev-services-in-sandbox CI canary (TASK-155)', () => {
  it('happy path: connector services → fold → validate → sandbox:open-session → BOTH backends render, no forbidden vocab', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks(busRef, [
      { id: 'kafka-mongo', capabilities: connectorCaps([KAFKA_SVC, MONGO_SVC]) },
    ]);
    const h = await makeHarness(busRef, mocks);

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      canaryCtx('svc-canary-happy'),
      { message: { role: 'user', content: 'hi' } },
    );

    // The turn completed and the sandbox was opened exactly once.
    expect(outcome.kind).toBe('complete');
    expect(mocks.trace.sandboxOpen).toBe(1);

    // 1) The descriptor REACHED the backend (sandbox:open-session.services).
    const reached = mocks.trace.lastServices;
    expect(reached).toBeDefined();
    expect(reached!.map((s) => s.name).sort()).toEqual(['kafka', 'mongo']);
    // Digest-pinned images survived the fold + validate untouched (I8).
    for (const svc of reached!) {
      expect(svc.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }

    // 2) The descriptor that reached the backend carries NO backend vocabulary
    //    (I1/I2 — it's a neutral spec; the backend, not the descriptor, owns
    //    pod/container/restartPolicy/etc.).
    const descriptorJson = JSON.stringify(reached);
    for (const word of FORBIDDEN_VOCAB) {
      expect(descriptorJson).not.toContain(word);
    }

    // 3) The subprocess backend renders it (docker compose project shape).
    const compose = descriptorsToComposeProject(reached!);
    expect(Object.keys(compose.services).sort()).toEqual(['kafka', 'mongo']);
    // Loopback-only publish (I4) + tmpfs scratch (I10), never a host bind mount.
    expect(compose.services.kafka!.ports).toEqual(['127.0.0.1:9092:9092']);
    expect(compose.services.kafka!.tmpfs).toEqual(['/var/lib/kafka/data']);
    const composeJson = JSON.stringify(compose);
    expect(composeJson).not.toContain('privileged');
    expect(composeJson).not.toContain('network_mode');
    // The compose project must NOT contain a host bind mount (`./host:/x`):
    // writablePaths render as tmpfs, never a `volumes:` entry.
    expect(compose.services.kafka).not.toHaveProperty('volumes');
    expect(compose.services.mongo).not.toHaveProperty('volumes');

    // 4) The k8s backend renders it (native sidecar pod-spec shape).
    const k8sConfig = resolveConfig({ hostIpcUrl: 'http://host.ax-next.svc:9090' });
    const pod = buildPodSpec(
      'ax-runner-canary',
      {
        sessionId: 'svc-canary-happy',
        workspaceRoot: '/permanent',
        runnerBinary: '/app/runner.js',
        authToken: 'tok',
        runnerEndpoint: 'http://host.ax-next.svc:9090',
        services: reached,
      },
      k8sConfig,
    );
    const initContainers = pod.spec.initContainers as Array<{ name: string; restartPolicy?: string; image: string }>;
    const sidecars = initContainers.filter((c) => c.restartPolicy === 'Always');
    // Each service rendered as a NATIVE sidecar (restartPolicy: Always init
    // container) — NEVER a plain `containers[]` entry (I1, the pod-completion
    // distinction). The runner is the sole `containers[]` entry.
    expect(sidecars.map((c) => c.name).sort()).toEqual(['svc-kafka', 'svc-mongo']);
    const podContainers = pod.spec.containers as Array<{ name: string }>;
    expect(podContainers.map((c) => c.name)).toEqual(['runner']);
    // The digest-pinned image reached the rendered sidecar.
    expect(sidecars.find((c) => c.name === 'svc-kafka')!.image).toBe(KAFKA_SVC.image);
  });

  it('error path: two connectors with the same service name → terminated(connector-services-invalid) + turn-error', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    // Two DIFFERENT connectors both declaring a `mongo` service — a
    // cross-connector collision the fold refuses LOUDLY.
    const mocks = buildMocks(busRef, [
      { id: 'conn-a', capabilities: connectorCaps([MONGO_SVC]) },
      { id: 'conn-b', capabilities: connectorCaps([{ ...MONGO_SVC, image: 'mongo@sha256:' + 'b'.repeat(64) }]) },
    ]);
    const h = await makeHarness(busRef, mocks);

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      canaryCtx('svc-canary-collision'),
      { message: { role: 'user', content: 'hi' } },
    );

    // Mapped to a clean terminated outcome — never an uncaught throw (which
    // would hang the SSE).
    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('connector-services-invalid');
    // The collision short-circuited BEFORE the sandbox opened.
    expect(mocks.trace.sandboxOpen).toBe(0);
    // The SSE client got an error frame (so it doesn't hang on "Thinking…").
    expect(mocks.trace.turnErrors.some((e) => e.reason === 'connector-services-invalid')).toBe(true);
  });

  it('error path: a forbidden-vocab descriptor is rejected by services:validate → terminated(connector-services-invalid)', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    // A connector smuggling a backend-vocabulary key (`securityContext`) into a
    // descriptor. The fold forwards it; the REAL services:validate rejects it
    // (I2 — forbidden vocab at any depth), and the orchestrator maps the
    // non-clean verdict to a terminated outcome.
    const smuggled = {
      name: 'mongo',
      image: 'mongo' + DIGEST,
      ports: [27017],
      env: {},
      writablePaths: [],
      securityContext: { privileged: true },
    } as unknown as ServiceDescriptorParsed;
    const mocks = buildMocks(busRef, [
      { id: 'sneaky', capabilities: connectorCaps([smuggled]) },
    ]);
    const h = await makeHarness(busRef, mocks);

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      canaryCtx('svc-canary-smuggle'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('connector-services-invalid');
    expect(mocks.trace.sandboxOpen).toBe(0);
    expect(mocks.trace.turnErrors.some((e) => e.reason === 'connector-services-invalid')).toBe(true);
  });

  // TASK-160 — the SELF-DIAGNOSING failure path, end to end through the REAL
  // orchestrator: a backend that throws a PluginError carrying a neutral
  // `diagnosis` ({ service, path, reason }) is surfaced to the author as
  // `dev-service-failed` + an actionable `detail` line naming the service +
  // offending path. (The backend-specific detection is unit-tested in each
  // sandbox plugin; this proves the orchestrator's surfacing.)
  it('failure path: a sidecar startup failure → terminated(dev-service-failed) + actionable detail', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const mocks = buildMocks(busRef, [
      { id: 'kafka-only', capabilities: connectorCaps([KAFKA_SVC]) },
    ]);
    mocks.openSessionThrows.current = new PluginError({
      code: 'service-sidecar-failed',
      plugin: '@ax/sandbox-k8s',
      hookName: 'sandbox:open-session',
      message: "dev service 'kafka' failed to start",
      diagnosis: {
        service: 'kafka',
        path: '/var/lib/kafka/data',
        reason: 'read-only filesystem',
      },
    });
    const h = await makeHarness(busRef, mocks);

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      canaryCtx('svc-canary-sidecar-fail'),
      { message: { role: 'user', content: 'hi' } },
    );

    expect(outcome.kind).toBe('terminated');
    expect((outcome as { reason: string }).reason).toBe('dev-service-failed');
    // The author-facing error frame names the service + path + the fix.
    const frame = mocks.trace.turnErrors.find((e) => e.reason === 'dev-service-failed');
    expect(frame).toBeDefined();
    expect(frame!.detail).toContain("'kafka'");
    expect(frame!.detail).toContain('/var/lib/kafka/data');
    expect(frame!.detail).toContain('writablePaths');
    // Single-line, untrusted-safe (no control chars survived the formatter).
    expect(frame!.detail).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
