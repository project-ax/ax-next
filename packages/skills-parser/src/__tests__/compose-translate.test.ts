import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { translateComposeToServices, sortByDependsOn, unescapeComposeDollars } from '../index.js';

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

// ---------------------------------------------------------------------------
// Task 1.4 — profiles, commands, order, jobs, ports, storage (synthetic stack)
// ---------------------------------------------------------------------------
describe('translateComposeToServices: sharded stack', () => {
  const stack = readFileSync(
    fileURLToPath(new URL('./fixtures/sharded-stack.compose.yml', import.meta.url)),
    'utf8',
  );
  // Tag-only images live in `invalid.draft` until pinned (Task 1.5); pin them
  // here with a placeholder digest so the full pipeline can be asserted.
  const e2e = () => {
    const r = translateComposeToServices(stack, { profile: 'e2e' });
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const all = () => {
    const r = e2e();
    return [
      ...r.services,
      ...r.invalid.flatMap((i) => (i.draft ? [i.draft] : [])),
    ];
  };
  const byName = (n: string) => {
    const s = all().find((x) => x.name === n);
    if (!s) throw new Error(`no ${n}`);
    return s;
  };

  it('imports only the chosen profile and lists all profiles', () => {
    const r = e2e();
    expect(r.profiles.sort()).toEqual(['dev', 'e2e', 'test']);
    const names = all().map((s) => s.name);
    expect(names).toContain('emulator');
    expect(names).not.toContain('app');
    const dev = translateComposeToServices(stack, { profile: 'dev' });
    if (!dev.ok) throw new Error(dev.error);
    const devNames = [...dev.services, ...dev.invalid.flatMap((i) => (i.draft ? [i.draft] : []))].map(
      (s) => s.name,
    );
    expect(devNames).toEqual(['redis']);
  });

  it('keeps command and entrypoint and unescapes $$', () => {
    const init = byName('configsvr-init');
    expect(init.entrypoint).toEqual(['/bin/bash', '-c']);
    expect(init.command?.at(-1)).toContain('mongo --host ${CONFIGSVR_HOST}:27019');
    expect(init.command?.at(-1)).not.toContain('$$');
    // a string command is split without a shell
    expect(byName('shard0').command).toEqual([
      'mongod', '--shardsvr', '--replSet', 'shard0', '--port', '27018', '--bind_ip_all',
    ]);
  });

  it('orders by depends_on: config → init → shard → init → mongos → init → rest', () => {
    const r = e2e();
    expect(r.order).toEqual([
      'configsvr', 'configsvr-init', 'shard0', 'shard-init', 'mongos', 'mongo-init',
      'kafka', 'redis', 'emulator',
    ]);
  });

  it('restart "no" becomes a job', () => {
    expect(byName('configsvr-init').job).toBe(true);
    expect(byName('shard-init').job).toBe(true);
    expect(byName('mongo-init').job).toBe(true);
    expect(byName('mongos').job).toBeUndefined();
    expect(byName('configsvr-init').publishedPorts).toBeUndefined();
  });

  it('keeps published and target ports', () => {
    expect(byName('mongos').publishedPorts).toEqual([{ published: 47017, target: 27017 }]);
    expect(byName('kafka').publishedPorts).toEqual([{ published: 9294, target: 9094 }]);
    expect(byName('kafka').ports).toEqual([9092, 9094]);
    // same-number ports need no forward
    expect(byName('emulator').publishedPorts).toBeUndefined();
  });

  it('tmpfs and named volumes become writable paths, plus /tmp', () => {
    expect(byName('redis').writablePaths).toEqual(['/data', '/tmp']);
    expect(byName('shard0').writablePaths).toEqual(['/data/db', '/tmp']);
    expect(byName('configsvr').writablePaths).toEqual(['/data/configdb', '/tmp']);
    expect(byName('emulator').writablePaths).toEqual(['/tmp']);
  });

  it('a service with no health check gets a TCP check on its first port', () => {
    expect(byName('emulator').healthcheck).toEqual({ kind: 'tcp', port: 8085 });
    expect(byName('redis').healthcheck).toEqual({ kind: 'tcp', port: 6379 });
    expect(byName('configsvr-init').healthcheck).toBeUndefined();
  });

  it('a source bind mount lands in appServices with reason mounts-source', () => {
    const r = translateComposeToServices(stack, { profile: 'e2e' });
    if (!r.ok) throw new Error(r.error);
    expect(r.appServices).toEqual([{ service: 'app', reason: 'mounts-source' }]);
    expect(r.drops.some((d) => d.service === 'app' && d.field === 'volumes')).toBe(true);
  });

  it('exposes an unpinned-image service as a draft, valid except for the pin', () => {
    const r = e2e();
    const inv = r.invalid.find((i) => i.name === 'redis');
    expect(inv?.image).toBe('redis:7');
    expect(inv?.draft?.image).toBe('redis:7');
    expect(inv?.draft?.ports).toEqual([6379]);
  });

  it('refuses a depends_on cycle naming both services', () => {
    const r = translateComposeToServices(`
services:
  a:
    image: x@sha256:${'a'.repeat(64)}
    depends_on: [b]
  b:
    image: x@sha256:${'a'.repeat(64)}
    depends_on: [a]
  c:
    image: x@sha256:${'a'.repeat(64)}
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/cycle/i);
    expect(r.error).toContain('a');
    expect(r.error).toContain('b');
    expect(r.error).not.toMatch(/\bc\b/);
  });

  it('refuses an unknown depends_on condition', () => {
    const r = translateComposeToServices(`
services:
  a:
    image: x@sha256:${'a'.repeat(64)}
  b:
    image: x@sha256:${'a'.repeat(64)}
    depends_on:
      a:
        condition: service_sleepy
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('b');
    expect(r.error).toContain('service_sleepy');
  });

  it('unescapes $$ in environment values (list and map forms)', () => {
    const r = translateComposeToServices(`
services:
  a:
    image: x@sha256:${'a'.repeat(64)}
    environment:
      - FOO=$$x
      - BAR=\${KEEP}
  b:
    image: x@sha256:${'a'.repeat(64)}
    environment:
      BAZ: "$$y"
`);
    if (!r.ok) throw new Error(r.error);
    expect(r.services[0]!.env).toEqual({ FOO: '$x', BAR: '${KEEP}' });
    expect(r.services[1]!.env).toEqual({ BAZ: '$y' });
  });

  it('never imports host bind mounts as writable paths', () => {
    const r = translateComposeToServices(`
services:
  a:
    image: x@sha256:${'a'.repeat(64)}
    volumes:
      - /abs:/y
      - \${HOME}/z:/z
      - ~/q:/q
      - ./conf:/conf:ro
`);
    if (!r.ok) throw new Error(r.error);
    expect(r.services[0]!.writablePaths).toEqual(['/tmp']);
    expect(r.appServices).toEqual([]);
    expect(r.drops.some((d) => d.field === 'volumes')).toBe(true);
  });
});

describe('sortByDependsOn / unescapeComposeDollars', () => {
  it('keeps declaration order as the tie-break', () => {
    expect(
      sortByDependsOn([
        { name: 'z', dependsOn: [] },
        { name: 'a', dependsOn: ['z'] },
        { name: 'm', dependsOn: [] },
      ]),
    ).toEqual({ order: ['z', 'a', 'm'] });
  });
  it('unescapes $$ only', () => {
    expect(unescapeComposeDollars('$${A} $$$$ ${B}')).toBe('${A} $$ ${B}');
  });
});
