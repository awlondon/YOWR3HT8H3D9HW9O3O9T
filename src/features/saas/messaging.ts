import {
  decryptString,
  encryptString,
  base64Preview,
  generateSymmetricKey,
} from '../../lib/crypto/encryption.js';
import { UserDirectory } from './userDirectory.js';
import { MessageEnvelope, MessagingPreview } from './types.js';
import { assertHandle, generateId } from './utils.js';

export interface MessagingService {
  sendMessage(
    senderId: string,
    recipientHandle: string,
    plainText: string,
  ): Promise<MessagingPreview>;
  listEncryptedMessages(userId: string): MessagingPreview[];
  decryptMessage(userId: string, messageId: string): Promise<string>;
  rotateEncryptionKey(userId: string, newKey?: string): Promise<string>;
}

export function createMessagingService(directory: UserDirectory): MessagingService {
  const inbox = new Map<string, MessageEnvelope[]>();

  function pushMessage(userId: string, envelope: MessageEnvelope) {
    const existing = inbox.get(userId);
    if (existing) {
      existing.push(envelope);
    } else {
      inbox.set(userId, [envelope]);
    }
  }

  function toPreview(envelope: MessageEnvelope): MessagingPreview {
    const sender = directory.getUserById(envelope.senderId);
    const recipient = directory.getUserById(envelope.recipientId);
    return {
      ...envelope,
      senderHandle: sender?.handle ?? 'unknown',
      recipientHandle: recipient?.handle ?? 'unknown',
    };
  }

  async function sendMessage(
    senderId: string,
    recipientHandle: string,
    plainText: string,
  ): Promise<MessagingPreview> {
    const sender = directory.getUserById(senderId);
    if (!sender) {
      throw new Error('Active user not found.');
    }
    const normalizedRecipient = assertHandle(recipientHandle);
    const recipient = directory.getUserByHandle(normalizedRecipient);
    if (!recipient) {
      throw new Error(`Recipient @${normalizedRecipient} not found.`);
    }
    if (!plainText || !plainText.trim()) {
      throw new Error('Message content cannot be empty.');
    }

    const messageId = generateId('msg');
    const createdAt = Date.now();

    const encryptedForRecipient = await encryptString(plainText, recipient.encryptionKey);
    const encryptedForSender = await encryptString(plainText, sender.encryptionKey);

    const recipientEnvelope: MessageEnvelope = {
      id: messageId,
      senderId: sender.id,
      recipientId: recipient.id,
      createdAt,
      ciphertext: encryptedForRecipient.ciphertext,
      iv: encryptedForRecipient.iv,
    };

    const senderEnvelope: MessageEnvelope = {
      id: messageId,
      senderId: sender.id,
      recipientId: recipient.id,
      createdAt,
      ciphertext: encryptedForSender.ciphertext,
      iv: encryptedForSender.iv,
    };

    pushMessage(recipient.id, recipientEnvelope);
    pushMessage(sender.id, senderEnvelope);

    return toPreview(recipientEnvelope);
  }

  function listEncryptedMessages(userId: string): MessagingPreview[] {
    const messages = inbox.get(userId) || [];
    return messages
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toPreview)
      .map((message) => ({
        ...message,
        ciphertext: base64Preview(message.ciphertext, 16),
      }));
  }

  async function decryptMessage(userId: string, messageId: string): Promise<string> {
    const user = directory.getUserById(userId);
    if (!user) {
      throw new Error('User not found.');
    }
    const messages = inbox.get(userId) || [];
    const target = messages.find((msg) => msg.id === messageId);
    if (!target) {
      throw new Error('Message not found in inbox.');
    }
    return decryptString(target.ciphertext, target.iv, user.encryptionKey);
  }

  async function rotateEncryptionKey(userId: string, newKey?: string): Promise<string> {
    const user = directory.getUserById(userId);
    if (!user) {
      throw new Error('User not found.');
    }
    const freshKey = newKey || (await generateSymmetricKey());
    const messages = inbox.get(userId) || [];

    for (const envelope of messages) {
      const plainText = await decryptString(envelope.ciphertext, envelope.iv, user.encryptionKey);
      const reencrypted = await encryptString(plainText, freshKey);
      envelope.ciphertext = reencrypted.ciphertext;
      envelope.iv = reencrypted.iv;
    }

    directory.updateEncryptionKey(userId, freshKey);
    return freshKey;
  }

  return {
    sendMessage,
    listEncryptedMessages,
    decryptMessage,
    rotateEncryptionKey,
  };
}
