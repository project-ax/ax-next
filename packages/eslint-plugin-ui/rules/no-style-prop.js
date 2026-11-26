/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow the style prop on JSX elements in app UI code.' },
    schema: [],
    messages: {
      noStyleProp:
        'Inline styles bypass the design tokens. Use a token-backed prop on a @project-ax/ui component (space, size, tone) instead.',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'style') {
          // `<Timestamp style="clock">` is the package's own enum prop (relative | clock), not CSS.
          const el = node.parent?.name;
          if (el?.type === 'JSXIdentifier' && el.name === 'Timestamp' && node.value?.type === 'Literal') return;
          context.report({ node, messageId: 'noStyleProp' });
        }
      },
    };
  },
};
