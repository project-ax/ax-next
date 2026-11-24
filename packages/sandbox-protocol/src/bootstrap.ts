import { z } from 'zod';

export const BOOTSTRAP_MAX_BYTES = 512 * 1024;
export const BOOTSTRAP_ROOT = '/ax/late/bootstrap';
export const BOOTSTRAP_FILE = 'session.json';
export const BOOTSTRAP_ACK = 'accepted.json';

/** Per-session proxy token: 32 lowercase hex (mirrors ProxyConfigSchema). */
const PROXY_TOKEN_FORMAT = /^[0-9a-f]{32}$/;

/**
 * The k8s runner pod's scratch root: the size-capped disk emptyDir mounted at
 * `/tmp` and stamped as AX_EPHEMERAL_ROOT. It holds the session's uploads, SDK
 * transcripts, tool caches, venvs and clones, and goes away with the pod. The
 * pod spec (mount + env), this allowlist's pin and the warm standby's venv
 * template must all name the same path, so they all read this one constant.
 */
export const POD_SCRATCH_ROOT = '/tmp';

const controlNames = new Set([
  'AX_SESSION_ID', 'AX_AUTH_TOKEN', 'AX_RUNNER_ENDPOINT', 'AX_REQUEST_ID',
  'AX_PROXY_ENDPOINT', 'AX_PROXY_TOKEN', 'AX_PROXY_CA_PEM', 'AX_INSTALLED_SKILLS_JSON',
  'AX_EPHEMERAL_ROOT', 'AX_USERFILES_ROOT', 'AX_MEMORY_ROOT', 'AX_TRANSCRIPTS_ROOT',
  'AX_COMMIT_TRACE', 'HOME', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'DENO_CERT',
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_COUNT',
  'AX_INBOX_IDLE_MS', 'AX_TURN_LIMIT_MS',
  // AX_SERVICE_FORWARDS and AX_USERFILES_READONLY are deliberately NOT here: pods
  // with services never take the shared warm pool, so a bootstrap assignment can
  // never legitimately carry them. They reach the runner through the pod spec.
]);
/** Whole milliseconds only: these two feed timers, so no signs, decimals or exponents. */
const timingNames = new Set(['AX_INBOX_IDLE_MS', 'AX_TURN_LIMIT_MS']);
const fixedPaths: Record<string, string> = {
  AX_EPHEMERAL_ROOT: POD_SCRATCH_ROOT,
  AX_USERFILES_ROOT: '/files', AX_MEMORY_ROOT: '/memory', AX_TRANSCRIPTS_ROOT: `${POD_SCRATCH_ROOT}/transcripts`,
  HOME: '/home/runner', CLAUDE_CONFIG_DIR: '/home/runner/.ax/session',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  NODE_EXTRA_CA_CERTS: '/home/runner/.ax/proxy-ca/ca.crt',
  SSL_CERT_FILE: '/home/runner/.ax/proxy-ca/ca.crt',
  GIT_SSL_CAINFO: '/home/runner/.ax/proxy-ca/ca.crt',
  DENO_CERT: '/home/runner/.ax/proxy-ca/ca.crt',
};

/**
 * `AX_SERVICE_FORWARDS`: the runner's loopback forwards for published service
 * ports, as a JSON array of `{published, target}` integer pairs (1..65535), at
 * most 64, no other keys, bounded length. Strict on purpose: this is JSON in an
 * env var, so it must never become a general passthrough. No `target` may equal
 * any `published` port in the map: a forward that feeds another forward (or
 * itself) would chain loopback connections until the runner runs out of
 * sockets. Shared by the pod spec (host side) and `readRunnerEnv` (runner).
 * It is NOT on the bootstrap allowlist (pods with services skip the warm pool).
 */
export const SERVICE_FORWARDS_MAX_PAIRS = 64;
export const SERVICE_FORWARDS_MAX_CHARS = 4096;
export function parseServiceForwards(value: string): Array<{ published: number; target: number }> | null {
  if (value.length > SERVICE_FORWARDS_MAX_CHARS) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length > SERVICE_FORWARDS_MAX_PAIRS) return null;
  const out: Array<{ published: number; target: number }> = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes('published') || !keys.includes('target')) return null;
    const { published, target } = item as Record<string, unknown>;
    for (const n of [published, target]) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) return null;
    }
    out.push({ published: published as number, target: target as number });
  }
  const pub = new Set(out.map((f) => f.published));
  if (out.some((f) => pub.has(f.target))) return null;
  return out;
}

/** Environment is a process capability, not an arbitrary settings dictionary. */
export function allowedBootstrapEnv(name: string, value: string): boolean {
  if (value.includes('\0') || value.length > 256 * 1024) return false;
  if (fixedPaths[name] !== undefined && value !== fixedPaths[name]) return false;
  if (timingNames.has(name)) return /^[1-9][0-9]{0,14}$/.test(value);
  if (controlNames.has(name)) return true;
  if (/^GIT_CONFIG_(?:KEY|VALUE)_(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(name)) return true;
  // Only proxy placeholders can add provider-specific names. No loader/control vars.
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(name) &&
    !/^(?:AX_|NODE_|LD_|GIT_|DYLD_)/.test(name) &&
    !['PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'PYTHONPATH', 'PYTHONHOME'].includes(name) &&
    /^ax-cred:[a-zA-Z0-9_-]{1,128}$/.test(value);
}

/** Also usable for an assigned warm container outside Kubernetes. */
export const BootstrapAssignmentSchema = z.object({
  version: z.literal(1), assignmentId: z.string().uuid(),
  instanceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  expiresAt: z.number().int().positive(),
  env: z.record(z.string(), z.string()).superRefine((env, ctx) => {
    if (Object.keys(env).length > 160 || Object.entries(env).some(([k, v]) => !allowedBootstrapEnv(k, v))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid bootstrap environment' });
    }
    for (const k of ['AX_SESSION_ID', 'AX_AUTH_TOKEN', 'AX_RUNNER_ENDPOINT', 'AX_PROXY_ENDPOINT', 'AX_PROXY_TOKEN']) {
      if (!env[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing bootstrap environment' });
    }
    // TASK-784 — the per-session proxy token is the proxy's caller credential
    // (TASK-158); the runner refuses to boot without a well-formed one
    // (TASK-704). Refuse it here too, host-side, so a bad assignment never
    // reaches a warm container. The message never echoes the value.
    if (env.AX_PROXY_TOKEN !== undefined && !PROXY_TOKEN_FORMAT.test(env.AX_PROXY_TOKEN)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid bootstrap proxy token' });
    }
    for (const [name, value] of Object.entries(env)) {
      if (/^GIT_CONFIG_KEY_/.test(name) && value !== 'safe.directory' &&
          !/^url\.https:\/\/x-access-token:ax-cred:[a-zA-Z0-9_-]+@[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/\.insteadOf$/.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid bootstrap git configuration' });
      }
    }
  }),
}).strict();
export type BootstrapAssignment = z.infer<typeof BootstrapAssignmentSchema>;
