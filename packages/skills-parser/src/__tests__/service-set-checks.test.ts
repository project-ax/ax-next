import { describe, expect, it } from 'vitest';
import { checkServiceSetClashes, findServiceSetClash, PUBLISHED_PORTS_MAX } from '../index.js';

const svc = (name: string, ports: number[], extra: Record<string, unknown> = {}) => ({ name, ports, ...extra });

describe('findServiceSetClash (spec §4.2, shared by importer, store, validator and editor)', () => {
  it('a clean set has no clash', () => {
    expect(findServiceSetClash([
      svc('db', [5432], { publishedPorts: [{ published: 15432, target: 5432 }] }),
      svc('cache', [6379]),
      svc('init', [], { job: true }),
    ])).toBeNull();
  });

  it('two services on the same container port clash, naming both', () => {
    expect(findServiceSetClash([svc('db_a', [5432]), svc('db_b', [5432])])).toEqual({
      kind: 'container-port-shared', port: 5432, services: ['db_a', 'db_b'],
    });
    expect(checkServiceSetClashes([svc('db_a', [5432]), svc('db_b', [5432])]))
      .toBe('container port 5432 is used by both "db_a" and "db_b" (all services share one network namespace)');
  });

  it('keeps the validator rules', () => {
    expect(findServiceSetClash([svc('j', [1], { job: true, publishedPorts: [{ published: 2, target: 1 }] })])?.kind)
      .toBe('job-published');
    expect(findServiceSetClash([svc('a', [1], { publishedPorts: [{ published: 2, target: 3 }] })])?.kind)
      .toBe('target-not-own');
    expect(findServiceSetClash([
      svc('a', [1], { publishedPorts: [{ published: 9, target: 1 }] }),
      svc('b', [2], { publishedPorts: [{ published: 9, target: 2 }] }),
    ])).toMatchObject({ kind: 'published-twice', services: ['a', 'b'] });
    expect(findServiceSetClash([svc('a', [1], { publishedPorts: [{ published: 1, target: 1 }] })])?.kind)
      .toBe('published-is-own-port');
    expect(findServiceSetClash([
      svc('a', [1], { publishedPorts: [{ published: 2, target: 1 }] }), svc('b', [2]),
    ])).toMatchObject({ kind: 'published-is-container-port', services: ['a', 'b'] });
    const many = Array.from({ length: PUBLISHED_PORTS_MAX + 1 }, (_, i) => ({ published: 10_000 + i, target: 1 }));
    expect(findServiceSetClash([svc('a', [1], { publishedPorts: many })])?.kind).toBe('too-many-published');
  });

  it('one service listing a port twice is not a clash with itself', () => {
    expect(findServiceSetClash([svc('a', [80, 80])])).toBeNull();
  });
});
