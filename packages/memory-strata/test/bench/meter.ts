export interface PriceEntry { in: number; out: number; } // dollars per token
export type Pricing = Record<string, PriceEntry>;

export interface ModelUsage { in: number; out: number; }   // tokens

export interface MeterOptions {
  capDollars: number;
  pricing: Pricing;
}

export interface ModelSnapshot { tokensIn: number; tokensOut: number; dollars: number; }

export class CostMeter {
  private totals = new Map<string, ModelSnapshot>();

  constructor(private readonly opts: MeterOptions) {}

  record(model: string, usage: ModelUsage): void {
    const price = this.opts.pricing[model];
    if (!price) throw new Error(`No pricing entry for model: ${model}`);
    const current = this.totals.get(model) ?? { tokensIn: 0, tokensOut: 0, dollars: 0 };
    current.tokensIn += usage.in;
    current.tokensOut += usage.out;
    current.dollars += usage.in * price.in + usage.out * price.out;
    this.totals.set(model, current);
  }

  totalDollars(): number {
    let sum = 0;
    for (const m of this.totals.values()) sum += m.dollars;
    return sum;
  }

  projectWouldExceedCap(model: string, projected: ModelUsage): boolean {
    const price = this.opts.pricing[model];
    if (!price) throw new Error(`No pricing entry for model: ${model}`);
    const projectedDollars = projected.in * price.in + projected.out * price.out;
    return this.totalDollars() + projectedDollars > this.opts.capDollars;
  }

  snapshot(): Record<string, ModelSnapshot> {
    return Object.fromEntries(this.totals);
  }
}
