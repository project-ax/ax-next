import { load as yamlLoad, YAMLException } from 'js-yaml';
import { ServiceDescriptorSchema, type ServiceDescriptor } from './service-descriptor.js';

// ---------------------------------------------------------------------------
// Curated docker-compose.yml → ServiceDescriptor translation (I10 / I8).
//
// We NEVER auto-import a compose file verbatim, and we NEVER shell out to
// `docker compose`. This is a CURATED translation: we take a pasted compose
// file (UNTRUSTED text — it crosses a trust boundary from the browser into the
// connector capability proposal), parse it with the repo's existing YAML parser
// (`js-yaml`, same one @ax/skills-parser uses for SKILL.md), and map ONLY the
// known-safe fields of each service onto the neutral {@link ServiceDescriptor}.
//
// SECURITY POSTURE:
//   - ALLOW-LIST mapping — only `{ image, environment, ports, healthcheck }`
//     cross. Everything else is ignored, so a field we've never heard of can't
//     leak through by default. The dangerous fields below are additionally
//     REPORTED so the author sees what we removed.
//   - I10 — host bind mounts (incl. the docker socket), `privileged`, `cap_add`,
//     `network_mode: host`, and the sibling escape hatches (`devices`, `pid`,
//     `ipc`, `userns_mode`, `security_opt`) are DROPPED and reported. None of
//     them can cross into the sandbox — they're how a container breaks OUT of
//     one.
//   - I8 — an un-pinned image (no `@sha256:<64hex>`) is FLAGGED (not silently
//     dropped) so the author can pin it. The descriptor is rejected by
//     `ServiceDescriptorSchema` until pinned, so it lands in `invalid`.
//   - `js-yaml`'s default `load()` uses the safe schema (no `!!js/function`
//     code-exec — that needs the separate `js-yaml-js-types` extension, which we
//     do not install). We still wrap it in try/catch and guard cyclic
//     alias/anchor graphs with a WeakSet (same as `parseSkillManifest`).
// ---------------------------------------------------------------------------

/** One field we removed from a service because it can't cross into the sandbox.
 *  `value` is a short, human-readable echo of what was dropped (truncated). */
export interface ComposeDrop {
  /** The compose service name the field was removed from. */
  service: string;
  /** The compose field name we dropped (e.g. `volumes`, `privileged`). */
  field: string;
  /** A short echo of the dropped value, for the "here's what we removed" notice. */
  value?: string;
}

/** A service we could not translate into a valid descriptor — most commonly an
 *  un-pinned image (I8), but also any descriptor the schema rejects. The author
 *  fixes it (e.g. pins the image) and re-pastes / edits. */
export interface ComposeInvalid {
  /** The compose service name. */
  name: string;
  /** The image as written (so an un-pinned-image notice can show it). */
  image?: string;
  /** Why it didn't translate (human-readable, e.g. "image must be digest-pinned"). */
  reason: string;
}

/** The result of a curated compose translation. `ok:false` means the paste
 *  wasn't usable at all (not YAML, not a mapping, no services block). `ok:true`
 *  carries the valid descriptors plus everything we removed or flagged so the UI
 *  can be honest about what crossed and what didn't. */
export type ComposeTranslateResult =
  | {
      ok: true;
      /** Descriptors that translated AND validated — these populate the form. */
      services: ServiceDescriptor[];
      /** Dangerous fields we removed (I10), per service. */
      drops: ComposeDrop[];
      /** Services we couldn't translate (e.g. un-pinned image, I8). */
      invalid: ComposeInvalid[];
    }
  | { ok: false; error: string };

// The compose keys we deliberately DROP and REPORT. Each is a sandbox-escape
// vector or a host-coupling we never let cross into the sandbox (I10):
//   volumes        — host bind mounts (incl. /var/run/docker.sock socket mounts)
//   privileged     — drops every isolation boundary
//   cap_add        — re-grants dropped Linux capabilities (SYS_ADMIN, etc.)
//   network_mode   — `host` shares the host network namespace
//   devices        — passes host device nodes (/dev/kvm, …) into the container
//   pid / ipc      — `host` shares the host PID / IPC namespace
//   userns_mode    — `host` disables user-namespace remapping
//   security_opt   — `seccomp:unconfined` / `apparmor:unconfined` removes the LSM
const DROPPED_FIELDS = [
  'volumes',
  'privileged',
  'cap_add',
  'network_mode',
  'devices',
  'pid',
  'ipc',
  'userns_mode',
  'security_opt',
] as const;

/** Digest-pinned image reference (mirrors service-descriptor's regex). */
const DIGEST_PINNED_IMAGE_RE = /.+@sha256:[0-9a-f]{64}$/;

/** Short, safe echo of a dropped value for the UI notice. */
function echoValue(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  let s: string;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    s = String(v);
  } else {
    try {
      s = JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return s.length > 200 ? s.slice(0, 197) + '…' : s;
}

/**
 * Coerce a compose `environment` block (either a `KEY=value` array OR a
 * `KEY: value` mapping) into a flat `{ [key]: string }` record. Values are
 * stringified; an array entry with no `=` becomes `{ KEY: '' }` (compose's
 * "pass through from the host env" form — we declare it empty, never reading the
 * host env). Unknown shapes yield `{}`.
 */
function coerceEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq === -1) {
        if (entry.length > 0) out[entry] = '';
      } else {
        out[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
    }
    return out;
  }
  if (raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v === null || v === undefined ? '' : String(v);
    }
  }
  return out;
}

/**
 * Extract the CONTAINER ports from a compose `ports` block. We keep the
 * container side (the service's own listening port), never the host-published
 * side — a sandbox backend chooses its own host mapping. Handles:
 *   - `"5432:5432"` / `"127.0.0.1:5432:5432"` → 5432 (last colon-segment)
 *   - `5432` (bare number)                    → 5432
 *   - `"5432"` (string number)                → 5432
 *   - `{ target: 5432, published: 5432 }`     → 5432 (long syntax)
 * Anything we can't read is skipped (the schema cap bounds the rest).
 */
function coercePorts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const entry of raw) {
    let port: number | undefined;
    if (typeof entry === 'number') {
      port = entry;
    } else if (typeof entry === 'string') {
      // host:container or host_ip:host:container — the container port is the
      // last colon-segment, optionally with a /protocol suffix.
      const last = entry.split(':').pop() ?? '';
      const n = Number.parseInt(last.split('/')[0]!, 10);
      if (Number.isFinite(n)) port = n;
    } else if (entry !== null && typeof entry === 'object') {
      const target = (entry as { target?: unknown }).target;
      const n = typeof target === 'number' ? target : Number.parseInt(String(target), 10);
      if (Number.isFinite(n)) port = n;
    }
    if (port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535) {
      out.push(port);
    }
  }
  return out;
}

/**
 * Translate a compose `healthcheck` into the neutral descriptor healthcheck.
 * Compose only has the exec form (`test: ["CMD", …]` or `test: "shell string"`);
 * we map the CMD form to an `exec` healthcheck and drop the rest (a shell-string
 * test can't be modelled without a shell, and the backend supplies one). Returns
 * undefined when nothing maps — the descriptor's healthcheck is optional.
 */
function coerceHealthcheck(raw: unknown): ServiceDescriptor['healthcheck'] | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const test = (raw as { test?: unknown }).test;
  if (Array.isArray(test)) {
    // ["CMD", "pg_isready"] / ["CMD-SHELL", "..."] — keep the CMD form's argv.
    const parts = test.filter((t): t is string => typeof t === 'string');
    const head = parts[0];
    if (head === 'CMD') {
      const command = parts.slice(1);
      if (command.length > 0) return { kind: 'exec', command };
    }
    // CMD-SHELL / NONE → not modellable as a clean argv; omit.
  }
  return undefined;
}

/**
 * Curated `docker-compose.yml` → service descriptors. Pure + total: it always
 * RETURNS (never throws, never spawns). See the module header for the security
 * posture (I8 / I10).
 */
export function translateComposeToServices(yaml: string): ComposeTranslateResult {
  let parsed: unknown;
  try {
    parsed = yamlLoad(yaml);
  } catch (e) {
    if (e instanceof YAMLException) return { ok: false, error: `Invalid YAML: ${e.message}` };
    return { ok: false, error: `Invalid YAML: ${String(e)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Compose file must be a YAML mapping.' };
  }
  const doc = parsed as Record<string, unknown>;
  const servicesRaw = doc.services;
  if (servicesRaw === null || typeof servicesRaw !== 'object' || Array.isArray(servicesRaw)) {
    return { ok: false, error: 'Compose file has no "services" mapping.' };
  }

  const services: ServiceDescriptor[] = [];
  const drops: ComposeDrop[] = [];
  const invalid: ComposeInvalid[] = [];

  // WeakSet guards a cyclic alias/anchor graph: a service object that aliases
  // itself would otherwise recurse forever when we read its fields. We only read
  // top-level service fields (no deep recursion), so tracking the per-service
  // objects we've already mapped is enough to stop a self-referential service
  // from being processed twice.
  const seen = new WeakSet<object>();

  for (const [name, svcRaw] of Object.entries(servicesRaw as Record<string, unknown>)) {
    if (svcRaw === null || typeof svcRaw !== 'object' || Array.isArray(svcRaw)) {
      invalid.push({ name, reason: 'service entry is not a mapping' });
      continue;
    }
    if (seen.has(svcRaw)) continue;
    seen.add(svcRaw);
    const svc = svcRaw as Record<string, unknown>;

    // I10 — record every dangerous field we're dropping (allow-list map means
    // they never cross; this just makes the removal visible to the author).
    for (const field of DROPPED_FIELDS) {
      if (field in svc && svc[field] !== undefined) {
        // `network_mode` is only an escape vector when it's `host` — a bridge /
        // service network is fine and irrelevant to the descriptor, so we only
        // flag the host case (still don't map it either way).
        if (field === 'network_mode' && svc[field] !== 'host') continue;
        const value = echoValue(svc[field]);
        drops.push(value === undefined ? { service: name, field } : { service: name, field, value });
      }
    }

    const image = typeof svc.image === 'string' ? svc.image : undefined;
    if (image === undefined) {
      invalid.push({ name, reason: 'service has no "image"' });
      continue;
    }
    if (!DIGEST_PINNED_IMAGE_RE.test(image)) {
      // I8 — flag, don't drop. The author pins it to an immutable @sha256 digest.
      invalid.push({
        name,
        image,
        reason: `image "${image}" must be digest-pinned (…@sha256:<64 hex>) — pin it to an immutable digest`,
      });
      continue;
    }

    // ALLOW-LIST map — only these four fields cross.
    const candidate: Record<string, unknown> = {
      name,
      image,
      ports: coercePorts(svc.ports),
      env: coerceEnv(svc.environment),
    };
    const hc = coerceHealthcheck(svc.healthcheck);
    if (hc !== undefined) candidate.healthcheck = hc;

    const result = ServiceDescriptorSchema.safeParse(candidate);
    if (result.success) {
      services.push(result.data);
    } else {
      const first = result.error.issues[0];
      invalid.push({
        name,
        image,
        reason: first ? `${first.path.join('.') || 'descriptor'}: ${first.message}` : 'invalid descriptor',
      });
    }
  }

  return { ok: true, services, drops, invalid };
}
