// ---------------------------------------------------------------------------
// Cross-service checks for one set of dev services (spec §4.2).
//
// Every service in a sandbox shares ONE network namespace (the k8s pod; the
// runner's forwards listen on 127.0.0.1:<published>), so ports that are fine
// in a compose file (each service its own container) can clash here. One pure
// function, used by every place that accepts a set: the compose importer, the
// connector store's write path, @ax/validator-service and the connector editor.
// A copy per caller is how the rules drifted before (Task 1.3 parked the
// shared-container-port rule); keep them here.
//
// Structural input (name, ports, publishedPorts, job), so a draft whose image
// isn't pinned yet can be checked too. Pure: no I/O.
// ---------------------------------------------------------------------------

/** The slice of a service descriptor the cross-service checks read. */
export interface ServiceSetCheckInput {
  name: string;
  ports: readonly number[];
  publishedPorts?: ReadonlyArray<{ published: number; target: number }> | undefined;
  job?: boolean | undefined;
}

/** The runner forwards at most this many published ports (its env parser refuses more). */
export const PUBLISHED_PORTS_MAX = 64;

/** The first clash found in a set, or null. `services` name every service involved. */
export type ServiceSetClash =
  | { kind: 'too-many-published'; total: number; max: number; services: string[] }
  | { kind: 'job-published'; services: [string] }
  | { kind: 'target-not-own'; port: number; services: [string] }
  | { kind: 'published-twice'; port: number; services: [string, string] }
  | { kind: 'published-is-own-port'; port: number; services: [string] }
  | { kind: 'published-is-container-port'; port: number; services: [string, string] }
  | { kind: 'container-port-shared'; port: number; services: [string, string] };

/**
 * The first cross-service clash in `services`, or null. Rules, in order:
 * at most {@link PUBLISHED_PORTS_MAX} published ports in total; a job publishes
 * nothing; a published port targets one of its own service's ports; no two
 * published ports are equal; a published port is no service's container port
 * (its own included); no two services listen on the same container port.
 */
export function findServiceSetClash(services: readonly ServiceSetCheckInput[]): ServiceSetClash | null {
  const totalPublished = services.reduce((n, s) => n + (s.publishedPorts?.length ?? 0), 0);
  if (totalPublished > PUBLISHED_PORTS_MAX) {
    return {
      kind: 'too-many-published', total: totalPublished, max: PUBLISHED_PORTS_MAX,
      services: services.filter((s) => (s.publishedPorts?.length ?? 0) > 0).map((s) => s.name),
    };
  }
  for (const svc of services) {
    if (svc.job === true && (svc.publishedPorts?.length ?? 0) > 0) {
      return { kind: 'job-published', services: [svc.name] };
    }
  }
  for (const svc of services) {
    for (const { target } of svc.publishedPorts ?? []) {
      if (!svc.ports.includes(target)) return { kind: 'target-not-own', port: target, services: [svc.name] };
    }
  }
  const publishedBy = new Map<number, string>();
  for (const svc of services) {
    for (const { published } of svc.publishedPorts ?? []) {
      const other = publishedBy.get(published);
      if (other !== undefined) return { kind: 'published-twice', port: published, services: [other, svc.name] };
      publishedBy.set(published, svc.name);
    }
  }
  for (const svc of services) {
    for (const { published } of svc.publishedPorts ?? []) {
      for (const owner of services) {
        if (!owner.ports.includes(published)) continue;
        if (owner === svc) return { kind: 'published-is-own-port', port: published, services: [svc.name] };
        return { kind: 'published-is-container-port', port: published, services: [svc.name, owner.name] };
      }
    }
  }
  const listenedBy = new Map<number, string>();
  for (const svc of services) {
    for (const port of new Set(svc.ports)) {
      const other = listenedBy.get(port);
      if (other !== undefined) return { kind: 'container-port-shared', port, services: [other, svc.name] };
      listenedBy.set(port, svc.name);
    }
  }
  return null;
}

/** One line naming the services involved (the validator's and the importer's wording). */
export function describeServiceSetClash(clash: ServiceSetClash): string {
  switch (clash.kind) {
    case 'too-many-published':
      return `at most ${clash.max} published ports are allowed across all services, got ${clash.total}`;
    case 'job-published':
      return `job "${clash.services[0]}" cannot have publishedPorts (a job exits; nothing to reach)`;
    case 'target-not-own':
      return `published port target ${clash.port} of "${clash.services[0]}" is not one of the service's own ports`;
    case 'published-twice':
      return `published port ${clash.port} is used by both "${clash.services[0]}" and "${clash.services[1]}"`;
    case 'published-is-own-port':
      return `published port ${clash.port} of "${clash.services[0]}" is the service's own container port (all services share one network namespace, so it must differ)`;
    case 'published-is-container-port':
      return `published port ${clash.port} of "${clash.services[0]}" clashes with a container port of "${clash.services[1]}"`;
    case 'container-port-shared':
      return `container port ${clash.port} is used by both "${clash.services[0]}" and "${clash.services[1]}" (all services share one network namespace)`;
  }
}

/** {@link findServiceSetClash} as a reason string, or null. */
export function checkServiceSetClashes(services: readonly ServiceSetCheckInput[]): string | null {
  const clash = findServiceSetClash(services);
  return clash === null ? null : describeServiceSetClash(clash);
}
