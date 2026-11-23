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
//   - Task 1.4 widens the allow-list: `command`/`entrypoint` (argv, never run
//     through a shell here), `restart: "no"` (job), both sides of `ports`,
//     `depends_on` (start order only), `profiles` (selection), and `tmpfs` /
//     NAMED volumes (writable scratch paths). Host bind mounts are STILL
//     dropped and reported; a relative, writable bind mount of source marks the
//     service as the app (`appServices`) rather than infrastructure.
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
  /** Present when the service is valid in every way EXCEPT its image is a
   *  floating tag. `image` is the tag as written; the editor pins it (Task 1.5)
   *  and saves. Never present for any other kind of invalid service. */
  draft?: ServiceDescriptor;
}

/** A service the importer did not import because it looks like the person's own
 *  app (it bind-mounts source): run it in the sandbox instead. */
export interface ComposeAppService {
  service: string;
  reason: 'mounts-source';
}

/** The slice of a compose service that start-order sorting needs. */
export interface ComposeService {
  name: string;
  dependsOn: string[];
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
      /** Every profile named anywhere in the file. */
      profiles: string[];
      /** Services bind-mounting source: not imported. */
      appServices: ComposeAppService[];
      /** Start order of every imported service (`services` plus unpinned
       *  `invalid[].draft`s). `services` is already in this order too. */
      order: string[];
    }
  | { ok: false; error: string };

// The compose keys we deliberately DROP and REPORT. Each is a sandbox-escape
// vector or a host-coupling we never let cross into the sandbox (I10):
//   volumes        — host bind mounts (incl. /var/run/docker.sock socket mounts);
//                    handled separately below, since named volumes now import
//   privileged     — drops every isolation boundary
//   cap_add        — re-grants dropped Linux capabilities (SYS_ADMIN, etc.)
//   network_mode   — `host` shares the host network namespace
//   devices        — passes host device nodes (/dev/kvm, …) into the container
//   pid / ipc      — `host` shares the host PID / IPC namespace
//   userns_mode    — `host` disables user-namespace remapping
//   security_opt   — `seccomp:unconfined` / `apparmor:unconfined` removes the LSM
const DROPPED_FIELDS = [
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
        out[entry.slice(0, eq)] = unescapeComposeDollars(entry.slice(eq + 1));
      }
    }
    return out;
  }
  if (raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v === null || v === undefined ? '' : unescapeComposeDollars(String(v));
    }
  }
  return out;
}

/** A bare decimal port 1..65535; anything else (ranges, names) → undefined. */
function parsePort(raw: unknown): number | undefined {
  const str = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^\d{1,5}$/.test(str)) return undefined;
  const n = Number(str);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Read a compose `ports` block into the container ports AND the published
 * (host-side) → container pairs. Handles `"5432:5432"`, `"127.0.0.1:5432:5432"`,
 * `5432`, `"5432/tcp"` and the long `{ target, published }` form. Ranges and
 * anything unreadable are skipped. A pair whose two sides are equal needs no
 * forward and is not recorded (the descriptor validator refuses it).
 */
function coercePorts(raw: unknown): {
  ports: number[];
  published: Array<{ published: number; target: number }>;
} {
  const ports: number[] = [];
  const published: Array<{ published: number; target: number }> = [];
  if (!Array.isArray(raw)) return { ports, published };
  for (const entry of raw) {
    let target: number | undefined;
    let host: number | undefined;
    if (typeof entry === 'number') {
      target = parsePort(entry);
    } else if (typeof entry === 'string') {
      const segs = entry.split('/')[0]!.split(':');
      target = parsePort(segs[segs.length - 1]);
      // host:container or host_ip:host:container — the host port is the
      // segment just before the container port.
      if (segs.length >= 2) host = parsePort(segs[segs.length - 2]);
    } else if (entry !== null && typeof entry === 'object') {
      const e = entry as { target?: unknown; published?: unknown };
      target = parsePort(e.target);
      host = parsePort(e.published);
    }
    if (target === undefined) continue;
    ports.push(target);
    if (host !== undefined && host !== target) published.push({ published: host, target });
  }
  return { ports, published };
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

/** `$$` is compose's escape for a literal `$`. */
export function unescapeComposeDollars(arg: string): string {
  return arg.replace(/\$\$/g, '$');
}

/**
 * Split a command string into argv the way compose does when it isn't handed a
 * list: whitespace-separated, `'…'` literal, `"…"` with backslash escapes. No
 * shell is involved — no globbing, no variable expansion, no operators.
 */
function splitCommandString(str: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < str.length && '"\\$'.includes(str[i + 1]!)) cur += str[++i]!;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) {
        out.push(cur);
        cur = '';
        inToken = false;
      }
    } else if (ch === '\\' && i + 1 < str.length) {
      cur += str[++i]!;
      inToken = true;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

/** compose `command` / `entrypoint` (list or string) → argv with `$$` → `$`. */
function coerceArgv(raw: unknown): string[] | undefined {
  let argv: string[] | undefined;
  if (typeof raw === 'string') argv = splitCommandString(raw);
  else if (Array.isArray(raw)) argv = raw.map((a) => String(a));
  if (argv === undefined || argv.length === 0) return undefined;
  return argv.map(unescapeComposeDollars);
}

interface MountReading {
  /** Absolute container paths that become writable scratch (tmpfs / named volume). */
  writable: string[];
  /** Host bind mounts, echoed for the drop notice. Never imported. */
  binds: string[];
  /** A writable bind mount of a relative path: the person's source tree. */
  mountsSource: boolean;
}

/** A named volume is a bare name; anything that looks like a path or an
 *  interpolation is a host bind mount. */
const NAMED_VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function readMounts(svc: Record<string, unknown>): MountReading {
  const out: MountReading = { writable: [], binds: [], mountsSource: false };
  const addWritable = (p: unknown) => {
    if (typeof p === 'string' && p.startsWith('/')) out.writable.push(p);
  };
  const tmpfs = svc.tmpfs;
  for (const t of Array.isArray(tmpfs) ? tmpfs : tmpfs === undefined ? [] : [tmpfs]) {
    if (typeof t === 'string') addWritable(t.split(':')[0]);
  }
  const volumes = Array.isArray(svc.volumes) ? svc.volumes : [];
  for (const v of volumes) {
    let source: string | undefined;
    let target: string | undefined;
    let readOnly = false;
    let kind: string | undefined;
    if (typeof v === 'string') {
      const segs = v.split(':');
      if (segs.length === 1) {
        target = segs[0]; // anonymous volume
        kind = 'volume';
      } else {
        source = segs[0];
        target = segs[1];
        readOnly = (segs[2] ?? '').split(',').includes('ro');
      }
    } else if (v !== null && typeof v === 'object') {
      const e = v as Record<string, unknown>;
      kind = typeof e.type === 'string' ? e.type : undefined;
      source = typeof e.source === 'string' ? e.source : undefined;
      target = typeof e.target === 'string' ? e.target : undefined;
      readOnly = e.read_only === true;
    } else {
      continue;
    }
    if (kind === 'tmpfs') {
      addWritable(target);
      continue;
    }
    const isNamed =
      kind === 'volume' ||
      (kind === undefined && source !== undefined && NAMED_VOLUME_RE.test(source));
    if (isNamed && target !== undefined && target.startsWith('/')) {
      addWritable(target);
      continue;
    }
    out.binds.push(echoValue(v) ?? String(source));
    if (source !== undefined && /^\.{1,2}(\/|$)/.test(source) && !readOnly) out.mountsSource = true;
  }
  return out;
}

const DEPENDS_CONDITIONS = ['service_started', 'service_healthy', 'service_completed_successfully'];

/** `depends_on` (list, or map with conditions) → names; or the first bad condition. */
function readDependsOn(raw: unknown): { names: string[] } | { badCondition: string } {
  if (Array.isArray(raw)) return { names: raw.filter((n): n is string => typeof n === 'string') };
  if (raw !== null && typeof raw === 'object') {
    const names: string[] = [];
    for (const [dep, cfg] of Object.entries(raw as Record<string, unknown>)) {
      const cond = cfg !== null && typeof cfg === 'object' ? (cfg as { condition?: unknown }).condition : undefined;
      if (cond !== undefined && (typeof cond !== 'string' || !DEPENDS_CONDITIONS.includes(cond))) {
        return { badCondition: `depends_on "${dep}" has unknown condition "${String(cond)}"` };
      }
      names.push(dep);
    }
    return { names };
  }
  return { names: [] };
}

/**
 * Start order: Kahn's algorithm, ties broken by the input (declaration) order so
 * the result is stable. A dependency on a name not in the input is ignored.
 * When there is a cycle, returns the services that sit on one.
 */
export function sortByDependsOn(
  services: ComposeService[],
): { order: string[] } | { cycle: string[] } {
  const names = new Set(services.map((s) => s.name));
  const deps = new Map(services.map((s) => [s.name, new Set(s.dependsOn.filter((d) => names.has(d)))]));
  const order: string[] = [];
  const done = new Set<string>();
  for (;;) {
    const next = services.find((s) => !done.has(s.name) && [...deps.get(s.name)!].every((d) => done.has(d)));
    if (!next) break;
    done.add(next.name);
    order.push(next.name);
  }
  if (order.length === services.length) return { order };
  // Leftovers are cycle members plus anything stuck behind one. Peel off the
  // ones nothing else leftover depends on, so only the cycle itself remains.
  let left = services.map((s) => s.name).filter((n) => !done.has(n));
  for (;;) {
    const dependedOn = new Set(left.flatMap((n) => [...deps.get(n)!].filter((d) => left.includes(d))));
    const peeled = left.filter((n) => dependedOn.has(n));
    if (peeled.length === left.length) break;
    left = peeled;
  }
  return { cycle: left };
}

/** The digest we validate an unpinned image against, to learn whether the pin is
 *  the ONLY thing wrong with it. Never stored. */
const PLACEHOLDER_IMAGE_DIGEST = '@sha256:' + '0'.repeat(64);

/**
 * Curated `docker-compose.yml` → service descriptors. Pure + total: it always
 * RETURNS (never throws, never spawns). See the module header for the security
 * posture (I8 / I10). `opts.profile` picks one compose profile; without it only
 * profile-less services come in.
 */
export function translateComposeToServices(
  yaml: string,
  opts: { profile?: string } = {},
): ComposeTranslateResult {
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

  const drops: ComposeDrop[] = [];
  const invalid: ComposeInvalid[] = [];
  const appServices: ComposeAppService[] = [];
  const profiles = new Set<string>();
  /** Translated services, in declaration order, before start-order sorting. */
  const entries: Array<{ desc: ServiceDescriptor; unpinned: boolean; deps: string[] }> = [];

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

    const svcProfiles = Array.isArray(svc.profiles)
      ? svc.profiles.filter((p): p is string => typeof p === 'string')
      : [];
    for (const p of svcProfiles) profiles.add(p);
    if (svcProfiles.length > 0 && (opts.profile === undefined || !svcProfiles.includes(opts.profile))) {
      continue;
    }

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
    // I10 — host bind mounts never cross; named volumes and tmpfs do.
    const mounts = readMounts(svc);
    if (mounts.binds.length > 0) {
      drops.push({ service: name, field: 'volumes', value: echoValue(mounts.binds) as string });
    }
    if (mounts.mountsSource) {
      appServices.push({ service: name, reason: 'mounts-source' });
      continue;
    }

    const image = typeof svc.image === 'string' ? svc.image : undefined;
    if (image === undefined) {
      invalid.push({ name, reason: 'service has no "image"' });
      continue;
    }

    const dep = readDependsOn(svc.depends_on);
    if ('badCondition' in dep) {
      // Never import half-ordered: a service depending on a refused one would
      // start without its dependency. Refuse the whole profile.
      return { ok: false, error: `Refused: ${name}: ${dep.badCondition}` };
    }

    const unpinned = !DIGEST_PINNED_IMAGE_RE.test(image);
    const { ports, published } = coercePorts(svc.ports);
    const isJob = svc.restart === 'no' || svc.restart === false;
    const writablePaths = [...new Set([...mounts.writable, '/tmp'])];

    // ALLOW-LIST map — only these fields cross.
    const candidate: Record<string, unknown> = {
      name,
      image: unpinned ? image + PLACEHOLDER_IMAGE_DIGEST : image,
      ports,
      env: coerceEnv(svc.environment),
      writablePaths,
    };
    const command = coerceArgv(svc.command);
    if (command !== undefined) candidate.command = command;
    const entrypoint = coerceArgv(svc.entrypoint);
    if (entrypoint !== undefined) candidate.entrypoint = entrypoint;
    if (isJob) candidate.job = true;
    // A job never gets published ports (it exits; nothing to forward to).
    if (!isJob && published.length > 0) candidate.publishedPorts = published;
    const hc = coerceHealthcheck(svc.healthcheck);
    if (hc !== undefined) candidate.healthcheck = hc;
    else if (!isJob && ports.length > 0) candidate.healthcheck = { kind: 'tcp', port: ports[0] };

    const result = ServiceDescriptorSchema.safeParse(candidate);
    if (result.success) {
      entries.push({
        desc: unpinned ? { ...result.data, image } : result.data,
        unpinned,
        deps: dep.names,
      });
    } else {
      const first = result.error.issues[0];
      invalid.push({
        name,
        image,
        reason: first ? `${first.path.join('.') || 'descriptor'}: ${first.message}` : 'invalid descriptor',
      });
    }
  }

  // Start order. A cycle refuses the whole import.
  const kept = entries;
  let order: string[] = [];
  for (;;) {
    const sorted = sortByDependsOn(kept.map((e) => ({ name: e.desc.name, dependsOn: e.deps })));
    if ('order' in sorted) {
      order = sorted.order;
      break;
    }
    return {
      ok: false,
      error: `Refused: depends_on cycle between ${sorted.cycle.join(', ')}`,
    };
  }
  const rank = new Map(order.map((n, i) => [n, i]));
  kept.sort((a, b) => rank.get(a.desc.name)! - rank.get(b.desc.name)!);

  const services: ServiceDescriptor[] = [];
  for (const e of kept) {
    if (!e.unpinned) {
      services.push(e.desc);
      continue;
    }
    invalid.push({
      name: e.desc.name,
      image: e.desc.image,
      reason: `image "${e.desc.image}" must be digest-pinned (…@sha256:<64 hex>) — pin it to an immutable digest`,
      draft: e.desc,
    });
  }

  return { ok: true, services, drops, invalid, profiles: [...profiles], appServices, order };
}
