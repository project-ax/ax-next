export interface NeighborScore {
  entity: string;
  weight: number;
}

export interface NeighborhoodOptions {
  hops?: number;
  decay?: number;
}

export interface Neighborhood {
  seeds: string[];
  neighbors: Map<string, number>;
}

export class CoOccurrenceGraph {
  private readonly adjacency = new Map<string, Map<string, number>>();

  coOccur(entities: string[]): void {
    const unique = [...new Set(entities.map((entity) => entity.trim()).filter(Boolean))];
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const a = unique[i];
        const b = unique[j];
        if (a === undefined || b === undefined || a === b) continue;
        this.increment(a, b);
        this.increment(b, a);
      }
    }
  }

  private increment(from: string, to: string): void {
    let edges = this.adjacency.get(from);
    if (!edges) {
      edges = new Map<string, number>();
      this.adjacency.set(from, edges);
    }
    edges.set(to, (edges.get(to) ?? 0) + 1);
  }

  nodes(): string[] {
    return [...this.adjacency.keys()];
  }

  directNeighbors(entity: string): NeighborScore[] {
    const edges = this.adjacency.get(entity);
    if (!edges) return [];
    return [...edges.entries()]
      .map(([neighbor, weight]) => ({ entity: neighbor, weight }))
      .sort((a, b) => b.weight - a.weight || a.entity.localeCompare(b.entity));
  }

  neighborhood(seeds: string[], options: NeighborhoodOptions = {}): Neighborhood {
    const hops = options.hops ?? 2;
    const decay = options.decay ?? 0.5;
    const seedSet = new Set(seeds);
    const scores = new Map<string, number>();
    let frontier = new Map<string, number>(seeds.map((seed) => [seed, 1]));

    for (let hop = 1; hop <= hops; hop += 1) {
      const next = new Map<string, number>();
      for (const [entity, weight] of frontier) {
        const edges = this.adjacency.get(entity);
        if (!edges) continue;
        for (const [neighbor, edgeWeight] of edges) {
          if (seedSet.has(neighbor)) continue;
          const pathWeight = weight * edgeWeight * (hop === 1 ? 1 : decay);
          next.set(neighbor, (next.get(neighbor) ?? 0) + pathWeight);
        }
      }
      for (const [entity, weight] of next) {
        scores.set(entity, Math.max(scores.get(entity) ?? 0, weight));
      }
      frontier = next;
    }

    return { seeds: [...seedSet], neighbors: scores };
  }

  clear(): void {
    this.adjacency.clear();
  }

  edgeCount(): number {
    let count = 0;
    for (const edges of this.adjacency.values()) count += edges.size;
    return count / 2;
  }
}

export function matchEntities(query: string, knownEntities: Iterable<string>): string[] {
  const normalized = query.toLowerCase();
  const tokens = new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? []);
  const matched: string[] = [];
  for (const entity of knownEntities) {
    const parts = entity.split("_").filter(Boolean);
    const entityMatch =
      tokens.has(entity) ||
      normalized.includes(entity.replace(/_/g, " ")) ||
      (parts.length > 0 && parts.every((part) => tokens.has(part)));
    if (entityMatch) matched.push(entity);
  }
  return matched.sort((a, b) => a.localeCompare(b));
}
