/**
 * Agent-workspace prototype — mock backend.
 *
 * PROTOTYPE ONLY. This exists so the client code above it can be REAL client
 * code: it fetches over HTTP, handles optimistic updates and failures, and
 * knows nothing about where the data comes from. When the approvals substrate
 * ships, this file is deleted and `src/lib/workspace-api.ts` is pointed at the
 * real routes.
 *
 * State is in-memory, per server process — a page reload keeps it, restarting
 * Vite resets it. That is the right trade for a demo: switching scenarios has
 * to be instant and total, and nobody wants a stale `.mock-data/` file
 * deciding what today's queue looks like.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  approveDecision,
  dismissDecision,
  undoDecision,
} from './decision-machine';
import {
  FILES,
  MEMORY,
  PAST,
  PERMISSIONS,
  STATS,
  SUGGESTIONS,
  seedWorkspace,
  type WorkspaceState,
} from './workspace-seed';
import type { DemoScenario, ThreadMessage } from './workspace-types';

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
  return true;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export function workspaceMiddleware(): (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean> {
  let state: WorkspaceState = seedWorkspace('unattended');
  // Per-agent memory edits, so a save survives navigation within a session.
  let memoryEdits: Record<string, Record<string, string>> = {};

  const agent = (id: string) => state.agents.find((a) => a.id === id);

  return async (req, res) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (!url.startsWith('/api/workspace')) return false;
    const rest = url.slice('/api/workspace'.length);
    const method = req.method ?? 'GET';

    // ---- whole-board state -------------------------------------------------
    if (method === 'GET' && rest === '/state') {
      return json(res, 200, {
        scenario: state.scenario,
        agents: state.agents,
        decisions: state.decisions,
        activity: state.activity,
        stoppedAll: state.stoppedAll,
      });
    }

    // ---- scenario switch (dev control) ------------------------------------
    if (method === 'POST' && rest === '/scenario') {
      const body = await readBody(req);
      const next = String(body.scenario ?? 'unattended') as DemoScenario;
      state = seedWorkspace(next);
      memoryEdits = {};
      return json(res, 200, { scenario: state.scenario });
    }

    if (method === 'POST' && rest === '/stop-all') {
      const body = await readBody(req);
      state.stoppedAll = body.stopped === true;
      if (state.stoppedAll) {
        for (const a of state.agents) a.paused = true;
      } else {
        for (const a of state.agents) a.paused = false;
      }
      return json(res, 200, { stoppedAll: state.stoppedAll });
    }

    // ---- decisions ---------------------------------------------------------
    const decisionMatch = /^\/decisions\/([^/]+)\/(approve|dismiss|undo)$/.exec(
      rest,
    );
    if (method === 'POST' && decisionMatch) {
      const [, id, action] = decisionMatch;
      const idx = state.decisions.findIndex((d) => d.id === id);
      if (idx < 0) return json(res, 404, { error: 'no such decision' });
      const now = new Date().toISOString();
      const before = state.decisions[idx]!;

      if (action === 'approve') {
        const r = approveDecision(before, {
          now,
          freshness: state.world,
          changed: state.changed,
        });
        state.decisions[idx] = r.decision;
        if (r.event) state.activity = [r.event, ...state.activity];

        // An attended decision resolves while the agent is still warm, so the
        // conversation simply continues — no re-spawn, no replay.
        if (r.executed && r.path === 'agent-executes') {
          const thread = state.threads[before.agentId] ?? [];
          state.threads[before.agentId] = [
            ...thread.filter((m) => m.kind !== 'status'),
            {
              kind: 'agent',
              id: `x-${before.id}`,
              text: 'Sent. I have noted that you approved this, so I will be quicker about the same thing next time.',
              time: 'just now',
            },
            {
              kind: 'status',
              id: `x-status-${before.id}`,
              text: 'Back to reading this morning’s email',
            },
          ];
        }

        return json(res, 200, {
          decision: r.decision,
          executed: r.executed,
          path: r.path,
          event: r.event,
        });
      }

      if (action === 'dismiss') {
        const r = dismissDecision(before, { now });
        state.decisions[idx] = r.decision;
        if (r.event) state.activity = [r.event, ...state.activity];
        return json(res, 200, { decision: r.decision, event: r.event });
      }

      const r = undoDecision(before, { now });
      state.decisions[idx] = r.decision;
      if (r.undone) {
        // Pull the receipt back out of Activity — an undone action must not
        // leave a log line claiming it happened.
        state.activity = state.activity.filter((e) => e.decisionId !== id);
      }
      return json(res, 200, { decision: r.decision, undone: r.undone });
    }

    // ---- per-agent detail --------------------------------------------------
    const agentMatch = /^\/agents\/([^/]+)$/.exec(rest);
    if (method === 'GET' && agentMatch) {
      const id = agentMatch[1]!;
      const a = agent(id);
      if (!a) return json(res, 404, { error: 'no such agent' });
      const edits = memoryEdits[id] ?? {};
      return json(res, 200, {
        agent: a,
        permissions: PERMISSIONS[id] ?? [],
        stats: STATS[id] ?? [],
        past: PAST[id] ?? [],
        thread: state.threads[id] ?? [],
        files: FILES[id] ?? [],
        memory: (MEMORY[id] ?? []).map((d) =>
          edits[d.name] !== undefined ? { ...d, body: edits[d.name]! } : d,
        ),
        suggestions: SUGGESTIONS[id] ?? [],
      });
    }

    const messageMatch = /^\/agents\/([^/]+)\/messages$/.exec(rest);
    if (method === 'POST' && messageMatch) {
      const id = messageMatch[1]!;
      if (!agent(id)) return json(res, 404, { error: 'no such agent' });
      const body = await readBody(req);
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'empty message' });
      const stamp = Date.now();
      const thread = state.threads[id] ?? [];
      const appended: ThreadMessage[] = [
        ...thread.filter((m) => m.kind !== 'status'),
        { kind: 'user', id: `u-${stamp}`, text },
        {
          kind: 'agent',
          id: `a-${stamp}`,
          text: 'Understood — I have written that down and I will work that way from now on.',
          time: 'just now',
        },
      ];
      state.threads[id] = appended;
      return json(res, 200, { thread: appended });
    }

    const pauseMatch = /^\/agents\/([^/]+)\/pause$/.exec(rest);
    if (method === 'POST' && pauseMatch) {
      const id = pauseMatch[1]!;
      const a = agent(id);
      if (!a) return json(res, 404, { error: 'no such agent' });
      const body = await readBody(req);
      a.paused = body.paused === true;
      return json(res, 200, { agent: a });
    }

    const memoryMatch = /^\/agents\/([^/]+)\/memory$/.exec(rest);
    if (method === 'POST' && memoryMatch) {
      const id = memoryMatch[1]!;
      if (!agent(id)) return json(res, 404, { error: 'no such agent' });
      const body = await readBody(req);
      const name = String(body.name ?? '');
      const text = String(body.body ?? '');
      memoryEdits[id] = { ...(memoryEdits[id] ?? {}), [name]: text };
      return json(res, 200, { saved: true });
    }

    const restartMatch = /^\/agents\/([^/]+)\/restart$/.exec(rest);
    if (method === 'POST' && restartMatch) {
      const id = restartMatch[1]!;
      const a = agent(id);
      if (!a) return json(res, 404, { error: 'no such agent' });
      a.state = 'working';
      a.stoppedReason = null;
      a.now = 'Retrying the two nudges it could not send';
      a.counter = { done: 0, total: 2, unit: 'nudges' };
      a.startedAt = new Date().toISOString();
      state.activity = [
        {
          id: `ev-restart-${id}`,
          agentId: id,
          day: 'Today',
          text: `${a.name} retried and sent both nudges`,
          time: 'just now',
          kind: 'done',
          tag: null,
          decisionId: null,
        },
        ...state.activity.filter((e) => e.kind !== 'stopped'),
      ];
      return json(res, 200, { agent: a });
    }

    // ---- Auto routing -------------------------------------------------------
    // Keyword scoring, not a model. The point of the prototype here is the
    // INTERACTION — Auto proposes and the human confirms — not the classifier.
    // The real one is a small model over each agent's role; the failure mode it
    // has to survive is the same either way (wrong agent picked), which is
    // exactly why the UI confirms before dispatching rather than after.
    if (method === 'POST' && rest === '/route') {
      const body = await readBody(req);
      const text = String(body.text ?? '').toLowerCase();
      const rules: Array<[string, string, string[]]> = [
        ['scheduler', 'it is about your calendar', ['calendar', 'meeting', 'schedule', 'minutes with', 'clash', '1:1', 'book', 'invite', 'free', 'reschedule', 'move my']],
        ['inbox', 'it is about your email', ['email', 'mail', 'inbox', 'reply', 'draft', 'wrote to', 'unread']],
        ['slack', 'it is about Slack', ['slack', 'channel', 'thread', 'mentioned', 'digest', '#']],
        ['followups', 'it is about chasing someone', ['chase', 'nudge', 'follow up', 'follow-up', 'owes', 'owe me', 'waiting on', 'remind them']],
        ['travel', 'it is about a trip', ['flight', 'trip', 'travel', 'hotel', 'expense', 'fly']],
      ];
      let best: { agentId: string; why: string; score: number } | null = null;
      for (const [agentId, why, words] of rules) {
        const score = words.filter((w) => text.includes(w)).length;
        if (score > 0 && (best === null || score > best.score)) {
          best = { agentId, why, score };
        }
      }
      const chosen = best ?? {
        agentId: state.agents[0]?.id ?? 'inbox',
        why: 'nothing in it pointed anywhere in particular',
        score: 0,
      };
      const a = agent(chosen.agentId);
      return json(res, 200, {
        agentId: chosen.agentId,
        agentName: a?.name ?? chosen.agentId,
        why: chosen.why,
        confident: chosen.score > 0,
      });
    }

    // ---- create an agent ----------------------------------------------------
    if (method === 'POST' && rest === '/agents') {
      const body = await readBody(req);
      const brief = String(body.brief ?? '').trim();
      if (!brief) return json(res, 400, { error: 'empty brief' });
      const id = `custom-${state.agents.length}`;
      state.agents = [
        ...state.agents,
        {
          id,
          name: 'New agent',
          role: brief,
          icon: 'sparkles',
          state: 'resting',
          channel: 'web',
          now: 'Getting set up with you',
          counter: null,
          startedAt: null,
          stoppedReason: null,
          paused: false,
          footer: 'Created just now. Nothing has run yet.',
        },
      ];
      state.threads[id] = [
        { kind: 'user', id: `n-brief-${id}`, text: brief },
        {
          kind: 'agent',
          id: `n-hello-${id}`,
          text: 'Got it. Two things before I start, and then I will leave you alone: what should I call you when I write on your behalf, and what am I never allowed to do without asking?',
          time: 'just now',
        },
      ];
      return json(res, 200, { agentId: id });
    }

    return json(res, 404, { error: 'unknown workspace route' });
  };
}
