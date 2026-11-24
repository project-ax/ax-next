const CLASS_HELPERS = new Set(['cn', 'clsx', 'cva']);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow Tailwind arbitrary values (`text-[13px]`) in class strings.' },
    schema: [],
    messages: {
      noArbitrary: 'Arbitrary values bypass the tokens. Use a token (space, text role, width). Found "{{token}}".',
    },
  },
  create(context) {
    function checkString(node, text) {
      const token = text.split(/\s+/).find((t) => t.includes('['));
      if (token) context.report({ node, messageId: 'noArbitrary', data: { token } });
    }

    // Walk an expression, checking string literals / template quasis nested in
    // arrays, conditionals, logical/binary expressions and template literals.
    function visit(node) {
      if (!node) return;
      switch (node.type) {
        case 'Literal':
          if (typeof node.value === 'string') checkString(node, node.value);
          break;
        case 'TemplateLiteral':
          for (const q of node.quasis) checkString(q, q.value.cooked ?? q.value.raw);
          for (const e of node.expressions) visit(e);
          break;
        case 'ArrayExpression':
          node.elements.forEach(visit);
          break;
        case 'ConditionalExpression':
          visit(node.consequent);
          visit(node.alternate);
          break;
        case 'LogicalExpression':
        case 'BinaryExpression':
          visit(node.left);
          visit(node.right);
          break;
        case 'JSXExpressionContainer':
          visit(node.expression);
          break;
        case 'ObjectExpression':
          for (const p of node.properties) {
            if (p.type === 'Property') {
              if (!p.computed) visit(p.key);
              visit(p.value);
            }
          }
          break;
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
        case 'TSNonNullExpression':
          visit(node.expression);
          break;
        default:
          break;
      }
    }

    return {
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        if (node.name.name !== 'className' && node.name.name !== 'class') return;
        visit(node.value);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || !CLASS_HELPERS.has(node.callee.name)) return;
        node.arguments.forEach((a) => visit(a.type === 'SpreadElement' ? a.argument : a));
      },
    };
  },
};
