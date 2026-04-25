// ---------------------------------------------------------------------------
// parseRunnerEndpoint — single source of truth for the runner-endpoint URI
// grammar.
//
// The URI is opaque at the sandbox-provider boundary (architecture invariant
// I1 — no transport-specific field names leak across hooks). Inside this
// file, we know exactly which transports we accept and we validate strictly.
//
// Supported schemes:
//   - `unix:///abs/path/ipc.sock` — Unix domain socket. The subprocess
//     sandbox provider sets this. `socketPath` MUST be absolute.
//   - `http://host:port`         — TCP HTTP. The k8s sandbox provider sets
//     this to the cluster-internal Service URL of the host pod (the runner
//     is the IPC client; the host hosts the listener). Port is REQUIRED.
//
// Anything else (vsock://, ws://, https://, ...) is rejected. New transports
// get a new branch when (and only when) a real impl ships.
// ---------------------------------------------------------------------------

export class RunnerEndpointError extends Error {
  public override readonly name = 'RunnerEndpointError';
  public override readonly cause: Error | undefined;
  constructor(message: string, cause?: Error) {
    super(message);
    this.cause = cause;
  }
}

export type TransportTarget =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'http'; host: string; port: number };

export function parseRunnerEndpoint(uri: string): TransportTarget {
  let url: URL;
  try {
    url = new URL(uri);
  } catch (cause) {
    throw new RunnerEndpointError(
      `invalid runnerEndpoint URI: ${uri}`,
      cause as Error,
    );
  }

  switch (url.protocol) {
    case 'unix:': {
      // The WHATWG URL parser is happy to treat `unix://relative/path` as
      // host=`relative`, pathname=`/path` — which would silently let a
      // wiring bug through. The grammar we accept is `unix:///abs/path`
      // exclusively, which means hostname MUST be empty.
      if (url.hostname.length !== 0) {
        throw new RunnerEndpointError(
          `unix:// runnerEndpoint must include an absolute path (got ${uri})`,
        );
      }
      const socketPath = url.pathname;
      if (socketPath.length === 0 || !socketPath.startsWith('/')) {
        throw new RunnerEndpointError(
          `unix:// runnerEndpoint must include an absolute path (got ${uri})`,
        );
      }
      return { kind: 'unix', socketPath };
    }
    case 'http:': {
      // url.hostname strips brackets from IPv6 literals; url.port is '' when
      // not specified OR when the port matches the scheme default (80 for
      // http). We can't tell those two apart from the parsed URL alone, so
      // we reach back to the original `uri` and require an explicit `:port`
      // in the authority. Defaults are almost always a wiring bug here.
      const host = url.hostname;
      if (host.length === 0) {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must include a host (got ${uri})`,
        );
      }
      // Reject userinfo / query / fragment up front: they're authority-only
      // shapes elsewhere in the protocol, and silently consuming them
      // produces confusing downstream errors (e.g. userinfo's `:` trips the
      // explicit-port parser below and emits a bogus "port out of range").
      // Each of these is a wiring bug in deployment config — fail loud.
      if (url.username !== '' || url.password !== '') {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must not include userinfo (got ${uri})`,
        );
      }
      if (url.search !== '') {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must not include a query (got ${uri})`,
        );
      }
      if (url.hash !== '') {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must not include a fragment (got ${uri})`,
        );
      }
      // Authority sits between `://` and the next `/`, `?`, or `#`. Looking
      // for `:` after the last `]` (IPv6 literal closer) inside that span
      // tells us whether a port was written explicitly.
      const afterScheme = uri.slice('http://'.length);
      const authorityEnd = (() => {
        for (let i = 0; i < afterScheme.length; i++) {
          const c = afterScheme[i];
          if (c === '/' || c === '?' || c === '#') return i;
        }
        return afterScheme.length;
      })();
      const authority = afterScheme.slice(0, authorityEnd);
      const lastBracket = authority.lastIndexOf(']');
      const portColon = authority.indexOf(':', lastBracket + 1);
      if (portColon < 0) {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must include an explicit port (got ${uri})`,
        );
      }
      const explicitPortStr = authority.slice(portColon + 1);
      if (explicitPortStr.length === 0) {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must include an explicit port (got ${uri})`,
        );
      }
      const port = Number(explicitPortStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint port out of range (got ${uri})`,
        );
      }
      // Path is reserved for the action name (`/llm.call`, etc.). The URI
      // itself carries authority only. The WHATWG URL parser normalises a
      // missing path to `/`, so accept that as "no path".
      if (url.pathname !== '/' && url.pathname !== '') {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must not include a path component (got ${uri})`,
        );
      }
      return { kind: 'http', host, port };
    }
    default:
      throw new RunnerEndpointError(
        `unsupported runnerEndpoint scheme: ${url.protocol}`,
      );
  }
}
