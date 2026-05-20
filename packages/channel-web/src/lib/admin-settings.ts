/**
 * Admin-settings wire client for `/admin/settings/:key` (GET + PUT).
 *
 * Server-side routes live in `@ax/admin-settings-routes`. Today's
 * allowlist: `fast-model`. Values are plain JSON strings — no base64
 * because these aren't secrets (a model id like `anthropic/claude-haiku`
 * is not sensitive).
 *
 * Posture matches `lib/credentials.ts` / `lib/admin.ts`:
 *  - `credentials: 'include'` so the auth cookie flows.
 *  - `x-requested-with: ax-admin` on writes so CSRF guard accepts.
 */

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

export type AdminSettingsKey = 'fast-model';

/**
 * Error thrown by `getAdminSetting` / `putAdminSetting` so callers can
 * narrow on the wire status — particularly to distinguish "the row
 * doesn't exist yet" (404) from auth/network/server problems.
 */
export class AdminSettingNotFoundError extends Error {
  constructor(key: AdminSettingsKey) {
    super(`admin setting "${key}" not found`);
    this.name = 'AdminSettingNotFoundError';
  }
}

export class AdminSettingHttpError extends Error {
  constructor(
    public readonly status: number,
    key: AdminSettingsKey,
    op: 'get' | 'put',
  ) {
    super(`${op} setting ${key}: ${status}`);
    this.name = 'AdminSettingHttpError';
  }
}

export async function getAdminSetting(key: AdminSettingsKey): Promise<string | null> {
  const res = await fetch(`/admin/settings/${key}`, {
    credentials: 'include',
  });
  if (res.ok) {
    const body = (await res.json()) as { value: string | null };
    return body.value;
  }
  if (res.status === 404) {
    throw new AdminSettingNotFoundError(key);
  }
  throw new AdminSettingHttpError(res.status, key, 'get');
}

export async function putAdminSetting(
  key: AdminSettingsKey,
  value: string,
): Promise<void> {
  const res = await fetch(`/admin/settings/${key}`, {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    throw new AdminSettingHttpError(res.status, key, 'put');
  }
}
