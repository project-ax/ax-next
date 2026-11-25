const REPLACEMENTS = {};
const add = (tags, text) => {
  for (const t of tags.split('|')) REPLACEMENTS[t] = text;
};
add('div|section|article|header|footer|main|aside|nav', 'Stack / Inline / Section / AppShell');
add('span|p', 'Text');
add('h1|h2|h3|h4|h5|h6', 'PageHeader / Section / Heading');
add('ul|ol|li', 'List / ListRow');
add('button', 'Button / IconButton');
add('input|textarea|select|label', 'TextField / TextArea / Select');
add('table|thead|tbody|tr|td|th', 'DataTable');

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw layout/text/form elements in app UI code.' },
    // `elements` narrows the check to the tags whose replacements have
    // shipped (the list widens per area in S3–S6; see the roadmap). Omitted =
    // every tag below.
    schema: [
      {
        type: 'object',
        properties: {
          elements: { type: 'array', items: { enum: Object.keys(REPLACEMENTS) }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noRawElement: 'Raw <{{tag}}> is not allowed in app UI. Use {{replacement}} from @project-ax/ui.',
    },
  },
  create(context) {
    const only = context.options[0]?.elements;
    const checked = new Set(only ?? Object.keys(REPLACEMENTS));
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const tag = node.name.name;
        if (!checked.has(tag)) return;
        context.report({ node, messageId: 'noRawElement', data: { tag, replacement: REPLACEMENTS[tag] } });
      },
    };
  },
};
