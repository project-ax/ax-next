import { afterEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { startServiceForwards, type ServiceForwards } from '../service-forwards.js';

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function echoServer(): Promise<{ port: number; server: net.Server }> {
  const server = net.createServer((c) => c.on('data', (d) => c.write(Buffer.concat([Buffer.from('echo:'), d]))));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, server };
}

function roundTrip(port: number, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect({ host: '127.0.0.1', port }, () => c.write(msg));
    c.once('data', (d) => { c.destroy(); resolve(d.toString()); });
    c.once('error', reject);
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.restoreAllMocks();
});

describe('startServiceForwards', () => {
  it('bytes flow published → target', async () => {
    const { port: target, server } = await echoServer();
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const published = await freePort();
    const fwd = await startServiceForwards([{ published, target }]);
    cleanups.push(() => fwd.close());
    expect(await roundTrip(published, 'hi')).toBe('echo:hi');
  });

  it('listens on 127.0.0.1 only', async () => {
    const listen = vi.fn();
    const fakeNet = {
      createServer: () => {
        const srv = Object.assign(new EventEmitter(), {
          listen: (opts: unknown, cb: () => void) => { listen(opts); cb(); },
          close: (cb: () => void) => cb(),
        });
        return srv;
      },
      connect: vi.fn(),
    } as unknown as typeof net;
    await startServiceForwards([{ published: 47017, target: 27017 }], { net: fakeNet });
    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 47017 });
  });

  it('connects upstream to 127.0.0.1 only', async () => {
    const connect = vi.fn(() => new net.Socket());
    const real = net;
    const spyNet = { ...real, connect } as unknown as typeof net;
    const published = await freePort();
    const fwd = await startServiceForwards([{ published, target: 1 }], { net: spyNet });
    cleanups.push(() => fwd.close());
    const c = net.connect({ host: '127.0.0.1', port: published });
    c.on('error', () => {});
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    expect(connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 1 });
    c.destroy();
  });

  it('a taken port is skipped with a log line', async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => taken.close(() => r())));
    const takenPort = (taken.address() as net.AddressInfo).port;
    const { port: target, server } = await echoServer();
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const ok = await freePort();
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const fwd = await startServiceForwards([{ published: takenPort, target }, { published: ok, target }]);
    cleanups.push(() => fwd.close());
    expect(write.mock.calls.some(([m]) => String(m).includes(`127.0.0.1:${takenPort}`) && String(m).includes('skipped'))).toBe(true);
    expect(await roundTrip(ok, 'x')).toBe('echo:x');
  });

  it('close releases the ports', async () => {
    const { port: target, server } = await echoServer();
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const published = await freePort();
    const fwd: ServiceForwards = await startServiceForwards([{ published, target }]);
    const held = net.connect({ host: '127.0.0.1', port: published });
    held.on('error', () => {});
    await new Promise<void>((r) => held.once('connect', () => r()));
    await fwd.close();
    await new Promise<void>((r) => (held.destroyed ? r() : held.once('close', () => r())));
    // the port can be bound again
    const again = net.createServer();
    await new Promise<void>((r, j) => { again.once('error', j); again.listen(published, '127.0.0.1', r); });
    await new Promise<void>((r) => again.close(() => r()));
  });

  it('destroys the client when the upstream is refused (no half-open socket)', async () => {
    const published = await freePort();
    const dead = await freePort(); // nothing listens here
    const fwd = await startServiceForwards([{ published, target: dead }]);
    cleanups.push(() => fwd.close());
    const closed = new Promise<void>((resolve) => {
      const c = net.connect({ host: '127.0.0.1', port: published });
      c.on('error', () => {});
      c.once('close', () => resolve());
    });
    await closed;
  });
});
