/**
 * Catalog admit-queue wire client — typed wrappers around `/admin/catalog/*`.
 * Same posture as lib/skills.ts (credentials: 'include' on every call;
 * x-requested-with: ax-admin on writes; admin-gated server-side).
 *
 * The deciding-admin identity is supplied by the SERVER from the auth session
 * — the client sends only the decision. Do NOT add a decidedByUserId field.
 */
import type { CatalogRequest, CatalogAdmitOutput } from '@ax/skills';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

async function handleResponse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(`catalog API ${res.status}: ${excerpt.slice(0, 200)}`);
  }
  return res.json();
}

export async function listCatalogRequests(): Promise<CatalogRequest[]> {
  const res = await fetch('/admin/catalog/requests', { credentials: 'include' });
  const body = (await handleResponse(res)) as { requests: CatalogRequest[] };
  return body.requests;
}

export async function decideCatalogRequest(
  requestId: string,
  decision: 'admit' | 'reject',
): Promise<CatalogAdmitOutput> {
  const res = await fetch(
    `/admin/catalog/requests/${encodeURIComponent(requestId)}/decision`,
    {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ decision }),
    },
  );
  return (await handleResponse(res)) as CatalogAdmitOutput;
}
