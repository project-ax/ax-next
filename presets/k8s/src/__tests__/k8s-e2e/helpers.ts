/**
 * Shared helpers for the k8s-e2e suite.
 *
 * Drives a running kind cluster (`ax-next-dev`) via the host pod's
 * port-forward at http://localhost:9090 and `kubectl exec` into the
 * postgres pod. Read by the regression tests in
 * `runner-owned-sessions-k8s-gap.test.ts`.
 *
 * The suite is gated on `AX_K8S_E2E=1` at the test level — these helpers
 * just throw if invoked without the harness already up.
 */
import { spawnSync } from 'node:child_process';

export const HOST_BASE_URL =
  process.env.AX_K8S_E2E_HOST ?? 'http://localhost:9090';

const NAMESPACE = process.env.AX_K8S_E2E_NAMESPACE ?? 'ax-next';
const RUNNER_NAMESPACE =
  process.env.AX_K8S_E2E_RUNNER_NAMESPACE ?? 'ax-next-runners';
const POSTGRES_POD =
  process.env.AX_K8S_E2E_POSTGRES_POD ?? 'ax-next-postgresql-0';
const POSTGRES_DB = process.env.AX_K8S_E2E_POSTGRES_DB ?? 'ax_next';
const POSTGRES_USER = process.env.AX_K8S_E2E_POSTGRES_USER ?? 'ax_next';
const POSTGRES_SECRET =
  process.env.AX_K8S_E2E_POSTGRES_SECRET ?? 'ax-next-postgresql';
const HOST_DEPLOYMENT =
  process.env.AX_K8S_E2E_HOST_DEPLOYMENT ?? 'deploy/ax-next-host';
const DEV_BOOTSTRAP_TOKEN =
  process.env.AX_K8S_E2E_DEV_BOOTSTRAP_TOKEN ??
  'kind-dev-bootstrap-token-not-secret';

export interface SignInResult {
  cookie: string;
  userId: string;
}

/**
 * Sign in via `/auth/dev-bootstrap`. Returns the raw `Cookie:` header
 * value plus the userId; tests forward both into subsequent calls.
 */
export async function signIn(): Promise<SignInResult> {
  const res = await fetch(`${HOST_BASE_URL}/auth/dev-bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
    },
    body: JSON.stringify({ token: DEV_BOOTSTRAP_TOKEN }),
  });
  if (!res.ok) {
    throw new Error(
      `dev-bootstrap failed: ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('dev-bootstrap returned no Set-Cookie');
  const match = setCookie.match(/(ax_auth_session=[^;]+)/);
  if (!match) {
    throw new Error(`dev-bootstrap Set-Cookie unparseable: ${setCookie}`);
  }
  const cookie = match[1]!;
  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

export interface AdminAgentInput {
  displayName: string;
  systemPrompt: string;
  /** Empty means dev-mode bypass; default uses ['bash'] which is innocuous. */
  allowedTools?: string[];
  mcpConfigIds?: string[];
  model: string;
  visibility?: 'personal' | 'team';
}

export interface AdminAgent {
  id: string;
  displayName: string;
  model: string;
}

/**
 * POST /admin/agents — create a probe agent with a deterministic system
 * prompt. Tests that exercise turn-to-turn memory pin the model on the
 * agent record so a future model rotation doesn't silently change the
 * test's behavior under it.
 */
export async function createAgent(
  cookie: string,
  input: AdminAgentInput,
): Promise<AdminAgent> {
  const body = {
    displayName: input.displayName,
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools ?? ['bash'],
    mcpConfigIds: input.mcpConfigIds ?? [],
    model: input.model,
    visibility: input.visibility ?? 'personal',
  };
  const res = await fetch(`${HOST_BASE_URL}/admin/agents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
      cookie,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `POST /admin/agents failed: ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
  const out = (await res.json()) as {
    agent: { id: string; displayName: string; model: string };
  };
  return {
    id: out.agent.id,
    displayName: out.agent.displayName,
    model: out.agent.model,
  };
}

export async function deleteAgent(
  cookie: string,
  agentId: string,
): Promise<void> {
  const res = await fetch(
    `${HOST_BASE_URL}/admin/agents/${encodeURIComponent(agentId)}`,
    {
      method: 'DELETE',
      headers: { cookie, 'x-requested-with': 'ax-admin' },
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `DELETE /admin/agents/${agentId} failed: ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
}

export async function deleteConversation(
  cookie: string,
  conversationId: string,
): Promise<void> {
  const res = await fetch(
    `${HOST_BASE_URL}/api/chat/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: 'DELETE',
      headers: { cookie, 'x-requested-with': 'ax-admin' },
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `DELETE conversation ${conversationId} failed: ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
}

export interface PostMessageResult {
  conversationId: string;
  reqId: string;
}

/**
 * POST /api/chat/messages — server returns 202 with {conversationId, reqId}.
 * The browser then races to GET /api/chat/stream/:reqId — `consumeStream`
 * does that.
 */
export async function postMessage(
  cookie: string,
  args: {
    agentId: string;
    conversationId: string | null;
    text: string;
  },
): Promise<PostMessageResult> {
  const res = await fetch(`${HOST_BASE_URL}/api/chat/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-requested-with': 'ax-admin',
    },
    body: JSON.stringify({
      conversationId: args.conversationId,
      agentId: args.agentId,
      contentBlocks: [{ type: 'text', text: args.text }],
    }),
  });
  if (res.status !== 202) {
    throw new Error(
      `POST /api/chat/messages expected 202, got ${res.status}: ${await res.text().catch(() => '')}`,
    );
  }
  return (await res.json()) as PostMessageResult;
}

export interface ConsumedStream {
  /** Concatenated text frames (kind === 'text'). */
  text: string;
  /** Raw frame array, in order received. */
  frames: Array<Record<string, unknown>>;
  /** True if the stream ended with `{done:true}`; false if the connection
   *  closed without one (often a server crash). */
  doneSeen: boolean;
}

/**
 * Open `GET /api/chat/stream/:reqId` and read frames until either the
 * `{done:true}` frame arrives, the connection closes, or `timeoutMs`
 * elapses (in which case we throw — silent timeouts mask SSE bugs).
 */
export async function consumeStream(
  cookie: string,
  reqId: string,
  opts: { timeoutMs?: number } = {},
): Promise<ConsumedStream> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${HOST_BASE_URL}/api/chat/stream/${encodeURIComponent(reqId)}`,
      {
        headers: { cookie, accept: 'text/event-stream' },
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      throw new Error(
        `GET /api/chat/stream/${reqId} failed: ${res.status} ${await res.text().catch(() => '')}`,
      );
    }
    if (!res.body) throw new Error('SSE response had no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const frames: Array<Record<string, unknown>> = [];
    let doneSeen = false;

    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data: ')) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
        } catch {
          continue;
        }
        frames.push(frame);
        if (frame['done'] === true) {
          doneSeen = true;
          break outer;
        }
        if (frame['kind'] === 'text' && typeof frame['text'] === 'string') {
          text += frame['text'];
        }
      }
    }
    return { text, frames, doneSeen };
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: post + consume + return the assistant text + the ids. */
export async function sendAndWait(
  cookie: string,
  args: { agentId: string; conversationId: string | null; text: string },
  opts: { timeoutMs?: number } = {},
): Promise<{
  conversationId: string;
  reqId: string;
  reply: ConsumedStream;
}> {
  const { conversationId, reqId } = await postMessage(cookie, args);
  const reply = await consumeStream(cookie, reqId, opts);
  return { conversationId, reqId, reply };
}

/**
 * Post a chat-flow message and wait for the backend to complete it,
 * keyed off the host pod's `pod_exited` log line for the chat's reqId
 * (packages/sandbox-k8s/src/lifecycle.ts emits this after the runner
 * pod reaches a terminal phase). This signal is structurally
 * independent of all three bugs in the suite:
 *
 *   - Bug 1 (conversationId not threaded) corrupts `last_activity_at`
 *     bumps because handleTurnEnd early-returns when ctx.conversationId
 *     is undefined; we can't poll that.
 *   - Bug 2 (SSE done frame stuck) makes the obvious "wait for SSE done"
 *     unreliable.
 *   - Bug 3 lives entirely in the read path.
 *
 * Pod-exit-by-reqId is upstream of all of them — sandbox-k8s emits it
 * when the pod's phase reaches Succeeded/Failed regardless.
 */
export async function sendAndWaitForBackend(
  cookie: string,
  args: { agentId: string; conversationId: string | null; text: string },
  opts: { timeoutMs?: number } = {},
): Promise<PostMessageResult> {
  // Take a "since" anchor BEFORE the POST so we only consider logs
  // from this attempt onward. kubectl logs `--since-time=` would be
  // stricter, but `--since=Ns` with a generous window covers it.
  const result = await postMessage(cookie, args);
  await waitFor(
    () => {
      const log = getHostLogs('5m');
      // Match either `"reqId":"<id>" ... "msg":"pod_exited"` or
      // `"msg":"pod_exited" ... "reqId":"<id>"` — the runner host
      // emits both orderings depending on the structured-logger version.
      const ridQ = `"reqId":"${result.reqId}"`;
      if (!log.includes(ridQ)) return false;
      // Find lines containing both our reqId and pod_exited.
      return log
        .split('\n')
        .some((l) => l.includes(ridQ) && l.includes('"msg":"pod_exited"'));
    },
    {
      timeoutMs: opts.timeoutMs ?? 180_000,
      intervalMs: 1500,
      label: `pod_exited log for reqId=${result.reqId}`,
    },
  );
  return result;
}

// ---------------------------------------------------------------------------
// kubectl + database helpers.
//
// Each call shells out to `kubectl` and assumes the user's kubeconfig already
// points at the kind cluster. AX_K8S_E2E_KUBECTL lets a CI runner override.
// ---------------------------------------------------------------------------

const KUBECTL = process.env.AX_K8S_E2E_KUBECTL ?? 'kubectl';

interface KubectlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runKubectl(args: string[]): KubectlResult {
  const r = spawnSync(KUBECTL, args, { encoding: 'utf8' });
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function getPostgresPassword(): string {
  const r = runKubectl([
    '-n',
    NAMESPACE,
    'get',
    'secret',
    POSTGRES_SECRET,
    '-o',
    'jsonpath={.data.password}',
  ]);
  if (r.code !== 0) {
    throw new Error(
      `kubectl get secret ${POSTGRES_SECRET} failed: ${r.stderr}`,
    );
  }
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
}

/**
 * Run a SQL statement against the cluster's postgres via `kubectl exec`,
 * and return parsed rows (each row is the `\t`-separated tuple psql
 * yields with `-t -A`).
 */
export function dbQueryRows(sql: string): string[][] {
  const password = getPostgresPassword();
  const r = runKubectl([
    '-n',
    NAMESPACE,
    'exec',
    POSTGRES_POD,
    '--',
    'env',
    `PGPASSWORD=${password}`,
    'psql',
    '-U',
    POSTGRES_USER,
    '-d',
    POSTGRES_DB,
    '-A',
    '-t',
    '-F',
    '\t',
    '-c',
    sql,
  ]);
  if (r.code !== 0) {
    throw new Error(`psql failed: ${r.stderr}\nSQL: ${sql}`);
  }
  return r.stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}

export function dbQueryFirstCell(sql: string): string | null {
  const rows = dbQueryRows(sql);
  if (rows.length === 0) return null;
  const cell = rows[0]![0] ?? '';
  return cell.length === 0 ? null : cell;
}

/** Fetch the host pod's logs since `since` (e.g. '5m', '30s'). */
export function getHostLogs(since = '5m'): string {
  const r = runKubectl([
    '-n',
    NAMESPACE,
    'logs',
    HOST_DEPLOYMENT,
    `--since=${since}`,
    '--tail=2000',
  ]);
  if (r.code !== 0) {
    throw new Error(`kubectl logs ${HOST_DEPLOYMENT} failed: ${r.stderr}`);
  }
  return r.stdout;
}

/** Fetch logs from every runner pod currently visible (Running + Terminated). */
export function getRunnerLogs(since = '5m'): string {
  const r = runKubectl([
    '-n',
    RUNNER_NAMESPACE,
    'logs',
    '-l',
    'app.kubernetes.io/component=ax-next-runner',
    `--since=${since}`,
    '--tail=2000',
    '--all-containers',
    '--prefix',
  ]);
  // No runner pods yet → kubectl returns 0 with empty output. A real
  // failure returns non-zero; surface it as an error.
  if (r.code !== 0 && r.stderr.trim().length > 0) {
    throw new Error(
      `kubectl logs (runners) failed: ${r.stderr}`,
    );
  }
  return r.stdout;
}

/** `kubectl get pods -n ax-next-runners -o name` — count of currently-listed pods. */
export function countRunnerPods(): number {
  const r = runKubectl([
    '-n',
    RUNNER_NAMESPACE,
    'get',
    'pods',
    '-o',
    'name',
    '--no-headers',
  ]);
  if (r.code !== 0) {
    // Namespace missing is unusual but not fatal; treat as zero.
    if (/not found/i.test(r.stderr)) return 0;
    throw new Error(`kubectl get pods (runners) failed: ${r.stderr}`);
  }
  return r.stdout.split('\n').filter((l) => l.trim().length > 0).length;
}

/**
 * Wait until `predicate()` returns true, polling every `intervalMs`. Throws
 * on timeout. Used for "runner pods drained to zero" and similar
 * eventual-consistency probes.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<void> {
  const interval = opts.intervalMs ?? 250;
  const deadline = Date.now() + opts.timeoutMs;
  let last: unknown = undefined;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitFor timed out after ${opts.timeoutMs}ms: ${opts.label}` +
      (last instanceof Error ? ` (last error: ${last.message})` : ''),
  );
}
