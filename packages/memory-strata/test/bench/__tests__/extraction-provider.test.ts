import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { DEFAULT_MEMORY_OPS_MODEL } from '@ax/memory-strata';
import * as e2eCli from '../e2e-cli.js';
import { PRICING } from '../e2e-cli.js';
import { DEFAULT_EXTRACTION_MODEL } from '../e2e-driver.js';

// The 2026-09-14 model policy moved memory extraction from Haiku to GLM by
// changing DEFAULT_MEMORY_OPS_MODEL. Three bench diagnostics kept building an
// ANTHROPIC client and handing it that id, so they sent
// `z-ai/glm-5.3-flash:nitro` to api.anthropic.com and 404'd on every call.
// Nothing noticed for a month: a diagnostic has no gate, so it does not fail —
// it just stops being runnable, and the next person to reach for it loses an
// afternoon before realising the tool itself is broken.
describe('bench extraction runs on the shipped provider', () => {
  it('offers exactly ONE extraction client, on the provider the shipped model names', () => {
    const provider = DEFAULT_MEMORY_OPS_MODEL.slice(0, DEFAULT_MEMORY_OPS_MODEL.indexOf('/'));
    const factories = Object.keys(e2eCli).filter((k) => /^make.*ExtractionLlm$/.test(k));
    // Exactly one, and it names the provider the shipped model routes to. Two
    // factories is the defect: it lets a caller pick the wrong one silently.
    expect(factories).toHaveLength(1);
    expect(factories[0]?.toLowerCase()).toBe(`make${provider}extractionllm`);
  });

  it('prices the extraction model, so a metered diagnostic cannot die mid-run', () => {
    expect(PRICING[DEFAULT_EXTRACTION_MODEL]).toBeDefined();
  });

  it('leaves no bench entrypoint importing an extraction client of another provider', async () => {
    // The compiler already enforces this for the deleted factory; the scan keeps
    // it true for a NEW one added next to it, which is how the last one arrived.
    const dir = fileURLToPath(new URL('..', import.meta.url));
    for (const f of ['repro-extract.ts', 'repro-count-diag.ts', 'repro-orch-retrieval.ts', 'diag-detail-loss.ts']) {
      const src = await readFile(`${dir}${f}`, 'utf8');
      expect(src, `${f} builds its own non-shipped extraction client`).not.toMatch(
        /makeAnthropicExtractionLlm/,
      );
    }
  });
});
