import { describe, it, expect } from 'vitest';
import { composeSystemPrompt } from '../onboard/AgentBootstrap';

describe('composeSystemPrompt', () => {
  // Regression: a bootstrapped agent named "Ada" answered "what's your name?"
  // with "I'm Claude" because the name was only included in the empty-soul
  // fallback — any chosen personality (typed or a vibe chip) dropped it.
  it('always names the agent, even when a personality (soul) is provided', () => {
    const prompt = composeSystemPrompt({
      name: 'Ada',
      // the exact "Playful" vibe-chip sentence that triggered the bug
      soul: 'You keep a light, playful tone and a sense of humor.',
      purpose: '',
    });
    expect(prompt).toContain('You are Ada');
    expect(prompt).toContain('You keep a light, playful tone and a sense of humor.');
  });

  it('names the agent when no personality is given (empty soul)', () => {
    const prompt = composeSystemPrompt({ name: 'Sol', soul: '', purpose: '' });
    expect(prompt).toContain('You are Sol');
  });

  it('includes the purpose as a "Your job:" line when provided', () => {
    const prompt = composeSystemPrompt({
      name: 'Wren',
      soul: 'You are direct and concise.',
      purpose: 'help me draft and edit writing',
    });
    expect(prompt).toContain('You are Wren');
    expect(prompt).toContain('You are direct and concise.');
    expect(prompt).toContain('Your job: help me draft and edit writing');
  });

  it('puts the identity line first', () => {
    const prompt = composeSystemPrompt({ name: 'Pilot', soul: 'You are playful.', purpose: 'help' });
    expect(prompt.startsWith('You are Pilot')).toBe(true);
  });
});
