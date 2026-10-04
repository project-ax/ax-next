export { createMcpClientPlugin, type CreateMcpClientPluginOptions } from './plugin.js';
// Tool catalog plugin — absorbed from @ax/tool-dispatcher (Slice 2). Owns
// tool:register / tool:list services and per-agent scoping.
export { createToolDispatcherPlugin } from './tool-dispatcher-plugin.js';
