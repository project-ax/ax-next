import type { HttpMethod, HttpRouteHandler } from './types.js';

interface ExactRouteEntry {
  method: HttpMethod;
  path: string;
  handler: HttpRouteHandler;
}

/**
 * Compiled pattern route — a path containing one or more `:param` segments.
 * `paramNames` records the names in declaration order so a runtime match can
 * pair them with their captured values without re-parsing the pattern.
 *
 * Patterns currently support only the `:name` segment form. No regex, no
 * globs, no optional segments — keep YAGNI. The whole admin-API surface
 * (Task 9-13) needs only single-`:id` trailing patterns; the implementation
 * accepts multiple params just so a future channel doesn't need a router
 * change for `/admin/teams/:teamId/members/:userId`.
 */
interface PatternRouteEntry {
  method: HttpMethod;
  pattern: string;
  segments: ReadonlyArray<{ literal: string; paramName: string | null }>;
  paramNames: readonly string[];
  handler: HttpRouteHandler;
}

export interface MatchResult {
  handler: HttpRouteHandler;
  /** Empty for exact-match routes; populated for pattern routes. */
  params: Record<string, string>;
}

/**
 * Route table.
 *
 * Two-tier lookup: exact-match (fast, O(1) Map) is checked first; pattern
 * routes (`/admin/agents/:id`) fall through to a linear scan of the same
 * METHOD's pattern list. We keep patterns segregated by method so a GET
 * never accidentally matches a POST pattern, and so the 405 disambiguation
 * (`methodsFor(path)`) reports the methods that COULD handle this path —
 * including patterns.
 */
export class Router {
  private exact = new Map<string, ExactRouteEntry>();
  private patternsByMethod = new Map<HttpMethod, PatternRouteEntry[]>();
  // methodsByPath enables O(1) 404-vs-405 disambiguation for exact routes.
  // For patterns we walk per-method on demand (small N).
  private methodsByPath = new Map<string, Set<HttpMethod>>();

  static makeKey(method: HttpMethod, path: string): string {
    return `${method} ${path}`;
  }

  /**
   * Throws on duplicate (method, path) for exact routes OR duplicate
   * (method, pattern) for pattern routes. Returns an idempotent unregister
   * closure.
   */
  register(method: HttpMethod, path: string, handler: HttpRouteHandler): () => void {
    const compiled = compilePathPattern(path);
    if (compiled === null) {
      // Exact route.
      return this.registerExact(method, path, handler);
    }
    return this.registerPattern(method, path, compiled, handler);
  }

  private registerExact(
    method: HttpMethod,
    path: string,
    handler: HttpRouteHandler,
  ): () => void {
    const key = Router.makeKey(method, path);
    if (this.exact.has(key)) {
      throw new Error(`route already registered: ${method} ${path}`);
    }
    this.exact.set(key, { method, path, handler });
    let methods = this.methodsByPath.get(path);
    if (methods === undefined) {
      methods = new Set();
      this.methodsByPath.set(path, methods);
    }
    methods.add(method);

    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      this.exact.delete(key);
      const ms = this.methodsByPath.get(path);
      if (ms !== undefined) {
        ms.delete(method);
        if (ms.size === 0) this.methodsByPath.delete(path);
      }
    };
  }

  private registerPattern(
    method: HttpMethod,
    pattern: string,
    compiled: PatternRouteEntry['segments'],
    handler: HttpRouteHandler,
  ): () => void {
    let list = this.patternsByMethod.get(method);
    if (list === undefined) {
      list = [];
      this.patternsByMethod.set(method, list);
    }
    if (list.some((entry) => entry.pattern === pattern)) {
      throw new Error(`route already registered: ${method} ${pattern}`);
    }
    const paramNames = compiled
      .map((s) => s.paramName)
      .filter((n): n is string => n !== null);
    const entry: PatternRouteEntry = {
      method,
      pattern,
      segments: compiled,
      paramNames,
      handler,
    };
    list.push(entry);

    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      const cur = this.patternsByMethod.get(method);
      if (cur === undefined) return;
      const idx = cur.indexOf(entry);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) this.patternsByMethod.delete(method);
    };
  }

  match(method: HttpMethod, path: string): MatchResult | undefined {
    const exact = this.exact.get(Router.makeKey(method, path));
    if (exact !== undefined) {
      return { handler: exact.handler, params: {} };
    }
    const patterns = this.patternsByMethod.get(method);
    if (patterns === undefined) return undefined;
    const requestSegments = splitPathSegments(path);
    for (const entry of patterns) {
      const params = matchPattern(entry.segments, requestSegments);
      if (params !== null) {
        return { handler: entry.handler, params };
      }
    }
    return undefined;
  }

  /**
   * Methods that COULD handle `path` — used for 405 Allow-header
   * disambiguation. Returns the union of exact routes registered at this
   * path AND any pattern routes that match it.
   */
  methodsFor(path: string): Set<HttpMethod> {
    const out = new Set(this.methodsByPath.get(path) ?? []);
    const requestSegments = splitPathSegments(path);
    for (const [method, list] of this.patternsByMethod) {
      for (const entry of list) {
        if (matchPattern(entry.segments, requestSegments) !== null) {
          out.add(method);
          break;
        }
      }
    }
    return out;
  }
}

/**
 * Compile a path string into a sequence of literal/param segments. Returns
 * null when the path contains no `:` — caller treats that as an exact
 * route. Throws on malformed patterns (empty or duplicate param names).
 */
function compilePathPattern(
  path: string,
): PatternRouteEntry['segments'] | null {
  if (!path.includes(':')) return null;
  const segments = splitPathSegments(path);
  const compiled: Array<{ literal: string; paramName: string | null }> = [];
  const seenNames = new Set<string>();
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      const paramName = segment.slice(1);
      if (paramName.length === 0) {
        throw new Error(`route pattern '${path}' has empty :param name`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(paramName)) {
        throw new Error(
          `route pattern '${path}' has invalid :param name '${paramName}'`,
        );
      }
      if (seenNames.has(paramName)) {
        throw new Error(
          `route pattern '${path}' has duplicate :param name '${paramName}'`,
        );
      }
      seenNames.add(paramName);
      compiled.push({ literal: '', paramName });
    } else {
      compiled.push({ literal: segment, paramName: null });
    }
  }
  return compiled;
}

function splitPathSegments(path: string): string[] {
  // Strip the leading '/'; otherwise '/foo/bar' splits to ['', 'foo', 'bar'].
  // An empty path or '/' yields a single empty segment we filter out.
  return path.split('/').slice(1);
}

function matchPattern(
  pattern: PatternRouteEntry['segments'],
  requestSegments: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== requestSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const seg = pattern[i]!;
    const got = requestSegments[i]!;
    if (seg.paramName !== null) {
      // Reject empty captures so '/admin/agents/' doesn't match
      // '/admin/agents/:id' with id=''.
      if (got.length === 0) return null;
      params[seg.paramName] = decodePathSegment(got);
    } else if (seg.literal !== got) {
      return null;
    }
  }
  return params;
}

function decodePathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed percent-escapes — pass through verbatim so handlers can
    // decide how to react (most will reject downstream as invalid id).
    return raw;
  }
}
