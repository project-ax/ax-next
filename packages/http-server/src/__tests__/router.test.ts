import { describe, expect, it } from 'vitest';
import { Router } from '../router.js';
import type { HttpRouteHandler } from '../types.js';

// Handlers are compared by identity, so each is a distinct no-op. The router
// never calls them.
function handler(): HttpRouteHandler {
  return (async () => {}) as HttpRouteHandler;
}

const FILES_PATTERN = '/api/workspace/agents/:agentId/files/*';
const FILES_REQUEST = '/api/workspace/agents/a1/files/docs/inner.txt';

describe('Router: splat-vs-splat specificity (TASK-717)', () => {
  // A `/*` catchall and a longer splat both match `FILES_REQUEST`. Which one
  // answers must not depend on which plugin happened to init first: presets
  // re-order plugins (the memory preset re-appends @ax/channel-web AFTER
  // @ax/static-files), and the cost of getting it wrong was an entire tab
  // answering with the SPA's index.html.
  for (const order of ['catchall-first', 'specific-first'] as const) {
    it(`the more specific splat wins when registered ${order}`, () => {
      const catchall = handler();
      const files = handler();
      const r = new Router();
      const registrations: Array<[string, HttpRouteHandler]> = [
        ['/*', catchall],
        [FILES_PATTERN, files],
      ];
      if (order === 'specific-first') registrations.reverse();
      for (const [path, h] of registrations) r.register('GET', path, h);

      const m = r.match('GET', FILES_REQUEST);
      expect(m?.handler).toBe(files);
      expect(m?.params).toEqual({
        agentId: 'a1',
        '*': 'docs/inner.txt',
      });
    });
  }

  it('the catchall still answers what no longer splat matches', () => {
    const catchall = handler();
    const files = handler();
    const r = new Router();
    r.register('GET', '/*', catchall);
    r.register('GET', FILES_PATTERN, files);

    expect(r.match('GET', '/settings/agents')?.handler).toBe(catchall);
    expect(r.match('GET', '/assets/app-3ab19f02.js')?.handler).toBe(catchall);
    // Same prefix, different tail segment: not the files route.
    expect(r.match('GET', '/api/workspace/agents/a1/rail/x')?.handler).toBe(
      catchall,
    );
  });

  it('orders a whole ladder of splats by depth regardless of registration order', () => {
    const root = handler();
    const api = handler();
    const files = handler();
    const paths: Array<[string, HttpRouteHandler]> = [
      ['/*', root],
      ['/api/*', api],
      [FILES_PATTERN, files],
    ];
    // Every permutation of the three registrations.
    const perms: number[][] = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const perm of perms) {
      const r = new Router();
      for (const i of perm) r.register('GET', paths[i]![0], paths[i]![1]);
      expect(r.match('GET', FILES_REQUEST)?.handler, `perm ${perm}`).toBe(files);
      expect(r.match('GET', '/api/chat/whatever')?.handler, `perm ${perm}`).toBe(
        api,
      );
      expect(r.match('GET', '/settings')?.handler, `perm ${perm}`).toBe(root);
    }
  });

  it('a literal prefix beats a :param prefix of the same depth', () => {
    const literal = handler();
    const param = handler();
    for (const order of [0, 1]) {
      const r = new Router();
      const regs: Array<[string, HttpRouteHandler]> = [
        ['/things/:id/*', param],
        ['/things/special/*', literal],
      ];
      if (order === 1) regs.reverse();
      for (const [p, h] of regs) r.register('GET', p, h);
      expect(r.match('GET', '/things/special/x')?.handler).toBe(literal);
      expect(r.match('GET', '/things/other/x')?.handler).toBe(param);
    }
  });

  it('equally specific splats keep first-registered-wins', () => {
    const first = handler();
    const second = handler();
    const r = new Router();
    r.register('GET', '/a/:x/*', first);
    r.register('GET', '/a/:y/*', second);
    expect(r.match('GET', '/a/1/z')?.handler).toBe(first);
  });

  it('a non-splat pattern and an exact route still beat every splat', () => {
    const catchall = handler();
    const files = handler();
    const rootListing = handler();
    const exact = handler();
    const r = new Router();
    r.register('GET', '/*', catchall);
    r.register('GET', FILES_PATTERN, files);
    r.register('GET', '/api/workspace/agents/:agentId/files', rootListing);
    r.register('GET', '/api/workspace/agents/a1/files/exact', exact);

    expect(r.match('GET', '/api/workspace/agents/a1/files')?.handler).toBe(
      rootListing,
    );
    expect(r.match('GET', '/api/workspace/agents/a1/files/exact')?.handler).toBe(
      exact,
    );
  });

  it('splats are per-method: a POST splat does not answer a GET', () => {
    const post = handler();
    const get = handler();
    const r = new Router();
    r.register('POST', '/api/*', post);
    r.register('GET', '/*', get);
    expect(r.match('GET', '/api/x')?.handler).toBe(get);
    expect(r.match('POST', '/api/x')?.handler).toBe(post);
  });
});
