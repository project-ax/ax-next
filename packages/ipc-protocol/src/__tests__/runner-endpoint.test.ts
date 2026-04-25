import { describe, it, expect } from 'vitest';
import {
  parseRunnerEndpoint,
  RunnerEndpointError,
  type TransportTarget,
} from '../runner-endpoint.js';

describe('parseRunnerEndpoint', () => {
  it('parses unix:///abs/path as a unix target', () => {
    const t: TransportTarget = parseRunnerEndpoint('unix:///tmp/ipc.sock');
    expect(t).toEqual({ kind: 'unix', socketPath: '/tmp/ipc.sock' });
  });

  it('rejects unix:// without an absolute path', () => {
    expect(() => parseRunnerEndpoint('unix://relative/path'))
      .toThrow(RunnerEndpointError);
  });

  it('parses http://host:port as an http target', () => {
    const t: TransportTarget = parseRunnerEndpoint('http://host.example:8080');
    expect(t).toEqual({ kind: 'http', host: 'host.example', port: 8080 });
  });

  it('parses cluster Service DNS shape', () => {
    const t: TransportTarget = parseRunnerEndpoint(
      'http://ax-next-host.ax-next.svc.cluster.local:80',
    );
    expect(t).toEqual({
      kind: 'http',
      host: 'ax-next-host.ax-next.svc.cluster.local',
      port: 80,
    });
  });

  it('rejects http:// with no host', () => {
    expect(() => parseRunnerEndpoint('http://:8080')).toThrow(RunnerEndpointError);
  });

  it('rejects http:// with no port (we never default — be loud)', () => {
    expect(() => parseRunnerEndpoint('http://host.example'))
      .toThrow(RunnerEndpointError);
  });

  it('rejects http:// with a path component (the URI carries the authority only)', () => {
    expect(() => parseRunnerEndpoint('http://host.example:80/extra'))
      .toThrow(RunnerEndpointError);
  });

  it('rejects unsupported schemes', () => {
    expect(() => parseRunnerEndpoint('vsock://1:2')).toThrow(RunnerEndpointError);
  });

  it('rejects malformed URIs', () => {
    expect(() => parseRunnerEndpoint('not-a-uri')).toThrow(RunnerEndpointError);
  });
});
