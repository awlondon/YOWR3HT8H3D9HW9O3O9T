import { LedgerEntry, LedgerEntryKind, SaasPlatformConfig, SubscriptionRecord, SubscriptionStatus, SubscriptionSummary } from './types';
import { generateId } from './utils';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30 * MS_PER_DAY;

function cloneLedgerEntry(entry: LedgerEntry): LedgerEntry {
  return { ...entry };
}

export class SubscriptionManager {
  private readonly config: SaasPlatformConfig;
  private readonly subscriptions = new Map<string, SubscriptionRecord>();

  constructor(config: SaasPlatformConfig) {
    this.config = config;
  }

  initializeSubscriptionForUser(userId: string, createdAt = Date.now()): SubscriptionRecord {
    const existing = this.subscriptions.get(userId);
    if (existing) {
      return existing;
    }

    const trialEndsAt = createdAt + this.config.trialDays * MS_PER_DAY;
    const ledger: LedgerEntry[] = [];
    const record: SubscriptionRecord = {
      userId,
      status: 'trial',
      trialEndsAt,
      nextBillingAt: trialEndsAt,
      creditsBalanceUsd: this.config.includedCreditsUsd,
      totalCreditsPurchasedUsd: 0,
      ledger,
    };

    ledger.push(this.createLedgerEntry(userId, 'trial-start', 0, 0, record.creditsBalanceUsd, `Trial ends ${new Date(trialEndsAt).toISOString()}`));
    if (this.config.includedCreditsUsd > 0) {
      ledger.push(
        this.createLedgerEntry(
          userId,
          'credit-grant',
          0,
          this.config.includedCreditsUsd,
          record.creditsBalanceUsd,
          'Included LLM API credits'
        )
      );
    }

    this.subscriptions.set(userId, record);
    return record;
  }

  private createLedgerEntry(
    userId: string,
    kind: LedgerEntryKind,
    amountUsd: number,
    creditsDeltaUsd: number,
    balanceAfterCreditsUsd: number,
    note?: string
  ): LedgerEntry {
    return {
      id: generateId('led'),
      userId,
      kind,
      amountUsd,
      creditsDeltaUsd,
      balanceAfterCreditsUsd,
      timestamp: Date.now(),
      note,
    };
  }

  private requireRecord(userId: string): SubscriptionRecord {
    const record = this.subscriptions.get(userId);
    if (!record) {
      throw new Error('Subscription not found for user.');
    }
    return record;
  }

  activatePaidSubscription(userId: string, activatedAt = Date.now()): SubscriptionRecord {
    const record = this.requireRecord(userId);
    record.status = 'active';
    record.nextBillingAt = activatedAt + MS_PER_MONTH;
    this.recordSubscriptionCharge(record, activatedAt);
    return record;
  }

  private recordSubscriptionCharge(record: SubscriptionRecord, chargedAt = Date.now()): void {
    record.creditsBalanceUsd += this.config.includedCreditsUsd;
    const entry = this.createLedgerEntry(
      record.userId,
      'subscription-charge',
      -this.config.monthlyPriceUsd,
      this.config.includedCreditsUsd,
      record.creditsBalanceUsd,
      `Monthly subscription charge on ${new Date(chargedAt).toISOString()}`
    );
    record.ledger.push(entry);
  }

  addCreditTopUp(userId: string, amountUsd: number, note?: string): LedgerEntry {
    const record = this.requireRecord(userId);
    if (!this.config.creditTopUpOptionsUsd.includes(amountUsd)) {
      throw new Error(`Unsupported credit top-up amount: ${amountUsd}`);
    }
    record.creditsBalanceUsd += amountUsd;
    record.totalCreditsPurchasedUsd += amountUsd;
    const entry = this.createLedgerEntry(
      userId,
      'credit-topup',
      -amountUsd,
      amountUsd,
      record.creditsBalanceUsd,
      note || 'Manual credit top-up'
    );
    record.ledger.push(entry);
    return entry;
  }

  recordCreditUsage(userId: string, amountUsd: number, note?: string): LedgerEntry {
    const record = this.requireRecord(userId);
    if (amountUsd <= 0) {
      throw new Error('Usage amount must be positive.');
    }
    if (record.creditsBalanceUsd < amountUsd) {
      throw new Error('Insufficient API credits.');
    }
    record.creditsBalanceUsd -= amountUsd;
    const entry = this.createLedgerEntry(
      userId,
      'credit-usage',
      0,
      -amountUsd,
      record.creditsBalanceUsd,
      note || 'LLM API usage'
    );
    record.ledger.push(entry);
    return entry;
  }

  getLedgerForUser(userId: string): LedgerEntry[] {
    const record = this.requireRecord(userId);
    return record.ledger.map(cloneLedgerEntry);
  }

  getSubscriptionSummary(userId: string, now = Date.now()): SubscriptionSummary {
    const record = this.requireRecord(userId);
    let status: SubscriptionStatus = record.status;
    if (status === 'trial' && now > record.trialEndsAt) {
      status = 'expired';
    }
    const trialDaysRemaining = status === 'trial' ? Math.max(0, Math.ceil((record.trialEndsAt - now) / MS_PER_DAY)) : 0;
    return {
      userId,
      status,
      trialEndsAt: record.trialEndsAt,
      trialDaysRemaining,
      nextBillingAt: record.nextBillingAt,
      creditsBalanceUsd: record.creditsBalanceUsd,
      totalCreditsPurchasedUsd: record.totalCreditsPurchasedUsd,
    };
  }

  listSummaries(now = Date.now()): SubscriptionSummary[] {
    return Array.from(this.subscriptions.keys()).map(userId => this.getSubscriptionSummary(userId, now));
  }

  getPlanConfig(): SaasPlatformConfig {
    return { ...this.config, creditTopUpOptionsUsd: [...this.config.creditTopUpOptionsUsd] };
  }
}
