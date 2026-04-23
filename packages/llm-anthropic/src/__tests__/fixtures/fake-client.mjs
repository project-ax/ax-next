// Test-only fake client used by plugin.test.ts to exercise the
// AX_TEST_ANTHROPIC_FIXTURE env backdoor.
export default {
  messages: {
    async create() {
      return {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'fake-model',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: 'text', text: 'fixture-reply', citations: null }],
      };
    },
  },
};
