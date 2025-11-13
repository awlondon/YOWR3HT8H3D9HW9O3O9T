import test from 'node:test';
// Lightweight assertions avoid depending on DOM lib typings for Node modules.
import { createMessagingService } from './messaging.js';
import { createUserDirectory } from './userDirectory.js';
import { SubscriptionManager } from './subscription.js';
import { decryptString } from '../../lib/crypto/encryption.js';
import type { SaasPlatformConfig } from './types.js';

const TEST_CONFIG: SaasPlatformConfig = {
  productName: 'Test SaaS',
  trialDays: 7,
  monthlyPriceUsd: 9.99,
  includedCreditsUsd: 5,
  creditTopUpOptionsUsd: [5, 10, 25],
  creditTiers: [
    { id: 'starter', label: 'Starter', amountUsd: 5 },
    { id: 'growth', label: 'Growth', amountUsd: 10 },
  ],
  paymentRecipientHandle: '@testsuite',
  paymentRecipients: [{ handle: '@testsuite', label: 'Test Suite Cooperative' }],
  paymentProcessor: 'TestPay',
};

test('rotating encryption keys re-encrypts inbox messages', async () => {
  const subscriptions = new SubscriptionManager(TEST_CONFIG);
  const users = createUserDirectory(subscriptions);
  const messaging = createMessagingService(users);

  const alice = await users.createUser('alice');
  const bob = await users.createUser('bob');

  await messaging.sendMessage(alice.id, 'bob', 'hello world');
  const beforeRotation = messaging.listEncryptedMessages(bob.id);
  if (beforeRotation.length !== 1) {
    throw new Error('expected message to be stored for recipient');
  }
  const originalEnvelope = beforeRotation[0];
  const oldKey = bob.encryptionKey;

  const rotatedKey = await messaging.rotateEncryptionKey(bob.id);
  if (rotatedKey === oldKey) {
    throw new Error('encryption key should rotate');
  }

  // Attempting to decrypt with the previous key should fail.
  let rejected = false;
  try {
    await decryptString(originalEnvelope.ciphertext, originalEnvelope.iv, oldKey);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error('legacy key should not decrypt rotated message');
  }

  const plaintext = await messaging.decryptMessage(bob.id, originalEnvelope.id);
  if (plaintext !== 'hello world') {
    throw new Error('rotated message should decrypt with new key');
  }
});
