import { decryptString, encryptString, generateSymmetricKey } from '../lib/crypto/encryption.js';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '../lib/storage/safeStorage.js';

const API_KEY_STORAGE_KEY = 'HLSF_API_KEY';
const API_KEY_SECRET_KEY = 'HLSF_API_SECRET_KEY';
const STORAGE_VERSION = 1;

interface StoredApiKeyPayload {
  version: number;
  ciphertext: string;
  iv: string;
  createdAt: string;
}

async function ensureSecretKey(): Promise<string | null> {
  const existing = safeStorageGet<string | null>(API_KEY_SECRET_KEY, null);
  if (typeof existing === 'string' && existing.trim()) {
    return existing;
  }
  try {
    const secret = await generateSymmetricKey();
    const persisted = safeStorageSet(API_KEY_SECRET_KEY, secret);
    if (!persisted) {
      console.warn('API key secret persisted in memory only.');
    }
    return secret;
  } catch (error) {
    console.warn('Unable to generate API key secret:', error);
    return null;
  }
}

export async function persistEncryptedApiKey(apiKey: string): Promise<boolean> {
  const secret = await ensureSecretKey();
  if (!secret) {
    return false;
  }
  try {
    const { ciphertext, iv } = await encryptString(apiKey, secret);
    const payload: StoredApiKeyPayload = {
      version: STORAGE_VERSION,
      ciphertext,
      iv,
      createdAt: new Date().toISOString(),
    };
    return safeStorageSet(API_KEY_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('Unable to encrypt API key:', error);
    return false;
  }
}

export function hasEncryptedApiKey(): boolean {
  const payload = safeStorageGet<StoredApiKeyPayload | null>(API_KEY_STORAGE_KEY, null);
  return Boolean(
    payload
    && typeof payload === 'object'
    && typeof (payload as StoredApiKeyPayload).ciphertext === 'string'
    && typeof (payload as StoredApiKeyPayload).iv === 'string',
  );
}

export async function loadEncryptedApiKey(): Promise<string | null> {
  const payload = safeStorageGet<StoredApiKeyPayload | null>(API_KEY_STORAGE_KEY, null);
  const secret = safeStorageGet<string | null>(API_KEY_SECRET_KEY, null);
  if (
    !payload
    || typeof payload !== 'object'
    || typeof secret !== 'string'
    || !secret
    || typeof payload.ciphertext !== 'string'
    || typeof payload.iv !== 'string'
  ) {
    return null;
  }
  try {
    return await decryptString(payload.ciphertext, payload.iv, secret);
  } catch (error) {
    console.warn('Unable to decrypt stored API key:', error);
    return null;
  }
}

export function clearEncryptedApiKey(): void {
  safeStorageRemove(API_KEY_STORAGE_KEY);
  safeStorageRemove(API_KEY_SECRET_KEY);
}
