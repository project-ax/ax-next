import { PluginError } from '@ax/core';
import {
  ToolExecuteHostRequestSchema,
  ToolExecuteHostResponseSchema,
  type ToolExecuteHostRequest,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  mapPluginError,
  notFound,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /tool.execute-host
//
// Looks up a service hook named `tool:execute:${call.name}`. This is the
// *dynamic* service-hook lookup exception — the same pattern the legacy
// tool-dispatcher uses. The `calls` manifest can't list a hook name that
// depends on caller-supplied data, so we document the exception in plugin.ts.
//
// 6.5a ships with NO host-side tools registered (all current tools run in
// the sandbox). The only path that gets real coverage here is the 404 — a
// sandbox-side tool dispatcher mis-routing to the host. The happy path
// lights up once host-only tools land (Week 10+).
// ---------------------------------------------------------------------------

export const toolExecuteHostHandler: ActionHandler = async (rawPayload, ctx, bus) => {
  const parsed = ToolExecuteHostRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`tool.execute-host: ${parsed.error.message}`);
  }

  const { call } = parsed.data as ToolExecuteHostRequest;
  const hookName = `tool:execute:${call.name}`;

  if (!bus.hasService(hookName)) {
    return notFound(`no host-side tool for '${call.name}'`);
  }

  let output: unknown;
  try {
    output = await bus.call<typeof call, unknown>(hookName, ctx, call);
  } catch (err) {
    logInternalError(ctx.logger, 'tool.execute-host', err);
    if (err instanceof PluginError) {
      // `install_authored_skill` reports SKILL.md validation failures
      // (`authored-skill-invalid` / `-not-found`) by throwing a PluginError
      // whose message tells the agent what's wrong with its OWN authored
      // content ("description must be ≤240 chars", "no authored skill 'X'").
      // Surface that message verbatim so the agent fixes the file and retries,
      // instead of the generic 500 ("internal server error") that made it loop.
      //
      // This is safe to surface HERE (and is intentionally NOT done in the
      // generic `mapPluginError`) because the gate is the *verified* tool name:
      // `tool:execute:install_authored_skill` is single-registrant (skill-broker
      // — a second registrant is a boot-time collision), so no other plugin can
      // produce an error under this tool name, and the message is agent-authored
      // validation feedback returning to the agent's own trust domain (never a
      // host secret). Any other tool, or these codes from any other dispatch
      // path, redact to 500 via mapPluginError — see errors.ts.
      if (
        call.name === 'install_authored_skill' &&
        (err.code === 'authored-skill-invalid' || err.code === 'authored-skill-not-found')
      ) {
        return { status: 422, body: { error: { code: 'VALIDATION', message: err.message } } };
      }
      return mapPluginError(err);
    }
    return internalError();
  }

  const checked = ToolExecuteHostResponseSchema.safeParse({ output });
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'tool.execute-host',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
