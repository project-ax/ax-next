import { describe, expect, it } from 'vitest';
import { createSharedPostgres, type SharedPostgresContainer } from '../shared-postgres.js';

/** A stand-in server: records every exec and stop, answers like psql would. */
function fakeServer(opts: { execExit?: number } = {}) {
  const execs: string[][] = [];
  let stops = 0;
  const container: SharedPostgresContainer = {
    getConnectionUri: () => 'postgres://test:secret@127.0.0.1:55432/test',
    getUsername: () => 'test',
    getDatabase: () => 'test',
    exec: async (command) => {
      execs.push(command);
      return { exitCode: opts.execExit ?? 0, output: opts.execExit ? 'ERROR: boom' : 'CREATE DATABASE' };
    },
    stop: async () => {
      stops += 1;
    },
  };
  return { container, execs, stops: () => stops };
}

describe('createSharedPostgres', () => {
  it('starts nothing until a database is asked for', async () => {
    let starts = 0;
    const pg = createSharedPostgres(async () => {
      starts += 1;
      return fakeServer().container;
    });
    await pg.stop();
    expect(starts).toBe(0);
  });

  it('starts the server once, even for concurrent first callers, and hands each a fresh database', async () => {
    const server = fakeServer();
    let starts = 0;
    const pg = createSharedPostgres(async () => {
      starts += 1;
      return server.container;
    });

    const uris = await Promise.all([pg.database(), pg.database(), pg.database()]);

    expect(starts).toBe(1);
    const names = uris.map((u) => new URL(u).pathname.slice(1));
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^t_[0-9a-f]{16}$/);
    // Same server, same credentials; only the database differs.
    for (const u of uris) {
      const url = new URL(u);
      expect(`${url.protocol}//${url.username}:${url.password}@${url.host}`).toBe('postgres://test:secret@127.0.0.1:55432');
    }
    expect(server.execs.map((c) => c[c.length - 1])).toEqual(names.map((n) => `CREATE DATABASE ${n}`));
    // argv, never a shell string: psql is the program, the SQL one argument.
    expect(server.execs[0]?.[0]).toBe('psql');
  });

  it('a failed CREATE DATABASE is an error, not a connection string to a database that does not exist', async () => {
    const pg = createSharedPostgres(async () => fakeServer({ execExit: 1 }).container);
    await expect(pg.database()).rejects.toThrow(/CREATE DATABASE failed \(exit 1\): ERROR: boom/);
  });

  it('a failed start is not cached: the next call tries again', async () => {
    const server = fakeServer();
    let starts = 0;
    const pg = createSharedPostgres(async () => {
      starts += 1;
      if (starts === 1) throw new Error('docker hiccup');
      return server.container;
    });

    await expect(pg.database()).rejects.toThrow('docker hiccup');
    await expect(pg.database()).resolves.toMatch(/\/t_[0-9a-f]{16}$/);
    expect(starts).toBe(2);
  });

  it('stop stops the server once, however often it is called, and refuses databases afterwards', async () => {
    const server = fakeServer();
    const pg = createSharedPostgres(async () => server.container);
    await pg.database();

    await pg.stop();
    await pg.stop();

    expect(server.stops()).toBe(1);
    await expect(pg.database()).rejects.toThrow(/after stop/);
  });
});
