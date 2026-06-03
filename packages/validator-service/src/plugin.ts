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
import { ServiceDescriptorSchema } from '@ax/skills-parser';
import { findForbiddenVocab } from './forbidden-vocab.js';

const PLUGIN_NAME = '@ax/validator-service';

/** Carrier cap — at most this many services per unit of work. Mirrors the
 *  @ax/skills-parser `SERVICES_MAX` and the @ax/sandbox-protocol wire cap. */
const SERVICES_MAX = 8;

/** Input: the (untrusted) service descriptor list to validate. */
export interface ServicesValidateInput {
  services: unknown[];
}

/** Verdict: clean, or invalid with a single human-readable reason. */
export type ServicesValidateOutput =
  | { verdict: 'clean' }
  | { verdict: 'invalid'; reason: string };

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
  }

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
