import path from 'node:path';

const ALIAS_PATTERNS = [
  /^@radix-ui\//,
  /^@\/components\/ui(\/|$)/,
  /^@project-ax\/ui\/(internal|src)(\/|$)/,
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: "Disallow importing UI internals (Radix, shadcn ui/, @project-ax/ui internals)." },
    schema: [],
    messages: { noInternalImport: 'Import from @project-ax/ui.' },
  },
  create(context) {
    const filename = toPosix(context.filename ?? '');
    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        if (typeof src !== 'string') return;
        let bad = ALIAS_PATTERNS.some((re) => re.test(src));
        if (!bad && src.startsWith('.')) {
          if (src.includes('/components/ui/') || /(^|\/)components\/ui(\/|$)/.test(src)) {
            bad = true;
          } else if (filename.startsWith('/') || filename.includes('/')) {
            const resolved = path.posix.join(path.posix.dirname(filename), src);
            bad = (resolved + '/').includes('/components/ui/');
          }
        }
        if (bad) context.report({ node: node.source, messageId: 'noInternalImport' });
      },
    };
  },
};
