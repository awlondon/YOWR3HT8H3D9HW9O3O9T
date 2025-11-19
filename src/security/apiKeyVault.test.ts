import assert from 'node:assert/strict';
import test from 'node:test';

import { webcrypto } from 'node:crypto';

import { clearEncryptedApiKey, hasEncryptedApiKey, loadEncryptedApiKey, persistEncryptedApiKey } from './apiKeyVault.js';

class MemoryStorage implements Storage {
  #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }

  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.#map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, String(value));
  }
}

const storage = new MemoryStorage();
(globalThis as any).localStorage = storage;
if (typeof globalThis.crypto === 'undefined') {
  (globalThis as any).crypto = webcrypto;
}

if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (input: string) => Buffer.from(input, 'binary').toString('base64');
}
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (input: string) => Buffer.from(input, 'base64').toString('binary');
}

test('persistEncryptedApiKey stores and restores the key', async () => {
  clearEncryptedApiKey();
  assert.equal(hasEncryptedApiKey(), false);
  const persisted = await persistEncryptedApiKey('sk-test_1234567890');
  assert.equal(persisted, true);
  assert.equal(hasEncryptedApiKey(), true);
  const restored = await loadEncryptedApiKey();
  assert.equal(restored, 'sk-test_1234567890');
});

test('clearEncryptedApiKey removes any stored secrets', async () => {
  await persistEncryptedApiKey('sk-test_remove_me');
  clearEncryptedApiKey();
  assert.equal(hasEncryptedApiKey(), false);
  const restored = await loadEncryptedApiKey();
  assert.equal(restored, null);
});
