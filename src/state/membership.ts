export const MEMBERSHIP_LEVELS = {
  DEMO: 'demo',
  MEMBER: 'member',
} as const;

export type MembershipLevel = typeof MEMBERSHIP_LEVELS[keyof typeof MEMBERSHIP_LEVELS];
