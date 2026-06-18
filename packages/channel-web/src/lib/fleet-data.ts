/**
 * Fleet data model + mock seed (clickable prototype).
 *
 * This is the *shape* a real `GET /api/fleet` endpoint would return, plus a
 * hand-authored sample so the Fleet surface is fully clickable without any
 * backend wiring. When the real endpoint lands, swap `seedFleet()` for a fetch
 * and delete this seed — the component layer reads only `FleetAgent`.
 *
 * Modelling note (why this shape): in ax-next an "agent" is a persistent record
 * (`agents` table); "what it's working on" is its conversations that currently
 * hold a live session (`conversations.active_session_id IS NOT NULL`); "recent
 * activity" is its conversations ordered by `last_activity_at`. None of that
 * vocabulary leaks here — the wire shape speaks only `status` / `activity`, never
 * `active_session_id` / `pod_name` (Invariant #1). Board-draining workers
 * (yolo-ship) are the same machinery with a narrow "work TASK-X" context, so
 * they ride the same shape with a few worker-only fields.
 */

/** Coarse, user-facing status — never a backend session/pod term. */
export type FleetStatus = 'working' | 'waiting' | 'idle' | 'error';

/** Interactive agents you chat with vs. autonomous board-draining workers. */
export type FleetKind = 'interactive' | 'worker';

export interface FleetActivityItem {
  id: string;
  title: string;
  state: 'working' | 'done' | 'failed';
  /** Human label, e.g. "4m", "yesterday". */
  when: string;
}

export interface FleetAgent {
  id: string;
  name: string;
  /** Avatar gradient seed — reused from the chat AgentChip for identity parity. */
  color: string;
  kind: FleetKind;
  status: FleetStatus;
  owner: 'mine' | 'team';

  /** One-line "what it's doing now" (working) or "what it last did" (idle). */
  activity: string;
  /** Short phase label derived from the latest stream chunk kind. */
  phase?: string;
  /** 0–100 turn-phase hint; omit for an honest indeterminate shimmer. */
  progress?: number;
  /** "started 4m ago" when working. */
  startedLabel?: string;
  /** "last active 2h ago" when idle. */
  lastLabel?: string;

  /** Config summary, shown in the detail sheet behind a collapse. */
  model: string;
  toolCount: number;
  connectorCount: number;

  /** Worker-only: the task board card + its PR. */
  taskId?: string;
  prNumber?: number;
  prState?: 'draft' | 'open' | 'merged';

  /** waiting-only: the one thing the agent needs from a human. */
  request?: string;

  /** A short tail of the live turn stream (detail sheet). */
  liveTail?: string[];
  /** The agent's recent conversations / runs (detail sheet). */
  recent: FleetActivityItem[];
}

/**
 * The order statuses sort into on the wall: "needs you" first (it's the only
 * thing that can't wait), then what's moving, then what's at rest.
 */
export const STATUS_ORDER: FleetStatus[] = ['waiting', 'working', 'error', 'idle'];

export function seedFleet(): FleetAgent[] {
  return [
    {
      id: 'ax',
      name: 'ax',
      color: '#7aa6c9',
      kind: 'interactive',
      status: 'working',
      owner: 'mine',
      activity: 'Refactoring the auth middleware',
      phase: 'editing files',
      progress: 62,
      startedLabel: 'started 4m ago',
      model: 'claude-opus-4-8',
      toolCount: 7,
      connectorCount: 2,
      liveTail: [
        'reading packages/auth/src/middleware.ts',
        'applying edit (3 hunks)',
        'running pnpm test --filter @ax/auth',
      ],
      recent: [
        { id: 'a1', title: 'Refactoring the auth middleware', state: 'working', when: '4m' },
        { id: 'a2', title: 'Fixed a flaky session test', state: 'done', when: '1h' },
        { id: 'a3', title: 'Investigated an SSE disconnect', state: 'done', when: 'yesterday' },
      ],
    },
    {
      id: 'mercy',
      name: 'mercy',
      color: '#b08968',
      kind: 'interactive',
      status: 'waiting',
      owner: 'mine',
      activity: 'Paused — waiting for your go-ahead',
      request: 'wants to run `npm publish` before continuing',
      startedLabel: 'waiting for 2m',
      model: 'claude-opus-4-8',
      toolCount: 5,
      connectorCount: 1,
      recent: [
        { id: 'm1', title: 'Drafting the Q3 vendor contract', state: 'working', when: '2m' },
        { id: 'm2', title: 'Reviewed the NDA redlines', state: 'done', when: '3h' },
      ],
    },
    {
      id: 'ship-it-2',
      name: 'Ship-it #2',
      color: '#7c9c7a',
      kind: 'worker',
      status: 'working',
      owner: 'team',
      activity: 'TASK-142 · add a rate limiter to the API',
      phase: 'writing tests',
      progress: 34,
      startedLabel: 'started 11m ago',
      model: 'claude-opus-4-8',
      toolCount: 12,
      connectorCount: 0,
      taskId: 'TASK-142',
      prNumber: 318,
      prState: 'draft',
      liveTail: [
        'wrote packages/http-server/src/rate-limit.ts',
        'adding rate-limit.test.ts',
        'pnpm test --filter @ax/http-server',
      ],
      recent: [
        { id: 's2a', title: 'TASK-142 · add a rate limiter', state: 'working', when: '11m' },
        { id: 's2b', title: 'TASK-130 · cache provider lookups', state: 'done', when: '2h' },
      ],
    },
    {
      id: 'ship-it-1',
      name: 'Ship-it #1',
      color: '#9c7aa6',
      kind: 'worker',
      status: 'working',
      owner: 'team',
      activity: 'TASK-138 · migrate sessions table to Postgres',
      phase: 'thinking',
      // No progress — we genuinely can't tell yet, so don't fake a number.
      startedLabel: 'started 22m ago',
      model: 'claude-opus-4-8',
      toolCount: 12,
      connectorCount: 0,
      taskId: 'TASK-138',
      prNumber: 317,
      prState: 'open',
      liveTail: [
        'reading docs/plans/2026-05-24-current-architecture.md',
        'planning the migration in 3 steps',
      ],
      recent: [
        { id: 's1a', title: 'TASK-138 · migrate sessions table', state: 'working', when: '22m' },
        { id: 's1b', title: 'TASK-121 · add idle-reap timer', state: 'done', when: 'yesterday' },
      ],
    },
    {
      id: 'ship-it-3',
      name: 'Ship-it #3',
      color: '#c97a7a',
      kind: 'worker',
      status: 'error',
      owner: 'team',
      activity: 'TASK-151 · wire the audit log subscriber',
      startedLabel: 'stopped 6m ago',
      model: 'claude-opus-4-8',
      toolCount: 12,
      connectorCount: 0,
      taskId: 'TASK-151',
      recent: [
        { id: 's3a', title: 'TASK-151 · wire the audit log subscriber', state: 'failed', when: '6m' },
        { id: 's3b', title: 'TASK-140 · add boundary-review lint', state: 'done', when: '5h' },
      ],
    },
    {
      id: 'team-engineering',
      name: 'engineering',
      color: '#7c9c7a',
      kind: 'interactive',
      status: 'idle',
      owner: 'team',
      activity: 'Summarized the Q2 incident report',
      lastLabel: 'last active 2h ago',
      model: 'claude-sonnet-4-6',
      toolCount: 4,
      connectorCount: 3,
      recent: [
        { id: 'e1', title: 'Summarized the Q2 incident report', state: 'done', when: '2h' },
        { id: 'e2', title: 'Triaged 11 new issues', state: 'done', when: 'yesterday' },
      ],
    },
    {
      id: 'ship-it-4',
      name: 'Ship-it #4',
      color: '#7a8cc9',
      kind: 'worker',
      status: 'idle',
      owner: 'team',
      activity: 'All caught up — the task lane is empty',
      lastLabel: 'last active 40m ago',
      model: 'claude-opus-4-8',
      toolCount: 12,
      connectorCount: 0,
      recent: [
        { id: 's4a', title: 'TASK-129 · fix the title-event SSE leak', state: 'done', when: '40m' },
      ],
    },
  ];
}
