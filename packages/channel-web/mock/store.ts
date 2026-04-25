import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { defaultSeeds } from './seed';

export interface Collection<T extends { id: string }> {
  list(): T[];
  get(id: string): T | undefined;
  upsert(row: T): void;
  remove(id: string): void;
}

export class Store {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  collection<T extends { id: string }>(name: string): Collection<T> {
    const file = join(this.dir, `${name}.json`);

    const read = (): T[] => {
      if (!existsSync(file)) return [];
      const raw = readFileSync(file, 'utf8');
      return JSON.parse(raw) as T[];
    };

    const write = (rows: T[]): void => {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(rows, null, 2));
      renameSync(tmp, file);
    };

    return {
      list: () => read(),
      get: (id: string) => read().find((r) => r.id === id),
      upsert: (row: T) => {
        const rows = read();
        const i = rows.findIndex((r) => r.id === row.id);
        if (i >= 0) rows[i] = row;
        else rows.push(row);
        write(rows);
      },
      remove: (id: string) => {
        const rows = read().filter((r) => r.id !== id);
        write(rows);
      },
    };
  }

  seed(): void {
    for (const [name, rows] of Object.entries(defaultSeeds)) {
      const file = join(this.dir, `${name}.json`);
      if (existsSync(file)) continue;
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(rows, null, 2));
      renameSync(tmp, file);
    }
  }
}
