// WCAG 2.x contrast for bare HSL triplets ("220.00 42.86% 98.63%").

function parse(triplet: string): [number, number, number] {
  const m = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(triplet.trim());
  if (!m) throw new Error(`not an HSL triplet: ${triplet}`);
  return [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
}

function luminance(triplet: string): number {
  const [h, s, l] = parse(triplet);
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}

export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
