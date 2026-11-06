import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import net from 'node:net';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Logger } from '@ax/core';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createSessionPostgresPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// TASK-1061: TCP keepalive on the pool connection and the LISTEN client.
//
// pg never calls net.Socket#setKeepAlive by default, so a peer that vanishes
// without closing the connection (a node dies, a NAT forgets the mapping) is
// never noticed on a quiet socket. The spy records the remote port AT CALL
// TIME: pg calls setKeepAlive on 'connect', and Node computes remotePort on
// demand, so it reads undefined once the socket has closed. Only calls to the
// test container count; other sockets in the process may call setKeepAlive too.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close({ onError: () => {} });
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('TCP keepalive', () => {
  it('is on for the pool connection and the LISTEN client, first probe after 10 s', async () => {
    const seen: Array<[number | undefined, boolean, number | undefined]> = [];
    const original = net.Socket.prototype.setKeepAlive;
    const spy = vi
      .spyOn(net.Socket.prototype, 'setKeepAlive')
      .mockImplementation(function (this: net.Socket, ...args: Parameters<typeof original>) {
        seen.push([this.remotePort, Boolean(args[0]), args[1]]);
        return original.apply(this, args);
      });
    try {
      // Boot alone opens both: the migration's pool connection and the LISTEN
      // client (TASK-1056 measured exactly these two).
      const h = await createTestHarness({
        plugins: [createSessionPostgresPlugin({ connectionString, logger })],
      });
      harnesses.push(h);
    } finally {
      spy.mockRestore();
    }
    const calls = seen
      .filter(([remotePort]) => remotePort === container.getPort())
      .map(([, enable, delay]) => [enable, delay]);
    expect(calls).toStrictEqual([
      [true, 10_000],
      [true, 10_000],
    ]);
  });
});
