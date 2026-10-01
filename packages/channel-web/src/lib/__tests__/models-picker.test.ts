import { describe, expect, it } from 'vitest';
import type { CatalogProvider } from '../models-admin';
import {
  addModels,
  countModels,
  filterProviders,
  isDirty,
  labelFor,
  removeModel,
  removedModels,
  selectedInfo,
  setDefault,
  toggleModel,
} from '../models-picker';

const OPUS = 'anthropic/claude-opus-4-7';
const SONNET = 'anthropic/claude-sonnet-4-6';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const GROK = 'openrouter/x-ai/grok-4.6';

const providers: CatalogProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    status: 'live',
    models: [
      { ref: OPUS, label: 'Claude Opus 4.7' },
      { ref: SONNET, label: 'Claude Sonnet 4.6' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    status: 'live',
    models: [
      { ref: KIMI, label: 'Kimi K3' },
      { ref: GROK, label: 'xAI: Grok 4.6' },
    ],
  },
];

describe('filterProviders', () => {
  it('returns every provider untouched for an empty or blank query', () => {
    expect(filterProviders(providers, '')).toEqual(providers);
    expect(filterProviders(providers, '   ')).toEqual(providers);
  });
  it('matches label, ref and provider name, case-insensitively', () => {
    expect(filterProviders(providers, 'OPUS').flatMap((p) => p.models.map((m) => m.ref))).toEqual([OPUS]);
    expect(filterProviders(providers, 'moonshotai').flatMap((p) => p.models.map((m) => m.ref))).toEqual([KIMI]);
    expect(filterProviders(providers, 'openrouter').flatMap((p) => p.models.map((m) => m.ref))).toEqual([KIMI, GROK]);
  });
  it('requires every word to match, in any order', () => {
    expect(filterProviders(providers, 'sonnet claude').flatMap((p) => p.models.map((m) => m.ref))).toEqual([SONNET]);
    expect(filterProviders(providers, 'claude grok')).toEqual([]);
  });
  it('drops providers with no match while searching', () => {
    expect(filterProviders(providers, 'kimi').map((p) => p.id)).toEqual(['openrouter']);
  });
  it('does not mutate its input', () => {
    const before = JSON.stringify(providers);
    filterProviders(providers, 'kimi');
    expect(JSON.stringify(providers)).toBe(before);
  });
});

describe('countModels', () => {
  it('sums across providers', () => expect(countModels(providers)).toBe(4));
});

describe('draft edits', () => {
  const draft = { allowed: [SONNET, KIMI], default: SONNET };

  it('toggling a new model appends it and keeps the Default', () => {
    expect(toggleModel(draft, OPUS)).toEqual({ allowed: [SONNET, KIMI, OPUS], default: SONNET });
  });
  it('toggling a selected model removes it', () => {
    expect(toggleModel(draft, KIMI)).toEqual({ allowed: [SONNET], default: SONNET });
  });
  it('the first model added to an empty draft becomes the Default', () => {
    expect(toggleModel({ allowed: [], default: '' }, KIMI)).toEqual({ allowed: [KIMI], default: KIMI });
  });
  it('removing the Default makes the first remaining model the Default', () => {
    expect(removeModel(draft, SONNET)).toEqual({ allowed: [KIMI], default: KIMI });
  });
  it('removing the last model leaves an empty draft with no Default', () => {
    expect(removeModel({ allowed: [KIMI], default: KIMI }, KIMI)).toEqual({ allowed: [], default: '' });
  });
  it('removing an unselected model is a no-op', () => {
    expect(removeModel(draft, OPUS)).toEqual(draft);
  });
  it('addModels appends only the missing ones, in order, and never changes the Default', () => {
    expect(addModels(draft, [KIMI, OPUS, GROK])).toEqual({ allowed: [SONNET, KIMI, OPUS, GROK], default: SONNET });
  });
  it('addModels on an empty draft picks the first as the Default', () => {
    expect(addModels({ allowed: [], default: '' }, [OPUS, KIMI])).toEqual({ allowed: [OPUS, KIMI], default: OPUS });
  });
  it('setDefault only accepts a selected model', () => {
    expect(setDefault(draft, KIMI).default).toBe(KIMI);
    expect(setDefault(draft, OPUS)).toEqual(draft);
  });
});

describe('isDirty / removedModels', () => {
  const saved = { allowed: [SONNET, KIMI], default: SONNET };
  it('is clean for the same selection, in any order', () => {
    expect(isDirty(saved, { allowed: [KIMI, SONNET], default: SONNET })).toBe(false);
  });
  it('is dirty when the selection or the Default changes', () => {
    expect(isDirty(saved, { allowed: [SONNET], default: SONNET })).toBe(true);
    expect(isDirty(saved, { allowed: [SONNET, KIMI], default: KIMI })).toBe(true);
  });
  it('lists what was removed, and only that', () => {
    expect(removedModels(saved, { allowed: [SONNET, OPUS], default: SONNET })).toEqual([KIMI]);
    expect(removedModels(saved, { allowed: [SONNET, KIMI, OPUS], default: SONNET })).toEqual([]);
  });
});

describe('labels and badges', () => {
  it('uses the catalog label, else the ref', () => {
    expect(labelFor(KIMI, providers)).toBe('Kimi K3');
    expect(labelFor('openrouter/gone/model', providers)).toBe('openrouter/gone/model');
  });
  it('reports the provider name and no badges for a listed model', () => {
    expect(selectedInfo(KIMI, providers)).toEqual({
      label: 'Kimi K3',
      providerName: 'OpenRouter',
      noLongerListed: false,
      needsKey: false,
    });
  });
  it('flags "no longer listed" only when the provider list is authoritative', () => {
    expect(selectedInfo('openrouter/gone/model', providers).noLongerListed).toBe(true);
    const shaky = providers.map((p) => (p.id === 'openrouter' ? { ...p, status: 'fallback' as const } : p));
    expect(selectedInfo('openrouter/gone/model', shaky).noLongerListed).toBe(false);
  });
  it('flags a model whose provider has no key', () => {
    const noKey = providers.map((p) => (p.id === 'openrouter' ? { ...p, status: 'no-key' as const, models: [] } : p));
    expect(selectedInfo(KIMI, noKey)).toMatchObject({ needsKey: true, noLongerListed: false });
  });
  it('names an unknown provider by its id', () => {
    expect(selectedInfo('mystery/model-1', providers).providerName).toBe('mystery');
  });
});
