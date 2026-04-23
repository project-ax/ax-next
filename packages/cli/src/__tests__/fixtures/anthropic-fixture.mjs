// Fake Anthropic client used by the real-LLM e2e test. The CLI subprocess
// dynamically imports this when AX_TEST_ANTHROPIC_FIXTURE points at it.
//
// Response script:
//   1. assistant emits a tool_use for bash (`echo fixture-hello`)
//   2. after the real sandbox runs bash and feeds output back into the chat
//      loop, assistant emits the final text.
let callIndex = 0;

const responses = [
  {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'fixture-model',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'bash',
        input: { command: 'echo fixture-hello' },
      },
    ],
  },
  {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'fixture-model',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{ type: 'text', text: 'ran bash, got the output', citations: null }],
  },
];

export default {
  messages: {
    async create() {
      const r = responses[callIndex];
      callIndex += 1;
      if (!r) throw new Error(`no fixture response for call ${callIndex}`);
      return r;
    },
  },
};
