import path from 'node:path';

// Radix and @project-ax/ui internals: banned regardless of `uiModules`.
const ALWAYS_PATTERNS = [
  /^@radix-ui\//,
  /^radix-ui(\/|$)/,
  /^@project-ax\/ui\/(internal|src)(\/|$)/,
];
const UI_DIR_ALIAS = /^@\/components\/ui(\/|$)/;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: "Disallow importing UI internals (Radix, shadcn ui/, @project-ax/ui internals)." },
    // `uiModules`: when present, only `components/ui/<name>` imports whose
    // name is listed are banned (Radix + @project-ax/ui internals always are).
    // Absent = every components/ui module.
    schema: [
      {
        type: 'object',
        properties: { uiModules: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: { noInternalImport: 'Import from @project-ax/ui.' },
  },
  create(context) {
    const filename = toPosix(context.filename ?? '');

    const uiModules = context.options[0]?.uiModules;

    /** Does a components/ui import of module `name` ('' = the dir itself) count? */
    function uiModuleBanned(name) {
      return uiModules === undefined || uiModules.includes(name);
    }

    function uiModuleOf(path_) {
      const m = /(?:^|\/)components\/ui(?:\/([^/]+))?(?:\/|$)/.exec(path_);
      if (!m) return undefined;
      return (m[1] ?? '').replace(/\.[cm]?[jt]sx?$/, '');
    }

    function isBanned(src) {
      if (ALWAYS_PATTERNS.some((re) => re.test(src))) return true;
      if (UI_DIR_ALIAS.test(src)) return uiModuleBanned(uiModuleOf(src.slice(2)) ?? '');
      if (!src.startsWith('.')) return false;
      let name = uiModuleOf(src);
      if (name === undefined && (filename.startsWith('/') || filename.includes('/'))) {
        name = uiModuleOf(path.posix.join(path.posix.dirname(filename), src) + '/');
      }
      return name !== undefined && uiModuleBanned(name);
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
