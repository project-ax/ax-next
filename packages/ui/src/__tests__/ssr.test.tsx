import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Divider, Grid, Heading, Inline, Stack, Text } from '../index.js';
import type { SpaceToken } from '../index.js';

const gaps: SpaceToken[] = ['none', 'xs', 'sm', 'md', 'lg', 'xl', 'section'];

describe('SSR', () => {
  it('no component emits inline style', () => {
    const out: string[] = [];
    for (const gap of gaps) {
      for (const align of ['start', 'center', 'end', 'stretch'] as const) out.push(renderToString(<Stack gap={gap} align={align}>x</Stack>));
      for (const align of ['start', 'center', 'end', 'baseline'] as const)
        for (const justify of ['start', 'between', 'end'] as const)
          out.push(renderToString(<Inline gap={gap} align={align} justify={justify} wrap>x</Inline>));
      for (const c of [1, 2, 3, 4, 5, 6, 7] as const) out.push(renderToString(<Grid columns={c} gap={gap}>x</Grid>));
    }
    out.push(renderToString(<Grid columns={{ base: 1, md: 2, lg: 3 }}>x</Grid>));
    out.push(renderToString(<Divider />), renderToString(<Divider orientation="vertical" />));
    for (const role of ['body', 'body-strong', 'meta', 'caption', 'code'] as const)
      out.push(renderToString(<Text role={role}>x</Text>), renderToString(<Text role={role} inline truncate>x</Text>));
    for (const role of ['display', 'title', 'heading', 'subheading'] as const) out.push(renderToString(<Heading role={role}>x</Heading>));
    out.push(renderToString(<Heading>x</Heading>));
    expect(out.length).toBeGreaterThan(50);
    for (const html of out) expect(html).not.toContain('style=');
  });
});
