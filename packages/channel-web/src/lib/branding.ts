/**
 * Branding wire client. Public read at `GET /api/branding` (no auth — the
 * login page + setup wizard read it pre-auth); admin write at `PUT
 * /admin/branding`. Server routes live in `@ax/branding`.
 *
 * Posture mirrors `lib/admin-settings.ts`:
 *  - `credentials: 'include'` so the auth cookie flows on the admin write.
 *  - `x-requested-with: ax-admin` on the write so the CSRF guard accepts.
 */

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

/** Mirrors the server allowlist in @ax/branding. Used for a friendly client-side pre-check. */
export const ALLOWED_LOGO_TYPES = [
  'image/png',
  'image/webp',
  'image/jpeg',
  'image/svg+xml',
] as const;

export interface Branding {
  /** "" → the SPA falls back to the default "ax". */
  name: string;
  logoType: 'full' | 'icon';
  light: boolean;
  dark: boolean;
  /** Cache-buster for logo URLs; changes on every admin write. */
  version: string;
}

export const DEFAULT_BRANDING: Branding = {
  name: '',
  logoType: 'full',
  light: false,
  dark: false,
  version: '',
};

export class BrandingHttpError extends Error {
  constructor(
    public readonly status: number,
    serverMessage?: string,
  ) {
    super(
      serverMessage !== undefined && serverMessage.length > 0
        ? serverMessage
        : `branding request failed: ${status}`,
    );
    this.name = 'BrandingHttpError';
  }
}

export async function fetchBranding(): Promise<Branding> {
  const res = await fetch('/api/branding', { credentials: 'include' });
  if (!res.ok) throw new BrandingHttpError(res.status);
  return (await res.json()) as Branding;
}

/** Same-origin, version-busted logo URL. The `<img>` context never executes SVG scripts. */
export function logoUrl(variant: 'light' | 'dark', version: string): string {
  return `/api/branding/logo/${variant}?v=${encodeURIComponent(version)}`;
}

export interface LogoUpload {
  contentType: string;
  dataBase64: string;
}

export interface PutBrandingInput {
  name?: string;
  logoType?: 'full' | 'icon';
  /** Omit = leave unchanged; null = clear; object = set. */
  light?: LogoUpload | null;
  dark?: LogoUpload | null;
}

export async function putBranding(input: PutBrandingInput): Promise<void> {
  const res = await fetch('/admin/branding', {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let serverMessage: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      serverMessage = body.error;
    } catch {
      // non-JSON error body — fall back to the status-only message
    }
    throw new BrandingHttpError(res.status, serverMessage);
  }
}
