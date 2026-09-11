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

  it('falls back to the bare slot label with no service', () => {
    expect(humanizeSlotLabel('api_key')).toBe('API key');
    expect(humanizeSlotLabel('api_key', undefined)).toBe('API key');
  });
});
