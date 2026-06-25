import { z } from 'zod';
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import {
  type AllowedContentType,
  validateLogoUpload,
} from './image-validation.js';
import {
  parseRecord,
  serializeRecord,
  toWire,
  type BrandingRecord,
} from './record.js';
import {
  parseRequestBody,
  requireAdmin,
  BRANDING_BODY_MAX_BYTES,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

export { BRANDING_BODY_MAX_BYTES } from './shared.js';

const PLUGIN_NAME = '@ax/branding';
const STORAGE_KEY = 'settings:branding';

/** Long cache — the URL is `?v=`-version-busted, so stale bytes never persist. */
const LOGO_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/**
 * SVG is served from a same-origin URL, so a direct navigation would otherwise
 * execute any embedded <script>. `sandbox` (no allow-* tokens) drops the
 * document into a unique-origin sandbox with scripting disabled; `default-src
 * 'none'` blocks every fetch. The SPA additionally only ever renders the logo
 * via <img>, which doesn't execute SVG scripts.
 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** Injected clock so tests get deterministic `version` stamps. */
export type Now = () => string;
const defaultNow: Now = () => new Date().toISOString();

const LogoFieldSchema = z.object({
  contentType: z.string(),
  dataBase64: z.string(),
});

const PutBodySchema = z
  .object({
    name: z.string().max(200).optional(),
    logoType: z.enum(['full', 'icon']).optional(),
    light: LogoFieldSchema.nullable().optional(),
    dark: LogoFieldSchema.nullable().optional(),
  })
  .strict();

type Variant = 'light' | 'dark';
const VARIANTS: readonly Variant[] = ['light', 'dark'];

export interface BrandingHandlers {
  getBranding(req: RouteRequest, res: RouteResponse): Promise<void>;
  getLogo(req: RouteRequest, res: RouteResponse): Promise<void>;
  putBranding(req: RouteRequest, res: RouteResponse): Promise<void>;
}

export function createBrandingHandlers(deps: {
  bus: HookBus;
  now?: Now;
}): BrandingHandlers {
  const { bus } = deps;
  const now = deps.now ?? defaultNow;
  const ctx: AgentContext = makeAgentContext({
    sessionId: 'branding',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });

  async function readRecord(): Promise<BrandingRecord> {
    const out = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: STORAGE_KEY },
    );
    return parseRecord(out.value);
  }

  return {
    /** GET /api/branding — public. */
    async getBranding(_req, res) {
      const record = await readRecord();
      res.status(200).json(toWire(record));
    },

    /** GET /api/branding/logo/:variant — public. */
    async getLogo(req, res) {
      const variant = req.params.variant;
      if (variant !== 'light' && variant !== 'dark') {
        res.status(400).json({ error: 'invalid-variant' });
        return;
      }
      const record = await readRecord();
      const ptr = record[variant];
      if (ptr === null) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      const got = await bus.call<
        { sha256: string },
        { bytes: Uint8Array } | { found: false }
      >('blob:get', ctx, { sha256: ptr.sha256 });
      if ('found' in got) {
        // Pointer references a blob that's gone — treat as absent.
        res.status(404).json({ error: 'not-found' });
        return;
      }
      res.header('content-type', ptr.contentType);
      res.header('cache-control', LOGO_CACHE_CONTROL);
      res.header('x-content-type-options', 'nosniff');
      if (ptr.contentType === 'image/svg+xml') {
        res.header('content-security-policy', SVG_CSP);
      }
      res.body(Buffer.from(got.bytes));
    },

    /** PUT /admin/branding — admin only. */
    async putBranding(req, res) {
      const actor = await requireAdmin(bus, ctx, req, res);
      if (actor === null) return;

      const parsed = parseRequestBody(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const schema = PutBodySchema.safeParse(parsed.value);
      if (!schema.success) {
        const first = schema.error.issues[0];
        res.status(400).json({
          error:
            first?.message !== undefined && first.message.length > 0
              ? first.message
              : 'invalid-payload',
        });
        return;
      }
      const body = schema.data;

      // Phase 1 — validate every supplied logo BEFORE any blob:put, so a
      // validation failure on the second logo can't orphan the first.
      // Map presence = field supplied; null = clear; object = set.
      const supplied = new Map<
        Variant,
        { bytes: Uint8Array; contentType: AllowedContentType } | null
      >();
      for (const variant of VARIANTS) {
        const field = body[variant];
        if (field === undefined) continue;
        if (field === null) {
          supplied.set(variant, null);
          continue;
        }
        const v = validateLogoUpload(field.contentType, field.dataBase64);
        if (!v.ok) {
          res.status(422).json({ error: v.error });
          return;
        }
        supplied.set(variant, {
          bytes: v.bytes,
          contentType: field.contentType as AllowedContentType,
        });
      }

      // Phase 2 — apply.
      const current = await readRecord();
      const next: BrandingRecord = { ...current };
      if (body.name !== undefined) next.name = body.name;
      if (body.logoType !== undefined) next.logoType = body.logoType;

      const replacedShas: string[] = [];
      for (const variant of VARIANTS) {
        if (!supplied.has(variant)) continue; // omitted → unchanged
        const cur = current[variant];
        if (cur !== null) replacedShas.push(cur.sha256);
        const d = supplied.get(variant);
        if (d === undefined || d === null) {
          next[variant] = null;
          continue;
        }
        const put = await bus.call<
          { bytes: Uint8Array },
          { sha256: string; size: number }
        >('blob:put', ctx, { bytes: d.bytes });
        next[variant] = { sha256: put.sha256, contentType: d.contentType };
      }

      next.version = now();
      await bus.call('storage:set', ctx, {
        key: STORAGE_KEY,
        value: serializeRecord(next),
      });

      // Phase 3 — delete orphaned blobs. Content-addressed storage may share a
      // sha across variants, so only delete shas the surviving record no
      // longer references. Best-effort: a delete failure must not fail the PUT.
      const stillReferenced = new Set<string>();
      if (next.light !== null) stillReferenced.add(next.light.sha256);
      if (next.dark !== null) stillReferenced.add(next.dark.sha256);
      for (const sha of replacedShas) {
        if (stillReferenced.has(sha)) continue;
        try {
          await bus.call('blob:delete', ctx, { sha256: sha });
        } catch {
          // best-effort GC; the orphan is harmless
        }
      }

      res.status(204).end();
    },
  };
}

interface RouteSpec {
  method: 'GET' | 'PUT';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

/**
 * Register the branding routes. Returns the unregister callbacks; unwinds
 * atomically if any registration throws.
 */
export async function registerBrandingRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  now?: Now,
): Promise<Array<() => void>> {
  const handlers = createBrandingHandlers(now !== undefined ? { bus, now } : { bus });
  const routes: RouteSpec[] = [
    { method: 'GET', path: '/api/branding', handler: handlers.getBranding },
    {
      method: 'GET',
      path: '/api/branding/logo/:variant',
      handler: handlers.getLogo,
    },
    {
      method: 'PUT',
      path: '/admin/branding',
      handler: handlers.putBranding,
      maxBodyBytes: BRANDING_BODY_MAX_BYTES,
    },
  ];

  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const result = await bus.call<RouteSpec, { unregister: () => void }>(
        'http:register-route',
        initCtx,
        route,
      );
      unregisters.push(result.unregister);
    }
  } catch (err) {
    while (unregisters.length > 0) {
      const fn = unregisters.pop();
      try {
        fn?.();
      } catch {
        // best-effort unwind
      }
    }
    throw err;
  }
  return unregisters;
}
