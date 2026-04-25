import type { K8sCoreApi } from '../k8s-api.js';

// ---------------------------------------------------------------------------
// Hand-rolled K8sCoreApi mock for the tests.
//
// The real client is too big to stub; our K8sCoreApi facade has just four
// methods. Each method is a queue-of-responses driven by per-test setup —
// `enqueueRead({ phase: 'Pending' })`, `enqueueRead({ phase: 'Running',
// podIP: '10.42.0.5' })`, etc. The implementation pops from the queue;
// over-popping reuses the LAST response so a poll loop sees stable state.
// ---------------------------------------------------------------------------

export interface MockPodStatus {
  phase?: string;
  podIP?: string;
  reason?: string;
  message?: string;
  ready?: boolean;
  conditions?: Array<{ type: string; status: string }>;
  containerStatuses?: Array<{
    name: string;
    state?: {
      terminated?: {
        exitCode?: number;
        signal?: number;
        reason?: string;
        message?: string;
      };
    };
  }>;
}

export interface MockPod {
  metadata?: { name?: string; namespace?: string };
  status?: MockPodStatus;
}

export interface MockK8sApi extends K8sCoreApi {
  /** Captured create requests — last index is most recent. */
  readonly creates: Array<{ namespace: string; body: unknown }>;
  /** Captured delete requests. */
  readonly deletes: Array<{
    name: string;
    namespace: string;
    gracePeriodSeconds?: number;
  }>;
  /** Captured read requests. */
  readonly reads: Array<{ name: string; namespace: string }>;
  /** Set or replace the next-N read responses; the LAST element sticks. */
  setReadResponses(...pods: MockPod[]): void;
  /** Make the next read fail with the given error. */
  setReadError(err: unknown): void;
  /** Make createNamespacedPod fail. */
  setCreateError(err: unknown): void;
  /** Make deleteNamespacedPod fail. */
  setDeleteError(err: unknown): void;
  /** Pop a one-shot read error if set, then clear. */
  hasOneShotReadError(): boolean;
}

export function makeMockK8sApi(): MockK8sApi {
  const creates: MockK8sApi['creates'] = [];
  const deletes: MockK8sApi['deletes'] = [];
  const reads: MockK8sApi['reads'] = [];
  let readQueue: MockPod[] = [{ status: { phase: 'Pending' } }];
  let readError: unknown = undefined;
  let createError: unknown = undefined;
  let deleteError: unknown = undefined;

  return {
    creates,
    deletes,
    reads,
    setReadResponses(...pods) {
      readQueue = pods.length > 0 ? [...pods] : [{ status: { phase: 'Pending' } }];
    },
    setReadError(err) {
      readError = err;
    },
    setCreateError(err) {
      createError = err;
    },
    setDeleteError(err) {
      deleteError = err;
    },
    hasOneShotReadError() {
      const had = readError !== undefined;
      readError = undefined;
      return had;
    },
    async createNamespacedPod(req) {
      creates.push({ namespace: req.namespace, body: req.body });
      if (createError !== undefined) {
        const err = createError;
        createError = undefined;
        throw err;
      }
      return { metadata: { name: 'created' } };
    },
    async readNamespacedPod(req) {
      reads.push({ name: req.name, namespace: req.namespace });
      if (readError !== undefined) {
        const err = readError;
        readError = undefined;
        throw err;
      }
      // Pop unless only one left — keep the last for stability.
      const next =
        readQueue.length > 1 ? readQueue.shift() ?? readQueue[0] : readQueue[0];
      return next as unknown;
    },
    async deleteNamespacedPod(req) {
      deletes.push({
        name: req.name,
        namespace: req.namespace,
        gracePeriodSeconds: req.gracePeriodSeconds,
      });
      if (deleteError !== undefined) {
        const err = deleteError;
        deleteError = undefined;
        throw err;
      }
      return { metadata: { name: req.name } };
    },
    async listNamespacedPod(_req) {
      return { items: [] };
    },
  };
}
