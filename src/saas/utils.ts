export function generateId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  return `${prefix}_${random}`;
}

export function normalizeHandle(raw: string): string {
  return (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^-+|-+$/g, '');
}

export function assertHandle(value: string): string {
  const normalized = normalizeHandle(value);
  if (!normalized) {
    throw new Error('A valid handle is required.');
  }
  return normalized;
}

export function formatCurrency(amountUsd: number): string {
  if (!Number.isFinite(amountUsd)) {
    return '$0.00';
  }
  const sign = amountUsd < 0 ? '-' : '';
  const abs = Math.abs(amountUsd);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${sign}$${abs.toFixed(decimals)}`;
}

export function formatDate(value: number): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}
