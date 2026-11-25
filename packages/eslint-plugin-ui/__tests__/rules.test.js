import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import plugin from '../index.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const languageOptions = {
  ecmaVersion: 2022,
  sourceType: 'module',
  parserOptions: { ecmaFeatures: { jsx: true } },
};
const tsLanguageOptions = {
  parser: tseslint.parser,
  parserOptions: { ecmaFeatures: { jsx: true } },
};
const tester = new RuleTester({ languageOptions });

describe('plugin shape', () => {
  it('exports meta name and all five rules', () => {
    const names = Object.keys(plugin.rules).sort();
    if (plugin.meta.name !== '@project-ax/eslint-plugin-ui') throw new Error('bad name');
    if (names.join() !== 'no-arbitrary-values,no-classname,no-internal-imports,no-raw-elements,no-style-prop') {
      throw new Error(`unexpected rules: ${names}`);
    }
  });
});

tester.run('no-classname', plugin.rules['no-classname'], {
  valid: [
    { code: 'const a = <Stack gap="md" />;' },
    { code: 'const a = <Stack gap="md" />;', languageOptions: tsLanguageOptions, filename: 'a.tsx' },
  ],
  invalid: [
    { code: 'const a = <Stack className="x" />;', errors: [{ messageId: 'noClassname' }] },
    { code: 'const a = <div class="x" />;', errors: [{ messageId: 'noClassname' }] },
    {
      code: 'const a = <Stack className={x} />;',
      languageOptions: tsLanguageOptions,
      filename: 'a.tsx',
      errors: [{ messageId: 'noClassname' }],
    },
  ],
});

const INTRINSIC = [{ intrinsicOnly: true }];
tester.run('no-classname (intrinsicOnly)', plugin.rules['no-classname'], {
  valid: [
    { code: 'const a = <Button className="x" />;', options: INTRINSIC },
    { code: 'const a = <Foo.Bar className="x" />;', options: INTRINSIC },
    { code: 'const a = <foo.bar className="x" />;', options: INTRINSIC },
    { code: 'const a = <Card class="x" />;', options: INTRINSIC },
    { code: 'const a = <Button className={x} />;', options: INTRINSIC, languageOptions: tsLanguageOptions, filename: 'a.tsx' },
  ],
  invalid: [
    { code: 'const a = <div className="x" />;', options: INTRINSIC, errors: [{ messageId: 'noClassname' }] },
    { code: 'const a = <span class="x" />;', options: INTRINSIC, errors: [{ messageId: 'noClassname' }] },
    { code: 'const a = <button className="x" />;', options: INTRINSIC, errors: [{ messageId: 'noClassname' }] },
    { code: 'const a = <Stack className="x" />;', options: [{ intrinsicOnly: false }], errors: [{ messageId: 'noClassname' }] },
    {
      code: 'const a = <p className={x}>hi</p>;',
      options: INTRINSIC,
      languageOptions: tsLanguageOptions,
      filename: 'a.tsx',
      errors: [{ messageId: 'noClassname' }],
    },
  ],
});

tester.run('no-style-prop', plugin.rules['no-style-prop'], {
  valid: [{ code: 'const a = <Stack gap="md" />;' }],
  invalid: [
    { code: 'const a = <Stack style={{ color: "red" }} />;', errors: [{ messageId: 'noStyleProp' }] },
    {
      code: 'const a = <Stack style={s} />;',
      languageOptions: tsLanguageOptions,
      filename: 'a.tsx',
      errors: [{ messageId: 'noStyleProp' }],
    },
  ],
});

tester.run('no-raw-elements', plugin.rules['no-raw-elements'], {
  valid: [
    { code: 'const a = <svg />;' },
    { code: 'const a = <Stack />;' },
    { code: 'const a = <a href="/x" />;' },
    { code: 'const a = <img src="x" />;' },
    { code: 'const a = <form />;' },
    { code: 'const a = <Foo.div />;' },
    { code: 'const a = <svg />;', languageOptions: tsLanguageOptions, filename: 'a.tsx' },
  ],
  invalid: [
    { code: 'const a = <div />;', errors: [{ message: /Stack/ }] },
    { code: 'const a = <p>hi</p>;', errors: [{ message: /Text/ }] },
    { code: 'const a = <h2>hi</h2>;', errors: [{ message: /Section/ }] },
    { code: 'const a = <button />;', errors: [{ message: /IconButton/ }] },
    { code: 'const a = <input />;', errors: [{ message: /TextField/ }] },
    { code: 'const a = <li />;', errors: [{ message: /ListRow/ }] },
    { code: 'const a = <td />;', errors: [{ message: /DataTable/ }] },
    {
      code: 'const a = <div>x</div>;',
      languageOptions: tsLanguageOptions,
      filename: 'a.tsx',
      errors: [{ message: /Stack/ }],
    },
  ],
});

const NARROW = [{ elements: ['div', 'span', 'p', 'h2', 'h3', 'h4', 'h5', 'h6'] }];
tester.run('no-raw-elements (elements option)', plugin.rules['no-raw-elements'], {
  valid: [
    { code: 'const a = <button />;', options: NARROW },
    { code: 'const a = <input />;', options: NARROW },
    { code: 'const a = <ul><li /></ul>;', options: NARROW },
    { code: 'const a = <section />;', options: NARROW },
    { code: 'const a = <h1>t</h1>;', options: NARROW },
    { code: 'const a = <table />;', options: NARROW, languageOptions: tsLanguageOptions, filename: 'a.tsx' },
  ],
  invalid: [
    { code: 'const a = <div />;', options: NARROW, errors: [{ message: /Stack/ }] },
    { code: 'const a = <span />;', options: NARROW, errors: [{ message: /Text/ }] },
    { code: 'const a = <h4>t</h4>;', options: NARROW, errors: [{ message: /Heading/ }] },
    { code: 'const a = <button />;', options: [{ elements: ['button'] }], errors: [{ message: /IconButton/ }] },
    {
      code: 'const a = <p>x</p>;',
      options: NARROW,
      languageOptions: tsLanguageOptions,
      filename: 'a.tsx',
      errors: [{ message: /Text/ }],
    },
  ],
});

tester.run('no-arbitrary-values', plugin.rules['no-arbitrary-values'], {
  valid: [
    { code: 'const a = <X className="text-sm" />;' },
    { code: 'const a = <X aria-label="[draft]" />;' },
    { code: 'const a = <X title="w-[3px]" />;' },
    { code: "const a = cn('text-sm', cond && 'p-2');" },
    { code: "const a = other('max-w-[660px]');" },
    { code: "const a = cn(variant === 'tab[0]' && 'p-2');" },
    { code: 'const a = <X className="text-sm" />;', languageOptions: tsLanguageOptions, filename: 'a.tsx' },
  ],
  invalid: [
    { code: 'const a = <X className="text-[13px] text-sm" />;', errors: [{ messageId: 'noArbitrary' }] },
    { code: 'const a = <X class="w-[3px]" />;', errors: [{ messageId: 'noArbitrary' }] },
    { code: 'const a = <X className={`gap-[3px] ${x}`} />;', errors: [{ messageId: 'noArbitrary' }] },
    { code: "const a = cn('max-w-[660px]');", errors: [{ messageId: 'noArbitrary' }] },
    { code: "const a = cn('a ' + 'b-[1px]');", errors: [{ messageId: 'noArbitrary' }] },
    { code: "const a = clsx(['p-2', ok ? 'h-[2px]' : 'h-2']);", errors: [{ messageId: 'noArbitrary' }] },
    { code: "const a = cva('base', { variants: { a: { b: 'w-[1px]' } } });", errors: [{ messageId: 'noArbitrary' }] },
    {
      code: "const a = <X className={ok && 'top-[1px]'} />;",
      languageOptions: tsLanguageOptions,
      filename: 'a.tsx',
      errors: [{ messageId: 'noArbitrary' }],
    },
  ],
});

tester.run('no-internal-imports', plugin.rules['no-internal-imports'], {
  valid: [
    { code: "import { Stack } from '@project-ax/ui';" },
    { code: "import { x } from '@ax/core';" },
    { code: "import { y } from './y';", filename: '/r/packages/channel-web/src/components/workspace/X.tsx' },
    { code: "import { y } from '../lib/y';", filename: '/r/packages/channel-web/src/components/workspace/X.tsx' },
    { code: "import { y } from '../uix/y';", filename: '/r/packages/channel-web/src/components/workspace/X.tsx' },
    { code: "import { Stack } from '@project-ax/ui';", languageOptions: tsLanguageOptions, filename: 'a.tsx' },
    { code: "export { Stack } from '@project-ax/ui';" },
    { code: "export * from '@project-ax/ui';" },
    { code: 'export const x = 1;' },
    { code: 'const x = 1;\nexport { x };' },
    { code: "const m = import('@project-ax/ui');" },
    { code: 'const m = import(name);' },
    { code: "import x from 'radix-uix';" },
    { code: "import x from 'not-radix-ui';" },
  ],
  invalid: [
    { code: "import * as D from '@radix-ui/react-dialog';", errors: [{ messageId: 'noInternalImport' }] },
    { code: "import { Dialog } from 'radix-ui';", errors: [{ messageId: 'noInternalImport' }] },
    { code: "import { Dialog } from 'radix-ui/internal';", errors: [{ messageId: 'noInternalImport' }] },
    { code: "export { Button } from '@/components/ui/button';", errors: [{ messageId: 'noInternalImport' }] },
    { code: "export * from '@radix-ui/react-dialog';", errors: [{ messageId: 'noInternalImport' }] },
    { code: "export * as D from 'radix-ui';", errors: [{ messageId: 'noInternalImport' }] },
    {
      code: "export { Button } from '../ui/button';",
      filename: '/r/packages/channel-web/src/components/workspace/X.tsx',
      errors: [{ messageId: 'noInternalImport' }],
    },
    {
      code: "export type { ButtonProps } from '@/components/ui/button';",
      languageOptions: tsLanguageOptions,
      filename: 'a.tsx',
      errors: [{ messageId: 'noInternalImport' }],
    },
    { code: "const m = import('@/components/ui/dialog');", errors: [{ messageId: 'noInternalImport' }] },
    { code: 'const m = import(`@radix-ui/react-dialog`);', errors: [{ messageId: 'noInternalImport' }] },
    {
      code: "const m = import('../ui/dialog');",
      filename: '/r/packages/channel-web/src/components/workspace/X.tsx',
      errors: [{ messageId: 'noInternalImport' }],
    },
    { code: "import { Button } from '@/components/ui/button';", errors: [{ messageId: 'noInternalImport' }] },
    { code: "import { Button } from '@/components/ui';", errors: [{ messageId: 'noInternalImport' }] },
    { code: "import x from '@project-ax/ui/internal/x';", errors: [{ messageId: 'noInternalImport' }] },
    { code: "import x from '@project-ax/ui/src/x';", errors: [{ messageId: 'noInternalImport' }] },
    {
      code: "import { Button } from '../ui/button';",
      filename: '/r/packages/channel-web/src/components/workspace/X.tsx',
      errors: [{ messageId: 'noInternalImport' }],
    },
    {
      code: "import { Button } from '../../components/ui/button';",
      filename: '/r/packages/channel-web/src/pages/X.tsx',
      errors: [{ messageId: 'noInternalImport' }],
    },
    {
      code: "import { Button } from '../ui/button';",
      languageOptions: tsLanguageOptions,
      filename: '/r/packages/channel-web/src/components/workspace/X.tsx',
      errors: [{ messageId: 'noInternalImport' }],
    },
  ],
});

const REPLACED = [{ uiModules: ['alert'] }];
const REL_FILE = '/r/packages/channel-web/src/components/workspace/X.tsx';
tester.run('no-internal-imports (uiModules)', plugin.rules['no-internal-imports'], {
  valid: [
    { code: "import { Button } from '@/components/ui/button';", options: REPLACED },
    { code: "import { Button } from '../ui/button';", options: REPLACED, filename: REL_FILE },
    { code: "import { Alert } from '@project-ax/ui';", options: REPLACED },
  ],
  invalid: [
    { code: "import { Alert } from '@/components/ui/alert';", options: REPLACED, errors: [{ messageId: 'noInternalImport' }] },
    { code: "import { Alert } from '../ui/alert';", options: REPLACED, filename: REL_FILE, errors: [{ messageId: 'noInternalImport' }] },
    { code: "import * as D from '@radix-ui/react-dialog';", options: REPLACED, errors: [{ messageId: 'noInternalImport' }] },
    { code: "import x from '@project-ax/ui/internal/x';", options: REPLACED, errors: [{ messageId: 'noInternalImport' }] },
  ],
});

describe('no-internal-imports schema', () => {
  const verify = (options) =>
    new Linter().verify(
      'const a = 1;',
      { plugins: { ui: plugin }, rules: { 'ui/no-internal-imports': ['error', ...options] } },
      'a.js',
    );
  it('rejects non-string uiModules entries', () => {
    expect(() => verify([{ uiModules: [1] }])).toThrow(/should be string/);
  });
  it('accepts a string list', () => {
    expect(verify([{ uiModules: ['alert'] }])).toEqual([]);
  });
});
