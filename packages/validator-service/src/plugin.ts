// ---------------------------------------------------------------------------
// @ax/validator-service — the neutral dev-SERVICE descriptor validator.
//
// Registers ONE service hook, `services:validate`, that takes a list of service
// descriptors (model/connector-authored — UNTRUSTED) and returns a verdict. It
// enforces, with NAMED reasons:
//   - I8 — every image is digest-pinned (`…@sha256:<64 hex>`),
//   - the descriptor CAPS (≤8 services, ≤16 ports, ≤32 env entries, ≤16
//     writablePaths, ≤16 healthcheck-command args), via the canonical
//     @ax/skills-parser `ServiceDescriptorSchema`,
//   - writablePaths are absolute,
//   - I2 — REJECTION of smuggled backend vocabulary (pod / container /
//     securityContext / runtimeClassName / volume / emptyDir / initContainers /
//     restartPolicy) at ANY depth, beyond the schema's `.strict()` top-level
//     guard.
//
// ACCEPT-OR-REJECT, never throws on a bad descriptor — it returns
// `{ verdict: 'invalid', reason }`, the same posture as @ax/validator-skill's
// `skills:scan`. A caller (the connector store, the orchestrator's
// connector-cap fold) treats a non-clean verdict as a hard stop for that spec.
//
// Capability budget: NO spawn, NO file I/O, NO network, NO DB. Pure in-memory
// schema + scan. That's why it loads in BOTH presets (the Postgres-free CLI
// preset too), exactly like validator-skill's no-dep `skills:scan`.
//
// I2 — the validator imports the CANONICAL `ServiceDescriptorSchema` from
// @ax/skills-parser (a pure, eslint-allow-listed parser package); it is NOT a
// cross-plugin runtime coupling. The descriptor grammar is authored once there.
// ---------------------------------------------------------------------------

import type { Plugin } from '@ax/core';
import { ServiceDescriptorSchema, type ServiceDescriptor } from '@ax/skills-parser';
import { findForbiddenVocab } from './forbidden-vocab.js';

const PLUGIN_NAME = '@ax/validator-service';

/** Carrier cap — at most this many services per unit of work (the on-demand
 *  ceiling). Mirrors the @ax/skills-parser `SERVICES_MAX` and the
 *  @ax/sandbox-protocol wire cap. The tighter always-on cap (8) is per connector
 *  mode, which this validator never sees, so it lives in the connectors schema. */
const SERVICES_MAX = 16;

/** The runner forwards at most this many published ports (its env parser refuses more). */
const PUBLISHED_PORTS_MAX = 64;

/** Input: the (untrusted) service descriptor list to validate. */
export interface ServicesValidateInput {
  services: unknown[];
}

/** Verdict: clean, or invalid with a single human-readable reason. */
export type ServicesValidateOutput =
  | { verdict: 'clean' }
  | { verdict: 'invalid'; reason: string };

/**
 * Cross-service port check over already-parsed descriptors. A published
 * (host-visible) port must not equal another published port, nor a container
 * port of ANY service, its own included (one shared network namespace).
 * Returns a reason naming the services involved, or null.
 */
export function checkPortClashes(services: ServiceDescriptor[]): string | null {
  const totalPublished = services.reduce((n, s) => n + (s.publishedPorts?.length ?? 0), 0);
  if (totalPublished > PUBLISHED_PORTS_MAX) {
    return `at most ${PUBLISHED_PORTS_MAX} published ports are allowed across all services, got ${totalPublished}`;
  }
  for (const svc of services) {
    for (const { target } of svc.publishedPorts ?? []) {
      if (!svc.ports.includes(target)) {
        return `published port target ${target} of "${svc.name}" is not one of the service's own ports`;
      }
    }
  }
  const publishedBy = new Map<number, string>();
  for (const svc of services) {
    for (const { published } of svc.publishedPorts ?? []) {
      const other = publishedBy.get(published);
      if (other !== undefined) {
        return `published port ${published} is used by both "${other}" and "${svc.name}"`;
      }
      publishedBy.set(published, svc.name);
    }
  }
  for (const svc of services) {
    for (const { published } of svc.publishedPorts ?? []) {
      for (const owner of services) {
        if (!owner.ports.includes(published)) continue;
        if (owner === svc) {
          return `published port ${published} of "${svc.name}" is the service's own container port (all services share one network namespace, so it must differ)`;
        }
        return `published port ${published} of "${svc.name}" clashes with a container port of "${owner.name}"`;
      }
    }
  }
  return null;
}

/**
 * Validate one descriptor list. Pure — exported for direct unit testing and so
 * a future in-process caller can reuse it without the bus.
 */
export function validateServices(services: unknown[]): ServicesValidateOutput {
  if (!Array.isArray(services)) {
    return { verdict: 'invalid', reason: 'services must be an array' };
  }
  if (services.length > SERVICES_MAX) {
    return {
      verdict: 'invalid',
      reason: `at most ${SERVICES_MAX} services allowed, got ${services.length}`,
    };
  }

  const parsedList: ServiceDescriptor[] = [];
  for (let i = 0; i < services.length; i++) {
    const raw = services[i];

    // I2 — named forbidden-vocab rejection FIRST, so the reviewer sees exactly
    // which scheduler field leaked rather than zod's generic "unrecognized key".
    // Catches a forbidden key at ANY depth (the schema's `.strict()` only guards
    // the descriptor root).
    const forbidden = findForbiddenVocab(raw);
    if (forbidden !== null) {
      return {
        verdict: 'invalid',
        reason: `services[${i}]: forbidden backend vocabulary "${forbidden}" — the descriptor is transport/storage-agnostic (no pod/container/securityContext/runtimeClassName/volume/emptyDir/initContainers/restartPolicy)`,
      };
    }

    // Caps + digest-pin (I8) + absolute writablePaths + strict keys, via the
    // canonical schema.
    const parsed = ServiceDescriptorSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') ?? '';
      const where = path.length > 0 ? ` (${path})` : '';
      return {
        verdict: 'invalid',
        reason: `services[${i}]${where}: ${first?.message ?? 'invalid service descriptor'}`,
      };
    }
    if (parsed.data.job === true && (parsed.data.publishedPorts?.length ?? 0) > 0) {
      return {
        verdict: 'invalid',
        reason: `services[${i}]: job "${parsed.data.name}" cannot have publishedPorts (a job exits; nothing to reach)`,
      };
    }
    parsedList.push(parsed.data);
  }

  const clash = checkPortClashes(parsedList);
  if (clash !== null) return { verdict: 'invalid', reason: clash };

  return { verdict: 'clean' };
}

/**
 * The validator plugin. Registers `services:validate` — ONE authoritative
 * validator (a service hook, not a subscriber), so a stripped preset that omits
 * it degrades at the gate (the caller can treat a missing validator as a hard
 * fail of its own choosing) rather than silently widening reach.
 */
export function createValidatorServicePlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['services:validate'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<ServicesValidateInput, ServicesValidateOutput>(
        'services:validate',
        PLUGIN_NAME,
        async (ctx, input) => {
          const verdict = validateServices(input.services);
          if (verdict.verdict === 'invalid') {
            ctx.logger.warn('service_descriptor_rejected', { reason: verdict.reason });
          }
          return verdict;
        },
      );
    },
  };
}
