import { connectorLabel, type ResolvedConnectorForOrch } from './connector-union.js';

// ---------------------------------------------------------------------------
// Dev services on demand (spec §3): service sets, the note a restarted runner
// wakes up to, and the per-agent cap.
//
// A SERVICE SET is an on-demand connector's services, named by the
// connector's id. A conversation turns one on with `restart_with_services`
// (service-tools.ts); the orchestrator then folds that set into the
// conversation's sandboxes (connector-union.ts, `foldConnectorCaps`'
// `serviceSet`) until `stop_services` turns it off.
//
// The note (`buildServicesNote`) speaks with AX's voice, and quoting doesn't
// lower that authority, so it is built ONLY from host constants, set ids and
// service names re-checked against SAFE_NAME_RE here, and numeric ports. It
// never carries a connector's name or description, env values, commands or
// images (spec §8).
// ---------------------------------------------------------------------------

/** Set ids and service names that may reach the agent: letters, digits, `.`, `_`, `-`. */
export const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** What a set's service offers the sandbox: its name and ports. Nothing else. */
export interface ServiceSetService {
  name: string;
  ports: number[];
  publishedPorts: Array<{ published: number; target: number }>;
}

export interface ServiceSet {
  /** The set's id (the on-demand connector's id). What the tool takes. */
  set: string;
  /** The connector's display name, one sanitized line (`connectorLabel`). Prompt list only; never in the note. */
  label: string;
  services: ServiceSetService[];
}

function isPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * The service sets these connectors offer: every on-demand connector with at
 * least one service, in connector order, first id wins. A set id or a service
 * name outside SAFE_NAME_RE is left out (the schemas already limit both; this
 * is the second check at the point they reach the agent), and so is a port
 * that isn't one.
 */
export function listServiceSets(connectors: readonly ResolvedConnectorForOrch[]): ServiceSet[] {
  const out: ServiceSet[] = [];
  const seen = new Set<string>();
  for (const c of connectors) {
    if (c.capabilities.servicesMode !== 'on-demand') continue;
    if (!SAFE_NAME_RE.test(c.id) || seen.has(c.id)) continue;
    const services: ServiceSetService[] = [];
    for (const s of c.capabilities.services ?? []) {
      if (typeof s.name !== 'string' || !SAFE_NAME_RE.test(s.name)) continue;
      services.push({
        name: s.name,
        ports: (s.ports ?? []).filter(isPort),
        publishedPorts: (s.publishedPorts ?? []).filter((p) => isPort(p.published) && isPort(p.target)),
      });
    }
    if (services.length === 0) continue;
    seen.add(c.id);
    out.push({ set: c.id, label: connectorLabel(c), services });
  }
  return out;
}

/** The set named `requested` among `sets`, or null. */
export function selectServiceSet(sets: readonly ServiceSet[], requested: string | null): ServiceSet | null {
  if (requested === null) return null;
  return sets.find((s) => s.set === requested) ?? null;
}

/** The host-note wire limit (@ax/ipc-protocol `HOST_NOTE_MAX`, mirrored: no import, I2). */
const HOST_NOTE_MAX = 4000;
/** Kept well under the limit, for the closing sentence. */
const NOTE_LIST_BUDGET = 3_400;

/** One service's addresses: `name:port` for each port, plus `localhost:N` where one is published. */
function serviceAddresses(s: ServiceSetService): string | null {
  if (!SAFE_NAME_RE.test(s.name)) return null;
  const inPod = s.ports.filter(isPort).map((p) => `${s.name}:${p}`);
  const local = s.publishedPorts
    .filter((p) => isPort(p.published) && isPort(p.target))
    .map((p) => `localhost:${p.published}`);
  if (inPod.length === 0 && local.length === 0) return `${s.name}`;
  const at = inPod.length > 0 ? inPod.join(', ') : local.join(', ');
  const also = inPod.length > 0 && local.length > 0 ? ` (also ${local.join(', ')})` : '';
  return `${s.name} at ${at}${also}`;
}

/**
 * The host-written note a restarted runner opens its turn with (spec §3.2
 * step 3). One line (the runner flattens notes to one line anyway), under the
 * host-note limit; services past the budget are counted, not listed.
 */
export function buildServicesNote(set: Pick<ServiceSet, 'set' | 'services'>): string {
  const setName = SAFE_NAME_RE.test(set.set) ? set.set : 'requested';
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const s of set.services) {
    const line = serviceAddresses(s);
    if (line === null) continue;
    if (used + line.length + 2 > NOTE_LIST_BUDGET) {
      omitted += 1;
      continue;
    }
    parts.push(line);
    used += line.length + 2;
  }
  const list = parts.join('; ') + (omitted > 0 ? `; and ${omitted} more` : '');
  const note =
    `You're now running with the ${setName} services, in a new sandbox: ${list}. ` +
    'Files you did not save before the restart are gone; the conversation is all here. ' +
    'Continue where you left off.';
  return note.length > HOST_NOTE_MAX ? note.slice(0, HOST_NOTE_MAX) : note;
}

/** The note when the set asked for could not be started with the new sandbox (it went away meanwhile). */
export const SERVICE_SET_UNAVAILABLE_NOTE =
  "You're in a new sandbox, but the service set you asked for is no longer available, so it runs " +
  'without services. Files you did not save before the restart are gone; the conversation is all ' +
  'here. Tell the person the services could not be started, then continue where you left off.';

/**
 * The system-prompt line telling the agent which sets it can start (spec §3.2:
 * "its description lists the agent's service sets"). The tool's description is
 * the same for every agent, so the per-agent list rides the prompt instead.
 * Empty when there are none. Labels are JSON-quoted, like the skipped
 * connectors line: they are admin-authored data. An outsider's turn gets no
 * labels.
 */
export function serviceSetsPromptLine(
  sets: readonly ServiceSet[],
  opts: { outsider?: boolean } = {},
): string {
  if (sets.length === 0) return '';
  // An outsider's turn (TASK-1091) hears no connector names: the set ids and
  // service names only.
  const listed = sets
    .map((s) =>
      opts.outsider === true
        ? `${JSON.stringify(s.set)} (${s.services.map((v) => v.name).join(', ')})`
        : `${JSON.stringify(s.set)} (${JSON.stringify(s.label)}: ${s.services.map((v) => v.name).join(', ')})`,
    )
    .join('; ');
  return (
    `Service sets you can start with restart_with_services: ${listed}. ` +
    'Starting one restarts your sandbox inside this turn, so save your work first (push your branch, ' +
    'or write to /files). Turn them off with stop_services.'
  );
}

/**
 * Live sandboxes with services plus pending restarts, per agent (spec §3.4).
 * In-memory and exact because the host is single-replica (the chart refuses
 * more: `ax-next.validateHostReplicas`). `tryReserve` checks and counts in one
 * synchronous step, so two restarts racing for the last slot can't both win.
 */
export class ServiceSandboxCounter {
  private readonly counts = new Map<string, number>();

  tryReserve(agentId: string, max: number): boolean {
    const n = this.counts.get(agentId) ?? 0;
    if (n >= max) return false;
    this.counts.set(agentId, n + 1);
    return true;
  }

  release(agentId: string): void {
    const n = this.counts.get(agentId) ?? 0;
    if (n <= 1) this.counts.delete(agentId);
    else this.counts.set(agentId, n - 1);
  }

  count(agentId: string): number {
    return this.counts.get(agentId) ?? 0;
  }
}

/** A restart the tool accepted that hasn't swapped the sandbox yet. */
export interface PendingServiceRestart {
  reqId: string;
  /** The sandbox the request runs in now; only its turn-ends are held. */
  sessionId: string;
  agentId: string;
  set: string;
  /** True once that sandbox's runner segment has ended (the held turn-end arrived). */
  segmentEnded: boolean;
  /**
   * Other requests the runner folded into that segment (its closing
   * turn-end's `foldedReqIds`): the continuing turn answers them, so they
   * settle with this request, never as a moved message (R30).
   */
  foldedReqIds: string[];
}

/**
 * The orchestrator's book of restarts and cap slots. Every method is
 * synchronous, so a check and the write it guards can't be interleaved.
 *
 * A slot is held first by a REQUEST (a restart the tool accepted, or a spawn
 * of a conversation whose set is on), then by the live SANDBOX that request
 * opened (`transfer`), until that sandbox is reaped, terminated or exits
 * (`releaseSession`). A request's slot that never reached a sandbox is
 * released when the request ends (`endInvoke`), whatever ended it.
 */
export class ServiceRestartBook {
  private readonly pending = new Map<string, PendingServiceRestart>();
  /** Requests that claimed their one restart (spec §3.2: no second restart in a turn). */
  private readonly restarted = new Set<string>();
  private readonly slotByReqId = new Map<string, string>();
  private readonly slotBySession = new Map<string, string>();

  constructor(private readonly counter: ServiceSandboxCounter) {}

  /** Accept a restart: one per request, and only inside the agent's cap. */
  claim(input: {
    reqId: string;
    sessionId: string;
    agentId: string;
    set: string;
    max: number;
  }): 'ok' | 'already-restarted' | 'at-cap' {
    if (this.restarted.has(input.reqId) || this.slotByReqId.has(input.reqId)) return 'already-restarted';
    if (!this.counter.tryReserve(input.agentId, input.max)) return 'at-cap';
    this.restarted.add(input.reqId);
    this.slotByReqId.set(input.reqId, input.agentId);
    this.pending.set(input.reqId, {
      reqId: input.reqId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      set: input.set,
      segmentEnded: false,
      foldedReqIds: [],
    });
    return 'ok';
  }

  /** The claim never took effect (the tool refused after claiming): forget it entirely. */
  unclaim(reqId: string): void {
    if (!this.pending.has(reqId)) return;
    this.pending.delete(reqId);
    this.restarted.delete(reqId);
    this.releaseRequestSlot(reqId);
  }

  /** A pending restart that won't happen (Stop, stop_services, a segment that wasn't held). Still counts as this request's one restart. */
  cancel(reqId: string): PendingServiceRestart | undefined {
    const p = this.pending.get(reqId);
    if (p === undefined) return undefined;
    this.pending.delete(reqId);
    this.releaseRequestSlot(reqId);
    return p;
  }

  pendingFor(reqId: string): PendingServiceRestart | undefined {
    return this.pending.get(reqId);
  }

  /** True only for a pending restart of exactly this request, in exactly this sandbox. */
  isHeld(sessionId: string, reqId: string): boolean {
    const p = this.pending.get(reqId);
    return p !== undefined && p.sessionId === sessionId;
  }

  /** The held segment ended, answering `foldedReqIds` too. False when nothing is held for this sandbox and request. */
  endSegment(sessionId: string, reqId: string, foldedReqIds: readonly string[] = []): boolean {
    const p = this.pending.get(reqId);
    if (p === undefined || p.sessionId !== sessionId) return false;
    p.segmentEnded = true;
    p.foldedReqIds = foldedReqIds.filter((id) => id !== reqId);
    return true;
  }

  /** The swap starts: the hold is consumed. The request keeps its slot for the new sandbox. */
  take(reqId: string): PendingServiceRestart | undefined {
    const p = this.pending.get(reqId);
    if (p !== undefined) this.pending.delete(reqId);
    return p;
  }

  /** A spawn that folds a set needs a slot: the request's own (a restart's), or a new one inside the cap. */
  reserveForSpawn(reqId: string, agentId: string, max: number): boolean {
    if (this.slotByReqId.has(reqId)) return true;
    if (!this.counter.tryReserve(agentId, max)) return false;
    this.slotByReqId.set(reqId, agentId);
    return true;
  }

  /** The request's spawn didn't fold its set after all (it went away): give the slot back now. */
  releaseRequestSlot(reqId: string): void {
    const agentId = this.slotByReqId.get(reqId);
    if (agentId === undefined) return;
    this.slotByReqId.delete(reqId);
    this.counter.release(agentId);
  }

  /** The request's sandbox opened with its set: the sandbox holds the slot from now on. */
  transfer(reqId: string, sessionId: string): void {
    const agentId = this.slotByReqId.get(reqId);
    if (agentId === undefined) return;
    this.slotByReqId.delete(reqId);
    this.slotBySession.set(sessionId, agentId);
  }

  /** A sandbox with a set is gone (reaped, terminated, retired, exited). Idempotent. */
  releaseSession(sessionId: string): void {
    const agentId = this.slotBySession.get(sessionId);
    if (agentId === undefined) return;
    this.slotBySession.delete(sessionId);
    this.counter.release(agentId);
  }

  /** The request ended, however it ended: release a slot no sandbox took, forget the rest. */
  endInvoke(reqId: string): void {
    this.pending.delete(reqId);
    this.restarted.delete(reqId);
    this.releaseRequestSlot(reqId);
  }
}
