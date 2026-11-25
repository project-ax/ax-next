// @project-ax/eslint-plugin-ui — plain ESM, no build step, so eslint.config.mjs
// can import it before `tsc` has run. Rules are used as `ax-ui/<rule>`.
import noClassname from './rules/no-classname.js';
import noStyleProp from './rules/no-style-prop.js';
import noRawElements from './rules/no-raw-elements.js';
import noArbitraryValues from './rules/no-arbitrary-values.js';
import noInternalImports from './rules/no-internal-imports.js';

export default {
  meta: { name: '@project-ax/eslint-plugin-ui' },
  rules: {
    'no-classname': noClassname,
    'no-style-prop': noStyleProp,
    'no-raw-elements': noRawElements,
    'no-arbitrary-values': noArbitraryValues,
    'no-internal-imports': noInternalImports,
  },
};
