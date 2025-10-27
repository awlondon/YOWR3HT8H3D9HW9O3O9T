export type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'cancelled';

export type LedgerEntryKind =
  | 'trial-start'
  | 'credit-grant'
  | 'subscription-charge'
  | 'credit-topup'
  | 'credit-usage';

export interface SubscriptionPlanConfig {
  trialDays: number;
  monthlyPriceUsd: number;
  includedCreditsUsd: number;
  creditTopUpOptionsUsd: number[];
  paymentRecipientHandle: string;
  paymentProcessor: string;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  kind: LedgerEntryKind;
  amountUsd: number;
  creditsDeltaUsd: number;
  balanceAfterCreditsUsd: number;
  timestamp: number;
  note?: string;
}

export interface SubscriptionRecord {
  userId: string;
  status: SubscriptionStatus;
  trialEndsAt: number;
  nextBillingAt: number;
  creditsBalanceUsd: number;
  totalCreditsPurchasedUsd: number;
  ledger: LedgerEntry[];
}

export interface SubscriptionSummary {
  userId: string;
  status: SubscriptionStatus;
  trialEndsAt: number;
  trialDaysRemaining: number;
  nextBillingAt: number;
  creditsBalanceUsd: number;
  totalCreditsPurchasedUsd: number;
}

export interface UserProfile {
  id: string;
  handle: string;
  displayName: string;
  email?: string;
  createdAt: number;
  encryptionKey: string;
}

export interface MessageEnvelope {
  id: string;
  senderId: string;
  recipientId: string;
  createdAt: number;
  ciphertext: string;
  iv: string;
}

export interface MessagingPreview extends MessageEnvelope {
  senderHandle: string;
  recipientHandle: string;
}

export interface PaymentDescriptor {
  provider: string;
  recipientHandle: string;
  exchangeService: string;
}

export interface SaasPlatformConfig extends SubscriptionPlanConfig {
  productName: string;
}
