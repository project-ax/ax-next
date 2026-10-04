import { z } from 'zod';

export const BOOTSTRAP_MAX_BYTES = 512 * 1024;
export const BOOTSTRAP_ROOT = '/ax/late/bootstrap';
export const BOOTSTRAP_FILE = 'session.json';
export const BOOTSTRAP_ACK = 'accepted.json';

/** Per-session proxy token: 32 lowercase hex (mirrors ProxyConfigSchema). */
const PROXY_TOKEN_FORMAT = /^[0-9a-f]{32}$/;

const controlNames = new Set([
  'AX_SESSION_ID', 'AX_AUTH_TOKEN', 'AX_RUNNER_ENDPOINT', 'AX_REQUEST_ID',
  'AX_PROXY_ENDPOINT', 'AX_PROXY_TOKEN', 'AX_PROXY_CA_PEM', 'AX_INSTALLED_SKILLS_JSON',
  'AX_WORKSPACE_ROOT', 'AX_EPHEMERAL_ROOT', 'AX_USERFILES_ROOT', 'AX_MEMORY_ROOT',
  'AX_COMMIT_TRACE', 'HOME', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'DENO_CERT',
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_COUNT',
]);
const fixedPaths: Record<string, string> = {
  AX_WORKSPACE_ROOT: '/agent', AX_EPHEMERAL_ROOT: '/ephemeral',
  AX_USERFILES_ROOT: '/files', AX_MEMORY_ROOT: '/memory',
  HOME: '/home/runner', CLAUDE_CONFIG_DIR: '/home/runner/.ax/session',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  NODE_EXTRA_CA_CERTS: '/home/runner/.ax/proxy-ca/ca.crt',
  SSL_CERT_FILE: '/home/runner/.ax/proxy-ca/ca.crt',
  GIT_SSL_CAINFO: '/home/runner/.ax/proxy-ca/ca.crt',
  DENO_CERT: '/home/runner/.ax/proxy-ca/ca.crt',
};

/** Environment is a process capability, not an arbitrary settings dictionary. */
export function allowedBootstrapEnv(name: string, value: string): boolean {
  if (value.includes('\0') || value.length > 256 * 1024) return false;
  if (fixedPaths[name] !== undefined && value !== fixedPaths[name]) return false;
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
