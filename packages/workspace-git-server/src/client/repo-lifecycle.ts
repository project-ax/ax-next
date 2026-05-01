// ---------------------------------------------------------------------------
// REST CRUD client for the @ax/workspace-git-server lifecycle endpoints.
//
// Maps the /repos and /healthz REST surface to a small typed interface.
// Used by the test-only host-side Plugin (`plugin-test-only.ts`) and
// directly by integration tests that exercise the endpoints.
//
// Token discipline: the bearer token never appears in any thrown Error
// message. Network failures echo the URL + reason for ops debugging.
// ---------------------------------------------------------------------------

export interface RepoLifecycleClientOptions {
  /** Base URL of the git-server (no trailing slash), e.g. `http://127.0.0.1:7780`. */
  baseUrl: string;
  /** Bearer token for the lifecycle endpoints. Never logged, never echoed. */
  token: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Per-call timeout in milliseconds. Each fetch is wrapped in an
   * AbortController that fires after this many ms — protects callers from
   * a server that has gone away mid-request and would otherwise hang the
   * caller indefinitely. Default 10 s.
   */
  timeoutMs?: number;
}

export interface CreateRepoResponse {
  workspaceId: string;
  createdAt: string;
}

export interface GetRepoResponse {
  workspaceId: string;
  exists: boolean;
  headOid: string | null;
}

export interface RepoLifecycleClient {
  createRepo(workspaceId: string): Promise<CreateRepoResponse>;
  getRepo(workspaceId: string): Promise<GetRepoResponse | null>;
  deleteRepo(workspaceId: string): Promise<void>;
  isHealthy(): Promise<boolean>;
}

export function createRepoLifecycleClient(
  opts: RepoLifecycleClientOptions,
): RepoLifecycleClient {
  // Strip a single trailing slash so caller can pass either form.
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl = opts.fetch ?? fetch;
  const authHeader = `Bearer ${opts.token}`;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const fetchWithTimeout = async (
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  };

  const opError = (op: string, url: string, reason: string): Error =>
    // Token is intentionally NOT included. The URL + op + reason are enough
    // for ops to debug; the token is a secret.
    new Error(`${op} ${url} failed: ${reason}`);

  return {
    async createRepo(workspaceId: string): Promise<CreateRepoResponse> {
      const url = `${baseUrl}/repos`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          body: JSON.stringify({ workspaceId }),
        });
      } catch (err) {
        throw opError('POST', url, (err as Error).message);
      }
      if (res.status === 201) {
        return (await res.json()) as CreateRepoResponse;
      }
      if (res.status === 409) throw new Error('repo already exists');
      if (res.status === 400) throw new Error('invalid workspaceId');
      if (res.status === 401) throw new Error('unauthorized');
      const text = await safeText(res);
      throw opError('POST', url, `unexpected status ${res.status}: ${text}`);
    },

    async getRepo(workspaceId: string): Promise<GetRepoResponse | null> {
      const url = `${baseUrl}/repos/${workspaceId}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'GET',
          headers: { Authorization: authHeader },
        });
      } catch (err) {
        throw opError('GET', url, (err as Error).message);
      }
      if (res.status === 200) return (await res.json()) as GetRepoResponse;
      if (res.status === 404) return null;
      if (res.status === 400) throw new Error('invalid workspaceId');
      if (res.status === 401) throw new Error('unauthorized');
      const text = await safeText(res);
      throw opError('GET', url, `unexpected status ${res.status}: ${text}`);
    },

    async deleteRepo(workspaceId: string): Promise<void> {
      const url = `${baseUrl}/repos/${workspaceId}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'DELETE',
          headers: { Authorization: authHeader },
        });
      } catch (err) {
        throw opError('DELETE', url, (err as Error).message);
      }
      if (res.status === 204) return;
      if (res.status === 400) throw new Error('invalid workspaceId');
      if (res.status === 401) throw new Error('unauthorized');
      const text = await safeText(res);
      throw opError('DELETE', url, `unexpected status ${res.status}: ${text}`);
    },

    async isHealthy(): Promise<boolean> {
      const url = `${baseUrl}/healthz`;
      try {
        const res = await fetchWithTimeout(url, { method: 'GET' });
        // Drain body so the connection can be reused/freed.
        await safeText(res);
        return res.status === 200;
      } catch {
        return false;
      }
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
