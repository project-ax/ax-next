/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow className/class on JSX elements in app UI code.' },
    // `intrinsicOnly: true` reports className/class on lowercase intrinsic
    // elements (<div>, <button>) only, not on components (<Button>) or member
    // expressions (<Foo.Bar>). Component className is allowed until that
    // area's replacements ship (S3–S6; see the roadmap).
    schema: [
      {
        type: 'object',
        properties: { intrinsicOnly: { type: 'boolean' } },
        additionalProperties: false,
      },
    ],
    messages: {
      noClassname:
        "Pages don't style elements. Use a component from @project-ax/ui (Stack, Inline, Text, …) or a composite in src/composites/.",
    },
  },
  create(context) {
    const intrinsicOnly = context.options[0]?.intrinsicOnly === true;
    return {
      JSXAttribute(node) {
        if (intrinsicOnly) {
          const el = node.parent?.name;
          if (el?.type !== 'JSXIdentifier' || !/^[a-z]/.test(el.name)) return;
        }
        if (node.name.type === 'JSXIdentifier' && (node.name.name === 'className' || node.name.name === 'class')) {
          context.report({ node, messageId: 'noClassname' });
        }
      },
    };
  },
};
