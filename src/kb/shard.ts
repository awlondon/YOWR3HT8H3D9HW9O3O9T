export const BLOCK_MAX = 50_000;

export function shardPartsForDegree(degree: number): number {
  return Math.max(1, Math.ceil(Math.max(0, degree) / BLOCK_MAX));
}

export function hashPrefix(id: number, nibbles = 3): string {
  return (id >>> 0).toString(16).padStart(8, '0').slice(0, nibbles);
}
