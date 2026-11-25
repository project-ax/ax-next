import path from 'node:path';

const ALIAS_PATTERNS = [
  /^@radix-ui\//,
  /^radix-ui(\/|$)/,
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

    function isBanned(src) {
      if (ALIAS_PATTERNS.some((re) => re.test(src))) return true;
      if (!src.startsWith('.')) return false;
      if (src.includes('/components/ui/') || /(^|\/)components\/ui(\/|$)/.test(src)) return true;
      if (filename.startsWith('/') || filename.includes('/')) {
        const resolved = path.posix.join(path.posix.dirname(filename), src);
        return (resolved + '/').includes('/components/ui/');
      }
      return false;
    }

    /** Report `sourceNode` if it is a static module specifier naming a banned path. */
    function check(sourceNode) {
      if (!sourceNode) return;
      let src;
      if (sourceNode.type === 'Literal' && typeof sourceNode.value === 'string') {
        src = sourceNode.value;
      } else if (sourceNode.type === 'TemplateLiteral' && sourceNode.expressions.length === 0) {
        src = sourceNode.quasis[0]?.value.cooked;
      }
      if (typeof src === 'string' && isBanned(src)) {
        context.report({ node: sourceNode, messageId: 'noInternalImport' });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      // Re-exports: `export { X } from '…'`, `export * from '…'`, `export * as N from '…'`.
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      // `import('…')` with a static specifier.
      ImportExpression: (node) => check(node.source),
    };
  },
};
