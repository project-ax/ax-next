import type { Logger } from '@ax/core';
import type { RouteHandler, RouteRequest, RouteResponse } from './http-types.js';
import { LifetimeClosedError, type Lifetime } from './lifetime.js';
import { logCode } from './log-code.js';
import type { SecretStore } from './secrets.js';
import { verifySlackSignature } from './signature.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * What every public route Slack calls checks before it reads a byte of the
 * body: the events route (events.ts) and the `/ax` command route
 * (commands.ts). Both are public, so they trust nothing they haven't
 * checked, in this order:
 *
 *   0. The body is at most the route's cap (413). The route's own
 *      `maxBodyBytes` already refused anything larger; this is the backstop.
 *   1. The `installId` is 22 base64url characters AND the raw path spells it
 *      exactly (`params` are percent-decoded), else 404.
 *   2. The install exists, else 404.
 *   3. Its signing secret exists, else 404. Steps 1 to 3 give one answer,
 *      @ax/http-server's own 404 for a path nothing serves (status, headers
 *      and body; plugin.test.ts fetches the real router's to compare), so a
 *      guess can't tell which check refused it. The id's 128 random bits make
 *      the 404/401 split uninformative. Behind a GET catch-all such as
 *      @ax/static-files' `/*`, an unserved POST is a 405, so there this 404
 *      does say the route exists, as it does in every deployment.
 *      The plugin hands these routes a store that remembers each install's
 *      signing secret for a minute (secret-cache.ts), so unsigned requests
 *      to a known install cost one vault read a minute, not one each.
 *   4. The v0 signature over the raw bytes, inside the five-minute replay
 *      window both ways, else 401. Nothing about the body is read before this.
 *
 * A failed install or secret lookup is a 503 (Slack may retry). Logs name
 * only the install and a reason, stage or code, under the route's own
 * prefix (`slack_event_*`, `slack_command_*`): never a header, the body, a
 * Slack id or an error's message.
 */

export const INSTALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export interface IngressDeps {
  store: Pick<InstallStore, 'get'>;
  secrets: Pick<SecretStore, 'get'>;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
}

export interface IngressOptions {
  /** The route's path up to the install id, e.g. `/slack/events/`. */
  pathPrefix: string;
  maxBodyBytes: number;
  logPrefix: 'slack_event' | 'slack_command';
}

/**
 * @ax/http-server's own answer for a path no route serves. Pinned against the
 * real router (plugin.test.ts) and the memory canary, not by a copy of it.
 */
function notFound(res: RouteResponse): void {
  res.status(404).json({ error: 'not-found' });
}

/**
 * Steps 0 to 4 above. The install the request is signed for, or null when
 * the request was refused, in which case it has already been answered.
 */
export async function verifySignedRequest(
  d: IngressDeps,
  req: RouteRequest,
  res: RouteResponse,
  o: IngressOptions,
): Promise<InstallRow | null> {
  // A log line never changes the answer Slack gets.
  const log = (msg: string, fields: Record<string, string>): void => {
    try {
      d.logger.warn(msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };
  const failed = (installId: string, stage: 'install' | 'secret', err: unknown): void => {
    log(`${o.logPrefix}_failed`, { installId, stage, code: logCode(err) });
  };

  if (req.body.length > o.maxBodyBytes) {
    res.status(413).json({ error: 'body-too-large' });
    return null;
  }

  const installId = Object.hasOwn(req.params, 'installId') ? req.params['installId'] : undefined;
  if (installId === undefined || !INSTALL_ID_RE.test(installId) || req.rawPath !== o.pathPrefix + installId) {
    notFound(res);
    return null;
  }

  let install: InstallRow | null;
  try {
    install = await d.store.get(installId);
  } catch (err) {
    failed(installId, 'install', err);
    res.status(503).end();
    return null;
  }
  if (install === null) {
    notFound(res);
    return null;
  }

  let signingSecret: string | null;
  try {
    signingSecret = await d.secrets.get(install, 'signing-secret');
  } catch (err) {
    failed(installId, 'secret', err);
    res.status(503).end();
    return null;
  }
  if (signingSecret === null || signingSecret.length === 0) {
    notFound(res);
    return null;
  }

  if (!verifySlackSignature({ headers: req.headers, body: req.body, signingSecret, nowMs: d.now() })) {
    log(`${o.logPrefix}_refused`, { installId, reason: 'signature' });
    res.status(401).end();
    return null;
  }
  return install;
}

/**
 * A Slack route that runs only while admission is open. After
 * `stopAdmission` every request gets 503 before any lookup, so Slack tries
 * again against the next pod. An admitted request is tracked, so a drain
 * waits for it.
 */
export function admittedHandler(lifetime: Lifetime, handle: RouteHandler): RouteHandler {
  return async (req, res) => {
    let admitted = false;
    try {
      await lifetime.admit(() => {
        admitted = true;
        return handle(req, res);
      });
    } catch (err) {
      if (!admitted && err instanceof LifetimeClosedError) {
        res.status(503).end();
        return;
      }
      throw err;
    }
  };
}
