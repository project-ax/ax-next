import { describe, it, expect } from 'vitest';
import { translateComposeToServices } from '../index.js';

// A digest-pinned image we reuse — postgres pinned to an (illustrative) sha256.
const PINNED = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);
const PINNED_REDIS = 'docker.io/library/redis@sha256:' + 'b'.repeat(64);

describe('translateComposeToServices', () => {
  it('maps a clean digest-pinned service to a descriptor', () => {
    const yaml = `
services:
  db:
    image: ${PINNED}
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: secret
`;
    const r = translateComposeToServices(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.services).toHaveLength(1);
    const svc = r.services[0]!;
    expect(svc.name).toBe('db');
    expect(svc.image).toBe(PINNED);
    expect(svc.ports).toEqual([5432]);
    expect(svc.env).toEqual({ POSTGRES_PASSWORD: 'secret' });
    expect(r.drops).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  it('DROPS host bind mounts (volumes) and privileged, and REPORTS them (I10)', () => {
    const yaml = `
services:
  db:
    image: ${PINNED}
    privileged: true
    volumes:
      - /etc/passwd:/etc/passwd
      - dbdata:/var/lib/postgresql/data
`;
    const r = translateComposeToServices(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The descriptor crosses with NO volumes / privileged on it (allow-list map).
    expect(r.services).toHaveLength(1);
    const svc = r.services[0]!;
    expect(svc).not.toHaveProperty('privileged');
    expect(svc).not.toHaveProperty('volumes');
    // Both dangerous fields are reported as drops on the `db` service.
    const fields = r.drops.filter((d) => d.service === 'db').map((d) => d.field).sort();
    expect(fields).toContain('privileged');
    expect(fields).toContain('volumes');
  });

  it('DROPS a docker socket bind mount, cap_add, and network_mode: host (I10)', () => {
    const yaml = `
services:
  agent:
    image: ${PINNED}
    network_mode: host
    cap_add:
      - SYS_ADMIN
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`;
    const r = translateComposeToServices(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fields = r.drops.filter((d) => d.service === 'agent').map((d) => d.field);
    expect(fields).toContain('network_mode');
    expect(fields).toContain('cap_add');
    expect(fields).toContain('volumes');
    // The descriptor that crosses carries none of those.
    const svc = r.services[0]!;
    expect(svc).not.toHaveProperty('network_mode');
    expect(svc).not.toHaveProperty('cap_add');
  });

  it('DROPS the sibling escape hatches: devices, pid, ipc, userns_mode, security_opt', () => {
    const yaml = `
services:
  x:
    image: ${PINNED}
    devices:
      - /dev/kvm
    pid: host
    ipc: host
    userns_mode: host
    security_opt:
      - seccomp:unconfined
`;
    const r = translateComposeToServices(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fields = r.drops.filter((d) => d.service === 'x').map((d) => d.field).sort();
    expect(fields).toEqual(
      ['devices', 'ipc', 'pid', 'security_opt', 'userns_mode'].sort(),
    );
  });

  it('FLAGS an un-pinned image — not dropped, surfaced as invalid for the author to pin (I8)', () => {
    const yaml = `
services:
  db:
    image: postgres:16
    ports: ["5432:5432"]
`;
    const r = translateComposeToServices(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // It does not cross as a valid descriptor...
    expect(r.services).toEqual([]);
    // ...it's reported as invalid with a digest-pin reason naming the service.
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0]!.name).toBe('db');
    expect(r.invalid[0]!.reason.toLowerCase()).toContain('pin');
    expect(r.invalid[0]!.image).toBe('postgres:16');
  });

  it('coerces an environment ARRAY (KEY=val) and a MAP to the same env record', () => {
    const arr = translateComposeToServices(`
services:
  a:
    image: ${PINNED}
    environment:
      - POSTGRES_PASSWORD=secret
      - POSTGRES_DB=app
`);
    const map = translateComposeToServices(`
services:
  b:
    image: ${PINNED}
    environment:
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
`);
    expect(arr.ok && map.ok).toBe(true);
    if (!arr.ok || !map.ok) return;
    expect(arr.services[0]!.env).toEqual({ POSTGRES_PASSWORD: 'secret', POSTGRES_DB: 'app' });
    expect(map.services[0]!.env).toEqual({ POSTGRES_PASSWORD: 'secret', POSTGRES_DB: 'app' });
  });

  it('maps multiple services and preserves a clean one alongside a flagged one', () => {
    const yaml = `
services:
  db:
    image: ${PINNED}
  cache:
    image: redis:7
`;
    const r = translateComposeToServices(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.services.map((s) => s.name)).toEqual(['db']);
    expect(r.invalid.map((i) => i.name)).toEqual(['cache']);
  });

  it('extracts the container port from short syntax host:container and a bare number', () => {
    const yaml = `
services:
  a:
    image: ${PINNED}
    ports:
      - "5432:5432"
  b:
    image: ${PINNED_REDIS}
    ports:
      - 6379
`;
    const r = translateComposeToServices(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byName = Object.fromEntries(r.services.map((s) => [s.name, s]));
    expect(byName['a']!.ports).toEqual([5432]);
    expect(byName['b']!.ports).toEqual([6379]);
  });

  it('returns an error result for malformed YAML — never throws', () => {
    const r = translateComposeToServices('services: : :\n  - [unbalanced');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.toLowerCase()).toContain('yaml');
  });

  it('returns an error result when the root is not a mapping', () => {
    const r = translateComposeToServices('- just\n- a\n- list');
    expect(r.ok).toBe(false);
  });

  it('returns an error result when there is no services block', () => {
    const r = translateComposeToServices('version: "3.9"\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.toLowerCase()).toContain('services');
  });

  it('terminates on a cyclic anchor graph instead of overflowing', () => {
    // YAML alias/anchor cycle. js-yaml can build a cyclic object; the walk must
    // not recurse forever.
    const yaml = `
services:
  a: &a
    image: ${PINNED}
    self: *a
`;
    const r = translateComposeToServices(yaml);
    // Either way it must RETURN (not hang / overflow). The self-ref is an unknown
    // key → dropped; the service still maps.
    expect(r.ok).toBe(true);
  });
});
