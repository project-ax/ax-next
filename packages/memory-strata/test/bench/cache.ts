import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_ROOT = join(homedir(), '.cache', 'ax-memory-bench');

export class BenchCache {
  constructor(private readonly root: string = DEFAULT_ROOT) {
    mkdirSync(root, { recursive: true });
  }

  async getPath(dataset: string, file: string): Promise<string> {
    return join(this.root, dataset, file);
  }

  async readIfHit(dataset: string, file: string): Promise<Buffer | null> {
    const path = await this.getPath(dataset, file);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  async write(dataset: string, file: string, payload: Buffer): Promise<void> {
    const path = await this.getPath(dataset, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, payload);
  }

  async purge(dataset: string): Promise<void> {
    rmSync(join(this.root, dataset), { recursive: true, force: true });
  }
}
