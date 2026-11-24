/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow className/class on JSX elements in app UI code.' },
    schema: [],
    messages: {
      noClassname:
        "Pages don't style elements. Use a component from @project-ax/ui (Stack, Inline, Text, …) or a composite in src/composites/.",
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && (node.name.name === 'className' || node.name.name === 'class')) {
          context.report({ node, messageId: 'noClassname' });
        }
      },
    };
  },
};
