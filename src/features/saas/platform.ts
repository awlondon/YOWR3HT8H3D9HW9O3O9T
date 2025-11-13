import { createMessagingService, MessagingService } from './messaging.js';
import { SubscriptionManager } from './subscription.js';
import {
  type CreditTierConfig,
  type PaymentRecipientConfig,
  SaasPlatformConfig,
  SubscriptionSummary,
  UserProfile,
} from './types.js';
import { formatCurrency, formatDate } from '../../utils/format.js';
import { createUserDirectory, UserDirectory } from './userDirectory.js';

const DEFAULT_CREDIT_TIERS: CreditTierConfig[] = [
  { id: 'starter', label: 'Starter · $10', amountUsd: 10 },
  { id: 'growth', label: 'Growth · $50', amountUsd: 50, bonusPercent: 5 },
  { id: 'scale', label: 'Scale · $100', amountUsd: 100, bonusPercent: 12 },
  { id: 'enterprise', label: 'Enterprise · $250', amountUsd: 250, bonusPercent: 18 },
];

const DEFAULT_PAYMENT_RECIPIENTS: PaymentRecipientConfig[] = [
  { handle: '@primarydesignco', label: 'Primary Design Cooperative', routingChannel: 'PayPal' },
  { handle: '@hlsf.research', label: 'HLSF Research Commons', routingChannel: 'Stripe Connect' },
];

const DEFAULT_CONFIG: SaasPlatformConfig = {
  productName: 'HLSF Cognition Engine SaaS',
  trialDays: 7,
  monthlyPriceUsd: 19.99,
  includedCreditsUsd: 10,
  creditTopUpOptionsUsd: DEFAULT_CREDIT_TIERS.map((tier) => tier.amountUsd),
  creditTiers: DEFAULT_CREDIT_TIERS,
  paymentRecipientHandle: DEFAULT_PAYMENT_RECIPIENTS[0].handle,
  paymentRecipients: DEFAULT_PAYMENT_RECIPIENTS,
  paymentProcessor: 'PayPal credit-card exchange',
};

export interface SaasPlatform {
  config: SaasPlatformConfig;
  subscriptions: SubscriptionManager;
  users: UserDirectory;
  messaging: MessagingService;
  describePayment(amountUsd: number): string;
  summarizeUser(userId: string): SubscriptionSummary;
}

export function initializeSaasPlatform(
  partialConfig: Partial<SaasPlatformConfig> = {},
): SaasPlatform {
  const creditTiers = partialConfig.creditTiers || DEFAULT_CONFIG.creditTiers;
  const paymentRecipients = partialConfig.paymentRecipients || DEFAULT_PAYMENT_RECIPIENTS;
  const creditTopUpOptions =
    partialConfig.creditTopUpOptionsUsd || creditTiers.map((tier) => tier.amountUsd);
  const defaultRecipientHandle =
    partialConfig.paymentRecipientHandle ||
    (paymentRecipients[0]?.handle ?? DEFAULT_CONFIG.paymentRecipientHandle);

  const mergedConfig: SaasPlatformConfig = {
    ...DEFAULT_CONFIG,
    ...partialConfig,
    creditTiers,
    paymentRecipients,
    creditTopUpOptionsUsd: creditTopUpOptions,
    paymentRecipientHandle: defaultRecipientHandle,
  };

  const subscriptions = new SubscriptionManager(mergedConfig);
  const users = createUserDirectory(subscriptions);
  const messaging = createMessagingService(users);
  const recipientLookup = new Map(
    mergedConfig.paymentRecipients.map((recipient) => [recipient.handle, recipient] as const),
  );

  function describePayment(amountUsd: number): string {
    const recipient =
      recipientLookup.get(mergedConfig.paymentRecipientHandle) || mergedConfig.paymentRecipients[0];
    const recipientLabel = recipient
      ? `${recipient.label} (${recipient.handle})`
      : mergedConfig.paymentRecipientHandle;
    const channel = recipient?.routingChannel || mergedConfig.paymentProcessor;
    return `Send ${formatCurrency(amountUsd)} to ${recipientLabel} via ${channel}.`;
  }

  function summarizeUser(userId: string): SubscriptionSummary {
    return subscriptions.getSubscriptionSummary(userId);
  }

  return {
    config: mergedConfig,
    subscriptions,
    users,
    messaging,
    describePayment,
    summarizeUser,
  };
}

export interface SaasCommandContext {
  registerCommand: (
    name: string,
    handler: (args: string[], rawInput?: string) => Promise<void> | void,
  ) => void;
  addLog: (html: string) => void;
  logError: (message: string) => void;
  logSuccess: (message: string) => void;
  sanitize: (value: string) => string;
  formatCurrency: (value: number) => string;
}

function formatSummaryHtml(
  summary: SubscriptionSummary,
  currencyFormatter: (value: number) => string,
): string {
  const formattedStatus = summary.status === 'trial' ? 'evaluation' : summary.status;
  const lines = [
    `<strong>Status:</strong> ${formattedStatus}`,
    `<strong>Next billing:</strong> ${formatDate(summary.nextBillingAt)}`,
    `<strong>Credits balance:</strong> ${currencyFormatter(summary.creditsBalanceUsd)}`,
    `<strong>Total purchased:</strong> ${currencyFormatter(summary.totalCreditsPurchasedUsd)}`,
  ];
  return `<div class="saas-summary">${lines.join('<br>')}</div>`;
}

function renderRegistrationPage(
  user: UserProfile,
  summary: SubscriptionSummary,
  platform: SaasPlatform,
  sanitize: (value: string) => string,
  currencyFormatter: (value: number) => string,
): string {
  const summaryHtml = formatSummaryHtml(summary, currencyFormatter);
  const sanitizedHandle = sanitize(user.handle);
  const sanitizedDisplayName = sanitize(user.displayName || user.handle);
  const productName = sanitize(platform.config.productName);
  const nextBilling = sanitize(formatDate(summary.nextBillingAt));
  const paymentRecipient =
    platform.config.paymentRecipients.find(
      (recipient) => recipient.handle === platform.config.paymentRecipientHandle,
    ) || platform.config.paymentRecipients[0];
  const recipientLabel = paymentRecipient
    ? `${paymentRecipient.label} (${paymentRecipient.handle})`
    : platform.config.paymentRecipientHandle;
  const paymentProcessor = sanitize(
    paymentRecipient?.routingChannel || platform.config.paymentProcessor,
  );
  const recipientHandle = sanitize(recipientLabel);
  const membershipStatus =
    summary.status === 'trial'
      ? 'Workspace access is currently in evaluation mode.'
      : `Next billing on ${nextBilling}.`;

  return `<div class="saas-registration">
    <h2 class="saas-registration__title">Welcome, ${sanitizedDisplayName} (@${sanitizedHandle})</h2>
    <p class="saas-registration__intro">
      Provision your hosted workspace for ${productName}. ${membershipStatus}
    </p>
    ${summaryHtml}
    <div class="saas-registration__methods">
      <section class="saas-registration__method">
        <h3>Connect PayPal</h3>
        <p>Link your PayPal account to authorize recurring billing to ${recipientHandle}.</p>
        <button type="button" class="saas-registration__button saas-registration__button--paypal" data-provider="paypal">
          Connect PayPal
        </button>
        <p class="saas-registration__note">You'll be redirected to PayPal to confirm the subscription.</p>
      </section>
      <section class="saas-registration__method">
        <h3>Secure billing link</h3>
        <form class="saas-registration__card-form" data-secure-billing="true">
          <p class="saas-registration__note saas-registration__note--warning">
            Direct card entry is disabled in this prototype. Request a PCI-compliant checkout link instead.
          </p>
          <div class="saas-registration__card-placeholder" role="status" aria-live="polite">
            Card numbers are never stored locally. We will send a one-time payment URL to complete onboarding through our processor.
          </div>
          <button type="submit" class="saas-registration__button saas-registration__button--primary">
            Request secure billing link
          </button>
        </form>
        <p class="saas-registration__note">Usage-based LLM API credits are reconciled after each cycle.</p>
      </section>
    </div>
    <p class="saas-registration__footnote">
      Billing is processed via ${paymentProcessor}. Funds are settled with ${recipientHandle}.
    </p>
  </div>`;
}

export function registerSaasCommands(platform: SaasPlatform, context: SaasCommandContext): void {
  const {
    registerCommand,
    addLog,
    logError,
    logSuccess,
    sanitize,
    formatCurrency: formatCurrencyFn,
  } = context;

  registerCommand('/signup', async (args: string[]) => {
    const [handle, ...rest] = args;
    if (!handle) {
      logError('Usage: /signup <handle> [display name]');
      return;
    }
    try {
      const displayName = rest.join(' ');
      const user = await platform.users.createUser(handle, displayName);
      const summary = platform.summarizeUser(user.id);
      const registrationHtml = renderRegistrationPage(
        user,
        summary,
        platform,
        sanitize,
        formatCurrencyFn,
      );
      addLog(registrationHtml);
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
    }
  });

  registerCommand('/switchuser', async (args: string[]) => {
    const [identifier] = args;
    if (!identifier) {
      logError('Usage: /switchuser <handle>');
      return;
    }
    try {
      const user = platform.users.setActiveUser(identifier);
      logSuccess(`Active user set to @${user.handle}.`);
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
    }
  });

  registerCommand('/plan', async () => {
    const active = platform.users.getActiveUser();
    if (!active) {
      logError('Create a profile with /signup to view plan details.');
      return;
    }
    const summary = platform.summarizeUser(active.id);
    addLog(
      `<div class="saas-plan">${formatSummaryHtml(summary, formatCurrencyFn)}<br>` +
        `Monthly subscription: ${formatCurrencyFn(platform.config.monthlyPriceUsd)} billed through ${sanitize(platform.config.paymentProcessor)}.` +
        `<br>Included API credits: ${formatCurrencyFn(platform.config.includedCreditsUsd)}.</div>`,
    );
  });

  registerCommand('/topup', async (args: string[]) => {
    const active = platform.users.getActiveUser();
    if (!active) {
      logError('No active user. Use /signup to create a profile.');
      return;
    }
    const [amountRaw] = args;
    const amount = Number.parseFloat(amountRaw || '');
    if (!Number.isFinite(amount)) {
      const options = platform.config.creditTiers.length
        ? platform.config.creditTiers
            .map((tier) => `${tier.label} (${formatCurrencyFn(tier.amountUsd)})`)
            .join(', ')
        : platform.config.creditTopUpOptionsUsd.map((value) => formatCurrencyFn(value)).join(', ');
      logError(`Specify a valid amount. Options: ${options}.`);
      return;
    }
    try {
      const entry = platform.subscriptions.addCreditTopUp(active.id, amount, 'Self-serve top-up');
      const tier = platform.config.creditTiers.find((t) => t.amountUsd === amount);
      const tierLabel = tier ? sanitize(tier.label) : formatCurrencyFn(amount);
      addLog(
        `<div class="saas-topup">Added ${formatCurrencyFn(amount)} in API credits.<br>` +
          `Balance: ${formatCurrencyFn(entry.balanceAfterCreditsUsd)}.<br>` +
          `Tier: ${tierLabel}.<br>` +
          `${sanitize(platform.describePayment(amount))}</div>`,
      );
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
    }
  });

  registerCommand('/userlist', async () => {
    const users = platform.users.listUsers();
    if (!users.length) {
      addLog('No user profiles registered yet. Use /signup to create one.');
      return;
    }
    const now = Date.now();
    const items = users.map((user) => {
      const summary = platform.subscriptions.getSubscriptionSummary(user.id, now);
      return (
        `<li><strong>${sanitize(user.displayName)}</strong> (@${sanitize(user.handle)}) – ` +
        `${summary.status} · credits ${formatCurrencyFn(summary.creditsBalanceUsd)}</li>`
      );
    });
    addLog(
      `<div class="saas-users"><strong>Registered users</strong><ul>${items.join('')}</ul></div>`,
    );
  });

  registerCommand('/message', async (args: string[]) => {
    const active = platform.users.getActiveUser();
    if (!active) {
      logError('No active user. Use /signup to create a profile.');
      return;
    }
    const [recipient, ...contentParts] = args;
    if (!recipient || contentParts.length === 0) {
      logError('Usage: /message <recipient> <message>');
      return;
    }
    const content = contentParts.join(' ');
    try {
      const preview = await platform.messaging.sendMessage(active.id, recipient, content);
      addLog(
        `<div class="saas-message">Encrypted message sent to @${sanitize(preview.recipientHandle)}.` +
          `<br>Ciphertext preview: ${sanitize(preview.ciphertext)}</div>`,
      );
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
    }
  });

  registerCommand('/inbox', async () => {
    const active = platform.users.getActiveUser();
    if (!active) {
      logError('No active user. Use /signup to create a profile.');
      return;
    }
    const messages = platform.messaging.listEncryptedMessages(active.id);
    if (!messages.length) {
      addLog('Inbox empty.');
      return;
    }
    const rows = messages.map(
      (msg) =>
        `#${sanitize(msg.id)} from @${sanitize(msg.senderHandle)} · ${new Date(msg.createdAt).toLocaleString()} · ${sanitize(msg.ciphertext)}`,
    );
    addLog(
      `<div class="saas-inbox"><strong>Encrypted messages</strong><br>${rows.join('<br>')}</div>`,
    );
  });

  registerCommand('/decryptmsg', async (args: string[]) => {
    const active = platform.users.getActiveUser();
    if (!active) {
      logError('No active user. Use /signup to create a profile.');
      return;
    }
    const [messageId] = args;
    if (!messageId) {
      logError('Usage: /decryptmsg <messageId>');
      return;
    }
    try {
      const plain = await platform.messaging.decryptMessage(active.id, messageId);
      addLog(`<div class="saas-decrypt">🔓 ${sanitize(plain)}</div>`);
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
    }
  });
}
