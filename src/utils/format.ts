/** Utility formatting helpers shared across features. */
export function formatCurrency(amountUsd: number): string {
  if (!Number.isFinite(amountUsd)) {
    return '$0.00';
  }
  const sign = amountUsd < 0 ? '-' : '';
  const abs = Math.abs(amountUsd);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${sign}$${abs.toFixed(decimals)}`;
}

export function formatDate(timestamp: number): string {
  if (!timestamp) return 'n/a';
  return new Date(timestamp).toLocaleString();
}
