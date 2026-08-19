// Process-startup hook for the Claude SDK subprocess.
//
// The runner-side bridge (proxy-startup.ts) calls setGlobalDispatcher in
// the runner's own Node process, but the Anthropic claude-agent-sdk
// spawns a separate subprocess (cli.js) for the actual model
// interaction. That subprocess has its own undici globalDispatcher; the
// parent's setGlobalDispatcher is invisible to it.
//
// We close that gap by stamping NODE_OPTIONS=--require=<thisFile> on the
// subprocess env. Node loads this file before any user code, we set the
// proxy dispatcher from HTTPS_PROXY (which the parent already injected
// into the env), and the SDK's outbound fetch then routes through the
// bridge → unix socket → host credential-proxy → upstream. Without this,
// the subprocess sends the `ax-cred:<hex>` placeholder straight to
// api.anthropic.com and Anthropic returns "Invalid API key".
//
// CommonJS deliberately: NODE_OPTIONS=--require expects a synchronous
// CJS module; --import (ESM) is also supported but only on Node 20.6+
// AND requires URL form (more fiddly for a portable bootstrap).
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
  } catch (err) {
    // Subprocess will end up bypassing the proxy. Surface to stderr so
    // the runner can correlate via its own stderr capture.
    process.stderr.write(
      `[ax-proxy-bootstrap] failed to install ProxyAgent: ${err && err.message}\n`,
    );
  }
}
