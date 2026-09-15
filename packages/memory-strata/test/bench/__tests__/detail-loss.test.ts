import { describe, it, expect } from 'vitest';
import { contentTokens, classifyDetailLoss } from '../detail-loss.js';

describe('contentTokens', () => {
  it('keeps short numeric tokens, which are exactly the values being dropped', () => {
    // The whole bug under investigation is specific VALUES vanishing — "38
    // subjects", "20%", the year. A >=4-char filter (diag-truncation's, which
    // is right for ITS purpose) would discard "38" and "20" and leave only the
    // generic noun, so every question would score as "survived".
    expect(contentTokens('38 subjects')).toContain('38');
    expect(contentTokens('approximately 20% improvement')).toContain('20');
    expect(contentTokens('2014.')).toContain('2014');
  });

  it('drops stopwords and short non-numeric words', () => {
    const t = contentTokens('the one I want, the one I need');
    expect(t).not.toContain('the');
    expect(t).not.toContain('one');
  });

  it('flattens non-string gold answers rather than throwing', () => {
    // LongMemEval gold answers are not always strings.
    expect(contentTokens(2014)).toContain('2014');
    expect(contentTokens(['white', 'Adidas'])).toContain('adidas');
    expect(contentTokens(null)).toEqual([]);
  });
});

describe('classifyDetailLoss', () => {
  const layers = (raw: string, extracted: string, consolidated: string) => ({
    raw,
    extracted,
    consolidated,
  });

  it('blames extraction when the value is in the session but in no extracted fact', () => {
    const v = classifyDetailLoss('38 subjects', layers('a study of 38 subjects', 'binaural beats', ''));
    expect(v.lostAt).toBe('extraction');
    expect(v.presentInRaw).toContain('38');
    expect(v.survivedExtraction).toEqual([]);
  });

  it('blames consolidation when extraction caught it and the docs tree did not keep it', () => {
    const v = classifyDetailLoss(
      '38 subjects',
      layers('a study of 38 subjects', 'study had 38 subjects', 'discussed binaural beats'),
    );
    expect(v.lostAt).toBe('consolidation');
    expect(v.survivedExtraction).toContain('38');
    expect(v.survivedConsolidation).toEqual([]);
  });

  it('blames NEITHER when the value is still in the consolidated tree', () => {
    // The third bucket the handoff did not anticipate: memory kept the value and
    // the failure is downstream (retrieval or the answer stage). Reporting this
    // as "consolidation" would send the next session to fix the wrong component.
    const v = classifyDetailLoss(
      '38 subjects',
      layers('a study of 38 subjects', 'study had 38 subjects', 'the study had 38 subjects'),
    );
    expect(v.lostAt).toBe('retained');
    expect(v.survivedConsolidation).toContain('38');
  });

  it('reports absent-from-corpus rather than guessing when no gold token is in the raw sessions', () => {
    // Without this the tool would call a paraphrase-only gold answer an
    // extraction bug, which is the failure mode of a token-overlap metric.
    const v = classifyDetailLoss('a bluegrass band with a banjo player', layers('jazz', 'jazz', 'jazz'));
    expect(v.lostAt).toBe('absent-from-corpus');
  });

  it('scores a needle phrase whole, not token by token', () => {
    // "C D E F G A B A G F E D C" tokenizes to nothing useful; the phrase is the
    // only honest probe for it.
    const v = classifyDetailLoss('the chorus', layers('x C D E F G A B A G F E D C y', 'x', 'x'), {
      needles: ['C D E F G A B A G F E D C'],
    });
    expect(v.presentInRaw).toContain('C D E F G A B A G F E D C');
    expect(v.lostAt).toBe('extraction');
  });
});

describe('metadata lines are not evidence', () => {
  it('does not count a probe that only appears inside a hash or uuid', () => {
    // Real case: the consolidated tree carries `hash: c61f89d013899ecc` and
    // uuid lists, so the probe "38" matched 12 lines of pure metadata before it
    // matched the one sentence that actually answers the question. A verdict of
    // `retained` sourced from a hash would send the next session to fix
    // retrieval when memory really had dropped the value.
    const consolidated = [
      'hash: c61f89d013899ecc',
      'rollup_hash: 69f038b98e15748a',
      '  - b803e9ef-1083-47eb-ba38-f98ff53ee698',
      'The user discussed binaural beats.',
    ].join('\n');
    const v = classifyDetailLoss('38 subjects', {
      raw: 'a study of 38 subjects',
      extracted: 'study of 38 subjects',
      consolidated,
    });
    expect(v.survivedConsolidation).not.toContain('38');
    expect(v.lostAt).toBe('consolidation');
  });

  it('reports the prose line each surviving probe matched, so a verdict is auditable', () => {
    const v = classifyDetailLoss('38 subjects', {
      raw: 'a study of 38 subjects',
      extracted: 'study of 38 subjects',
      consolidated: 'hash: aa38bb\n- Music and Medicine — 38 subjects, 30 minutes daily.',
    });
    expect(v.lostAt).toBe('retained');
    expect(v.evidence.map((e) => e.line).join()).toContain('Music and Medicine');
    expect(v.evidence.map((e) => e.line).join()).not.toContain('hash:');
  });
});
