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
  initContainerStatuses?: Array<{
    name: string;
    state?: {
      waiting?: { reason?: string; message?: string };
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
  metadata?: {
    name?: string;
    namespace?: string;
    /** Real V1Pod carries this as a Date; the orphan-sweep ages off it. */
    creationTimestamp?: Date;
  };
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
  /** Captured list requests. */
  readonly lists: Array<{
    namespace: string;
    labelSelector?: string;
    limit?: number;
  }>;
  /** Captured pod-log read requests. */
  readonly logReads: Array<{
    name: string;
    namespace: string;
    container: string;
    tailLines?: number;
    previous?: boolean;
  }>;
  /** Set or replace the next-N read responses; the LAST element sticks. */
  setReadResponses(...pods: MockPod[]): void;
  /** Make the next read fail with the given error. */
  setReadError(err: unknown): void;
  /** Stub the log returned for a given container (keyed by container name). A
   *  `previous: true` read falls back to the same stub. Unset → throws. */
  setLogResponse(container: string, text: string): void;
  /** Make createNamespacedPod fail. */
  setCreateError(err: unknown): void;
  /** Make the NEXT deleteNamespacedPod fail (one-shot — clears after one throw). */
  setDeleteError(err: unknown): void;
  /**
   * Queue a SEQUENCE of delete errors; each delete pops the next one and throws
   * it. When the queue is exhausted, deletes succeed. Pass nothing to clear.
   * Used by killPod retry tests (fail-then-succeed, persistent-failure).
   */
  setDeleteErrors(...errs: unknown[]): void;
  /** Set or replace the list response (the V1PodList.items returned). */
  setListResponses(...pods: MockPod[]): void;
  /** Make the next listNamespacedPod fail (one-shot). */
  setListError(err: unknown): void;
  /** Pop a one-shot read error if set, then clear. */
  hasOneShotReadError(): boolean;
}

export function makeMockK8sApi(): MockK8sApi {
  const creates: MockK8sApi['creates'] = [];
  const deletes: MockK8sApi['deletes'] = [];
  const reads: MockK8sApi['reads'] = [];
  const lists: MockK8sApi['lists'] = [];
  const logReads: MockK8sApi['logReads'] = [];
  const logResponses = new Map<string, string>();
  let readQueue: MockPod[] = [{ status: { phase: 'Pending' } }];
  let readError: unknown = undefined;
  let createError: unknown = undefined;
  let deleteError: unknown = undefined;
  let deleteErrorQueue: unknown[] = [];
  let listPods: MockPod[] = [];
  let listError: unknown = undefined;

  return {
    creates,
    deletes,
    reads,
    lists,
    logReads,
    setReadResponses(...pods) {
      readQueue = pods.length > 0 ? [...pods] : [{ status: { phase: 'Pending' } }];
    },
    setReadError(err) {
      readError = err;
    },
    setLogResponse(container, text) {
      logResponses.set(container, text);
    },
    setCreateError(err) {
      createError = err;
    },
    setDeleteError(err) {
      deleteError = err;
    },
    setDeleteErrors(...errs) {
      deleteErrorQueue = [...errs];
    },
    setListResponses(...pods) {
      listPods = [...pods];
    },
    setListError(err) {
      listError = err;
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
    async readNamespacedPodLog(req) {
      logReads.push({
        name: req.name,
        namespace: req.namespace,
        container: req.container,
        tailLines: req.tailLines,
        previous: req.previous,
      });
      const text = logResponses.get(req.container);
      if (text === undefined) {
        throw new Error(`no log stubbed for container ${req.container}`);
      }
      return text;
    },
    async deleteNamespacedPod(req) {
      deletes.push({
        name: req.name,
        namespace: req.namespace,
        gracePeriodSeconds: req.gracePeriodSeconds,
      });
      // Queue of errors takes priority — each delete pops the next one.
      if (deleteErrorQueue.length > 0) {
        throw deleteErrorQueue.shift();
      }
      if (deleteError !== undefined) {
        const err = deleteError;
        deleteError = undefined;
        throw err;
      }
      return { metadata: { name: req.name } };
    },
    async listNamespacedPod(req) {
      lists.push({
        namespace: req.namespace,
        labelSelector: req.labelSelector,
        limit: req.limit,
      });
      if (listError !== undefined) {
        const err = listError;
        listError = undefined;
        throw err;
      }
      return { items: listPods };
    },
  };
}
