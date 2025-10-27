import { decryptString, encryptString, base64Preview } from './encryption';
import { UserDirectory } from './userDirectory';
import { MessageEnvelope, MessagingPreview } from './types';
import { assertHandle, generateId } from './utils';

export interface MessagingService {
  sendMessage(senderId: string, recipientHandle: string, plainText: string): Promise<MessagingPreview>;
  listEncryptedMessages(userId: string): MessagingPreview[];
  decryptMessage(userId: string, messageId: string): Promise<string>;
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

  async function sendMessage(senderId: string, recipientHandle: string, plainText: string): Promise<MessagingPreview> {
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
      .map(message => ({
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
    const target = messages.find(msg => msg.id === messageId);
    if (!target) {
      throw new Error('Message not found in inbox.');
    }
    return decryptString(target.ciphertext, target.iv, user.encryptionKey);
  }

  return {
    sendMessage,
    listEncryptedMessages,
    decryptMessage,
  };
}
