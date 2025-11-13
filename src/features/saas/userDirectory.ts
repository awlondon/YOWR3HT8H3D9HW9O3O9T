import { generateSymmetricKey } from '../../lib/crypto/encryption.js';
import { SubscriptionManager } from './subscription.js';
import { UserProfile } from './types.js';
import { assertHandle, generateId } from './utils.js';

export interface UserDirectory {
  createUser(handle: string, displayName?: string, email?: string): Promise<UserProfile>;
  listUsers(): UserProfile[];
  getUserByHandle(handle: string): UserProfile | null;
  getUserById(id: string): UserProfile | null;
  getActiveUser(): UserProfile | null;
  getActiveUserId(): string | null;
  setActiveUser(identifier: string): UserProfile;
  updateEncryptionKey(userId: string, newKey: string): void;
}

export function createUserDirectory(subscriptions: SubscriptionManager): UserDirectory {
  const usersByHandle = new Map<string, UserProfile>();
  const usersById = new Map<string, UserProfile>();
  let activeUserId: string | null = null;

  function resolveDisplayName(handle: string, displayName?: string): string {
    const trimmed = (displayName || '').trim();
    if (trimmed) return trimmed;
    return handle;
  }

  function selectActiveUser(user: UserProfile) {
    if (!activeUserId) {
      activeUserId = user.id;
    }
  }

  function getUserByHandle(handle: string): UserProfile | null {
    const normalized = assertHandle(handle);
    return usersByHandle.get(normalized) || null;
  }

  function getUserById(id: string): UserProfile | null {
    return usersById.get(id) || null;
  }

  async function createUser(
    handle: string,
    displayName?: string,
    email?: string,
  ): Promise<UserProfile> {
    const normalized = assertHandle(handle);
    if (usersByHandle.has(normalized)) {
      throw new Error(`User @${normalized} already exists.`);
    }
    const encryptionKey = await generateSymmetricKey();
    const user: UserProfile = {
      id: generateId('usr'),
      handle: normalized,
      displayName: resolveDisplayName(normalized, displayName),
      email: (email || '').trim() || undefined,
      createdAt: Date.now(),
      encryptionKey,
    };
    usersByHandle.set(normalized, user);
    usersById.set(user.id, user);
    subscriptions.initializeSubscriptionForUser(user.id);
    selectActiveUser(user);
    return user;
  }

  function listUsers(): UserProfile[] {
    return Array.from(usersByHandle.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  function getActiveUser(): UserProfile | null {
    return activeUserId ? getUserById(activeUserId) : null;
  }

  function getActiveUserId(): string | null {
    return activeUserId;
  }

  function setActiveUser(identifier: string): UserProfile {
    const byId = getUserById(identifier);
    if (byId) {
      activeUserId = byId.id;
      return byId;
    }
    const byHandle = getUserByHandle(identifier);
    if (byHandle) {
      activeUserId = byHandle.id;
      return byHandle;
    }
    throw new Error(`User ${identifier} not found.`);
  }

  function updateEncryptionKey(userId: string, newKey: string): void {
    const user = getUserById(userId);
    if (!user) {
      throw new Error('User not found.');
    }
    user.encryptionKey = newKey;
  }

  return {
    createUser,
    listUsers,
    getUserByHandle,
    getUserById,
    getActiveUser,
    getActiveUserId,
    setActiveUser,
    updateEncryptionKey,
  };
}
