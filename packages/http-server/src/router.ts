import type { HttpMethod, HttpRouteHandler } from './types.js';

interface RouteEntry {
  method: HttpMethod;
  path: string;
  handler: HttpRouteHandler;
}

export class Router {
  private byKey = new Map<string, RouteEntry>();
  // methodsByPath enables O(1) 404-vs-405 disambiguation without scanning byKey.
  private methodsByPath = new Map<string, Set<HttpMethod>>();

  static makeKey(method: HttpMethod, path: string): string {
    return `${method} ${path}`;
  }

  /** Throws on duplicate (method, path). Returns an idempotent unregister closure. */
  register(method: HttpMethod, path: string, handler: HttpRouteHandler): () => void {
    const key = Router.makeKey(method, path);
    if (this.byKey.has(key)) {
      throw new Error(`route already registered: ${method} ${path}`);
    }
    this.byKey.set(key, { method, path, handler });
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
      this.byKey.delete(key);
      const ms = this.methodsByPath.get(path);
      if (ms !== undefined) {
        ms.delete(method);
        if (ms.size === 0) this.methodsByPath.delete(path);
      }
    };
  }

  match(method: HttpMethod, path: string): HttpRouteHandler | undefined {
    return this.byKey.get(Router.makeKey(method, path))?.handler;
  }

  methodsFor(path: string): Set<HttpMethod> {
    return this.methodsByPath.get(path) ?? new Set();
  }
}
