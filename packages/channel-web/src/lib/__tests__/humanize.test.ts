import { describe, expect, it } from 'vitest';
import { humanizeId, humanizeSlotLabel } from '../humanize';

describe('humanizeId', () => {
  it('turns a shouted slot id into a readable label', () => {
    expect(humanizeId('ANTHROPIC_API_KEY')).toBe('Anthropic API key');
    expect(humanizeId('OPENAI_API_KEY')).toBe('OpenAI API key');
  });

  it('keeps acronyms uppercase and ordinary words lowercase', () => {
    expect(humanizeId('api_key')).toBe('API key');
    expect(humanizeId('client_secret')).toBe('Client secret');
    expect(humanizeId('discovery_url')).toBe('Discovery URL');
    expect(humanizeId('client_id')).toBe('Client ID');
  });

  it('uppercases the formats that turn up in skill ids', () => {
    // (TASK-344) `pdf-tools` reading "Pdf tools" looks like a typo rather than
    // a name, on a consent dialog where the name is what is being vouched for.
    expect(humanizeId('pdf-tools')).toBe('PDF tools');
    expect(humanizeId('csv-export')).toBe('CSV export');
  });

  it('cases brands the way they case themselves', () => {
    expect(humanizeId('anthropic')).toBe('Anthropic');
    expect(humanizeId('openai')).toBe('OpenAI');
    expect(humanizeId('openrouter')).toBe('OpenRouter');
    expect(humanizeId('github')).toBe('GitHub');
  });

  it('splits hyphens, underscores and camelCase alike', () => {
    expect(humanizeId('linear-issues')).toBe('Linear issues');
    expect(humanizeId('clientSecret')).toBe('Client secret');
    expect(humanizeId('some.nested_id')).toBe('Some nested ID');
  });

  it('keeps a short unknown all-caps token as the acronym it looks like', () => {
    expect(humanizeId('SMTP_HOST')).toBe('SMTP host');
  });

  it('stops a long unknown all-caps token from shouting like an acronym', () => {
    // A producer shouting a brand name is far commoner than a 6+ letter
    // acronym, and "Google GDRIVE" reads like a bug.
    expect(humanizeId('GDRIVE')).toBe('Gdrive');
    expect(humanizeSlotLabel('GDRIVE', 'google')).toBe('Google Gdrive');
    expect(humanizeId('SENDGRID_API_KEY')).toBe('Sendgrid API key');
  });

  it('is not fooled by ids that name Object.prototype members', () => {
    // An agent can author a skill, so these ids are untrusted input. With a
    // plain-object lookup table, `constructor` resolves through the prototype
    // and hands back a function where a string is expected — which throws
    // while rendering the one card whose whole job is to be trustworthy.
    expect(humanizeId('constructor')).toBe('Constructor');
    expect(humanizeId('valueOf_key')).toBe('Value of key');
    expect(humanizeId('toString')).toBe('To string');
    expect(humanizeId('hasOwnProperty')).toBe('Has own property');
    expect(humanizeSlotLabel('api_key', 'constructor')).toBe('Constructor API key');
  });

  it('degrades unknown ids to readable text rather than throwing or emptying', () => {
    expect(humanizeId('foo_bar')).toBe('Foo bar');
    expect(humanizeId('')).toBe('');
    expect(humanizeId('___')).toBe('___');
  });
});

describe('humanizeSlotLabel', () => {
  it('names the service the key belongs to', () => {
    expect(humanizeSlotLabel('api_key', 'anthropic')).toBe('Anthropic API key');
  });

  it('does not say the service twice when the slot id already carries it', () => {
    expect(humanizeSlotLabel('ANTHROPIC_API_KEY', 'anthropic')).toBe('Anthropic API key');
  });

  it('does not double up when a multi-word service only partly overlaps', () => {
    // (TASK-344) This asked whether the service was a strict PREFIX of the slot,
    // which is true for anthropic/ANTHROPIC_API_KEY and false here — so a skill
    // called `linear-tracker` holding a `LINEAR_TOKEN` rendered as
    // "Linear tracker Linear token".
    expect(humanizeSlotLabel('LINEAR_TOKEN', 'linear-tracker')).toBe('Linear token');
  });

  it('falls back to the bare slot label with no service', () => {
    expect(humanizeSlotLabel('api_key')).toBe('API key');
    expect(humanizeSlotLabel('api_key', undefined)).toBe('API key');
  });
});
