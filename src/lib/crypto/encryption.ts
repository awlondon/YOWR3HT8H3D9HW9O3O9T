const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requireSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto API is required for secure messaging.');
  }
  return subtle;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function generateSymmetricKey(): Promise<string> {
  const subtle = requireSubtleCrypto();
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await subtle.exportKey('raw', key);
  return toBase64(raw);
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const subtle = requireSubtleCrypto();
  const raw = fromBase64(keyBase64);
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptString(plainText: string, keyBase64: string): Promise<{ ciphertext: string; iv: string }> {
  if (!plainText) {
    throw new Error('Cannot encrypt empty messages.');
  }
  const subtle = requireSubtleCrypto();
  const key = await importKey(keyBase64);
  const ivBytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(12));
  if (!ivBytes) {
    throw new Error('Unable to generate initialization vector for encryption.');
  }
  const cipherBuffer = await subtle.encrypt({ name: 'AES-GCM', iv: ivBytes }, key, encoder.encode(plainText));
  return { ciphertext: toBase64(cipherBuffer), iv: toBase64(ivBytes.buffer) };
}

export async function decryptString(ciphertextBase64: string, ivBase64: string, keyBase64: string): Promise<string> {
  const subtle = requireSubtleCrypto();
  const key = await importKey(keyBase64);
  const cipherBuffer = fromBase64(ciphertextBase64);
  const iv = fromBase64(ivBase64);
  const plainBuffer = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, cipherBuffer);
  return decoder.decode(plainBuffer);
}

export function base64Preview(base64: string, length = 12): string {
  if (!base64) return '';
  const clean = base64.replace(/\s+/g, '');
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length)}…${clean.slice(-length)}`;
}
