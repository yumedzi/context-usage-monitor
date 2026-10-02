export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(cost: number, known: boolean, currencySymbol: string): string {
  if (!known) return `${currencySymbol}?`;
  if (cost >= 1) return `${currencySymbol}${cost.toFixed(2)}`;
  if (cost >= 0.001) return `${currencySymbol}${cost.toFixed(3)}`;
  return `${currencySymbol}${cost.toFixed(4)}`;
}

/**
 * Like formatCost, but when `partial` the figure is a lower bound (some turns
 * could not be priced), rendered "≥ $X".
 */
export function formatCostPartial(cost: number, known: boolean, partial: boolean, currencySymbol: string): string {
  const base = formatCost(cost, known, currencySymbol);
  return known && partial ? `≥ ${base}` : base;
}

export interface BreakdownInput {
  totalCostUSD: number;
  perModel: Record<string, number>;
  unknownModels: Record<string, { records: number; tokens: number }>;
}

/** Plain-text lines for the per-model month-to-date breakdown (used by the usage report and Copy Diagnostics). */
export function monthlyBreakdownLines(info: BreakdownInput, currencySymbol: string): string[] {
  const lines: string[] = [];
  const models = Object.entries(info.perModel).sort((a, b) => b[1] - a[1]);
  for (const [id, cost] of models) {
    lines.push(`- ${id}: ${formatCost(cost, true, currencySymbol)}`);
  }
  const unknown = Object.entries(info.unknownModels).sort((a, b) => b[1].records - a[1].records);
  for (const [id, stats] of unknown) {
    lines.push(`- ${id}: UNPRICED — ${stats.records} turns, ${formatTokens(stats.tokens)} tokens (not in total)`);
  }
  return lines;
}
