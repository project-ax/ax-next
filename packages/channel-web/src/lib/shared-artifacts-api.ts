/**
 * The link holder's three reads (`/api/shared/:code`, routes-shared-artifacts.ts):
 * what the link points at, its text, and a view/download token — the current
 * version only.
 *
 * The code is a capability (§6.3) and must never be logged. An `HttpError`
 * carries its request path into the console (`logRequestFailure` prints
 * `detail`), so every error here is built with the route's PATTERN, never the
 * real address.
 */
import { HttpError, httpFetch } from './http';
import {
  ArtifactTextSchema,
  ArtifactTokenSchema,
  SharedArtifactViewSchema,
  type ArtifactTokenPurpose,
  type SharedArtifactView,
} from './workspace-types';
import { z } from 'zod';

const SharedArtifactBodySchema = z.object({ artifact: SharedArtifactViewSchema });

/** A 200 whose body we couldn't read. Carries no address. */
export class SharedArtifactShapeError extends Error {
  constructor(readonly route: string) {
    super(`${route}: the server sent an answer we could not read`);
    this.name = 'SharedArtifactShapeError';
  }
}

async function call<T>(
  code: string,
  suffix: '' | '/text' | '/token',
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const route = `/api/shared/:code${suffix}`;
  const res = await httpFetch(`/api/shared/${encodeURIComponent(code)}${suffix}`, init);
  if (!res.ok) throw new HttpError(route, res.status);
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new SharedArtifactShapeError(route);
  return parsed.data;
}

export const sharedArtifactsApi = {
  artifact: async (code: string): Promise<SharedArtifactView> =>
    (await call(code, '', SharedArtifactBodySchema)).artifact,

  text: (code: string) => call(code, '/text', ArtifactTextSchema),

  token: (code: string, purpose: ArtifactTokenPurpose) =>
    call(code, '/token', ArtifactTokenSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ purpose }),
    }),
};
