import { describe, it, expect } from 'vitest';
import { contentTokens, classifyDetailLoss, probeRetrievability } from '../detail-loss.js';

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

describe('retrievability', () => {
  it('reports whether the shipped matcher would surface a probe from the tree', async () => {
    // The split that matters once a value is `retained`: memory has it, but did
    // retrieval hand it to the agent? Delegates to the SHIPPED
    // extractMatchedFacts rather than reimplementing line matching, so a change
    // to the tool's matching rule changes this answer too.
    const tree = new Map([
      [
        'docs/general/binaural-beats.md',
        '# Doc\n\n## Facts\n- The assistant listed 3 studies: Music and Medicine — 38 subjects.\n',
      ],
    ]);
    const { retrievable, matched } = await probeRetrievability(
      tree,
      'how many subjects were in the Music and Medicine study',
      ['38'],
    );
    expect(retrievable).toBe(true);
    expect(matched[0]?.fact).toContain('38 subjects');
    // WHICH doc holds it is the load-bearing part: on 993da5e2 the value sat in
    // `entity/living-room-decor` while the agent quoted the summary of
    // `general/living-room-decor` — same slug, different category, different
    // doc. Without the path that reads as one doc and the wrong conclusion.
    expect(matched[0]?.docId).toBe('docs/general/binaural-beats.md');
  });

  it('is false when the value sits in a doc no query token reaches', async () => {
    const tree = new Map([['docs/general/unrelated.md', '# Doc\n\n## Facts\n- Gardening notes: 38 tulips.\n']]);
    const { retrievable } = await probeRetrievability(tree, 'binaural beats study subjects', ['38']);
    expect(retrievable).toBe(false);
  });

  it('ignores lines that are not fact bullets, matching the shipped rule', async () => {
    // extractMatchedFacts only reads `- ` bullets; a value in frontmatter is not
    // retrievable through this path even though it is present in the file.
    const tree = new Map([['docs/general/x.md', 'summary: study of 38 subjects\n\n## Facts\n- unrelated line\n']]);
    const { retrievable } = await probeRetrievability(tree, 'study subjects', ['38']);
    expect(retrievable).toBe(false);
  });
});

describe('probe quality (defects found against live dumps)', () => {
  it('drops single-digit numeric probes, which match almost any line', () => {
    // Gold "0.5 hours" tokenized to ["0","5","hours"], and "0" matched an
    // unrelated productivity-apps note — scoring a question `retained` on a
    // digit. Derived answers like this are carried by their explicit needle
    // ("30-minute jog"), not by their digits.
    const t = contentTokens('0.5 hours');
    expect(t).not.toContain('0');
    expect(t).not.toContain('5');
    // Two-digit values are the ones under investigation and must survive.
    expect(contentTokens('38 subjects')).toContain('38');
    expect(contentTokens('approximately 20% improvement')).toContain('20');
    expect(contentTokens('2014.')).toContain('2014');
  });

  it('treats a JSON-quoted hash key as metadata too', () => {
    // The first filter only caught bare `hash: abc`. Part of the dumped tree is
    // JSON, where the same field reads `"hash": "c61f89d013899ecc",` — and "38"
    // matched exactly that before it matched the answering sentence.
    const v = classifyDetailLoss('38 subjects', {
      raw: 'a study of 38 subjects',
      extracted: 'study of 38 subjects',
      consolidated: '    "hash": "c61f89d013899ecc",',
    });
    expect(v.lostAt).toBe('consolidation');
  });
});

describe('numeric probes match whole numbers', () => {
  it('does not let "38" match inside "3389"', () => {
    // Substring matching made "38" land on a gaming-mouse spec ("Pixart 3389")
    // before the sentence that answers the question. A number is a value, not a
    // fragment, so it matches on word boundaries; words keep substring matching
    // because morphology matters there ("subject" in "subjects").
    const v = classifyDetailLoss('38 subjects', {
      raw: '38 subjects took part',
      extracted: '38 subjects took part',
      consolidated: '- mouse with a Pixart 3389 sensor',
    });
    expect(v.survivedConsolidation).not.toContain('38');
  });

  it('still matches the number when it stands alone', () => {
    const v = classifyDetailLoss('38 subjects', {
      raw: '38 subjects took part',
      extracted: '38 subjects took part',
      consolidated: '- Music and Medicine — 38 subjects, 30 minutes daily.',
    });
    expect(v.survivedConsolidation).toContain('38');
    expect(v.lostAt).toBe('retained');
  });
});

describe('partial loss — some required evidence survived and some did not', () => {
  it('does not call a question retained when one probe died on the way', () => {
    // gpt4_5438fa52 asks which came FIRST, a cultural festival or Spanish
    // classes. Gold is "Spanish classes", which memory keeps — so an
    // any-probe-survives rule scored it `retained` while "cultural festival"
    // was absent from the tree entirely. Answering needs BOTH events, so one
    // survivor is not a healthy pipeline.
    const v = classifyDetailLoss(
      'Spanish classes',
      {
        raw: 'I attended a cultural festival yesterday. I have been taking Spanish classes.',
        extracted: 'User has been taking Spanish classes.',
        consolidated: 'User has been taking Spanish classes since Feb 2023.',
      },
      { needles: ['cultural festival', 'Spanish class'] },
    );
    expect(v.lostAt).toBe('partial');
    expect(v.lostProbes).toEqual([{ probe: 'cultural festival', lostAt: 'extraction' }]);
    expect(v.survivedConsolidation).toContain('Spanish class');
  });

  it('still says retained when every probe present in the sessions survived', () => {
    const v = classifyDetailLoss(
      'Spanish classes',
      {
        raw: 'cultural festival yesterday; taking Spanish classes',
        extracted: 'cultural festival; Spanish classes',
        consolidated: 'cultural festival attended; Spanish classes since Feb',
      },
      { needles: ['cultural festival', 'Spanish class'] },
    );
    expect(v.lostAt).toBe('retained');
    expect(v.lostProbes).toEqual([]);
  });

  it('names the stage each lost probe died at', () => {
    const v = classifyDetailLoss(
      'x',
      { raw: 'alpha beta', extracted: 'alpha beta', consolidated: 'alpha' },
      { needles: ['alpha', 'beta'] },
    );
    expect(v.lostProbes).toEqual([{ probe: 'beta', lostAt: 'consolidation' }]);
  });
});
