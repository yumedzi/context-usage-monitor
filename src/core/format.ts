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
