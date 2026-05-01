/**
 * The full env passed to every `git` subprocess. NOT merged with `process.env`
 * — pass this object as-is to `spawn(..., { env: PARANOID_GIT_ENV })`.
 *
 * - GIT_CONFIG_NOSYSTEM=1   no /etc/gitconfig
 * - GIT_CONFIG_GLOBAL=/dev/null   no ~/.gitconfig
 * - GIT_TERMINAL_PROMPT=0   never block on a TTY
 * - HOME=/nonexistent       binary won't find anything if it tries
 * - PATH=/usr/bin:/bin      explicit, no inheritance
 */
export const PARANOID_GIT_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  PATH: '/usr/bin:/bin',
}) as Readonly<NodeJS.ProcessEnv>;
