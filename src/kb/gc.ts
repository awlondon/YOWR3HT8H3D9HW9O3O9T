export type GcPolicy = {
  lambdaPerDay: number;
  wMin: number;
  ageMaxDays: number;
  wOldMin: number;
};

export function shouldTrim(weight: number, lastSeen: number, nowMs: number, policy: GcPolicy): boolean {
  const ageMs = Math.max(0, nowMs - (lastSeen * 1000));
  const ageDays = ageMs / 86_400_000;
  const effective = weight * Math.exp(-policy.lambdaPerDay * ageDays);
  return effective < policy.wMin || (ageDays > policy.ageMaxDays && weight < policy.wOldMin);
}
