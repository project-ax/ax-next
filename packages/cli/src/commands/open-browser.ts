// Open a URL in the user's default browser. Pure spawn — never `exec`,
// never template-interpolated shells, never argv concatenation.
//
// This file is the only place in @ax/cli that calls into the platform's
// "open" tool. Centralizing it makes the threat model trivially auditable:
// (1) URL must be one of our authorized OAuth origins, (2) spawn() with
// arg array bypasses shell entirely. (Phase 3 I13.)

import { spawn } from 'node:child_process';
import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/cli';

// Origins we'll let the CLI shove at a browser. Anything else throws.
// Anthropic's OAuth redirects users through claude.ai/oauth/authorize and
// occasionally console.anthropic.com. Add more origins here when we
// genuinely need them — refusing-by-default is the safer posture.
const ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  'https://console.anthropic.com',
]);

export function openBrowser(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginError({
      code: 'invalid-url',
      plugin: PLUGIN_NAME,
      message: `refusing to open malformed URL`,
    });
  }
  if (!ALLOWED_ORIGINS.has(parsed.origin)) {
    throw new PluginError({
      code: 'unsafe-open-url',
      plugin: PLUGIN_NAME,
      message: `refusing to open non-anthropic origin: ${parsed.origin}`,
    });
  }
  const final = parsed.toString();
  // spawn() reports missing binaries via an asynchronous 'error' event,
  // not a synchronous throw. Without an attached listener, a headless
  // host (no `open` / `xdg-open` / `cmd` available) crashes the process
  // AFTER this function returns — bypassing the caller's try/catch and
  // the printed-URL fallback. Swallow it explicitly: the user already
  // sees the URL on stdout and can paste it manually.
  let child;
  if (process.platform === 'darwin') {
    child = spawn('open', [final], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    // The empty string after 'start' is the title arg — required by start's
    // syntax to disambiguate when the URL itself starts with quotes. cmd's
    // /c is a fixed flag, not user input.
    child = spawn('cmd', ['/c', 'start', '', final], {
      detached: true,
      stdio: 'ignore',
    });
  } else {
    child = spawn('xdg-open', [final], { detached: true, stdio: 'ignore' });
  }
  child.on('error', () => {
    // best-effort — caller already printed the URL to stdout
  });
  child.unref();
}
