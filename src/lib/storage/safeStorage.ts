export const memoryStorageFallback = new Map<string, string>();
let storageQuotaWarningIssued = false;
let storageQuotaHardLimitActive = false;

export const TOKEN_CACHE_PREFIX = 'hlsf_token_';
export const DB_RAW_KEY = 'HLSF_DB_RAW';
export const DB_INDEX_KEY = 'HLSF_DB_INDEX';
export const EXPORT_KEY_STORAGE_KEY = 'HLSF_EXPORT_KEY';
export const EXPORT_PAYLOAD_FORMAT = 'HLSF_DB_EXPORT_V2';
export const EXPORT_PAYLOAD_VERSION = 2;

export interface SafeStorageHooks {
  onTokenCachePurged?: () => void;
  onQuotaWarning?: (message: string) => void;
}

let hooks: SafeStorageHooks = {};

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage;
  } catch (error) {
    console.warn('Storage unavailable in this environment:', error);
    return null;
  }
}

function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as { name?: string; code?: number };
  return (
    error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014
  );
}

function purgeSpecificKey(key: string): boolean {
  let removed = false;
  const storage = getStorage();
  try {
    if (storage && storage.getItem(key) != null) {
      storage.removeItem(key);
      removed = true;
    }
  } catch (err) {
    console.warn(`Failed to purge ${key} from persistent storage:`, err);
  }
  if (memoryStorageFallback.delete(key)) {
    removed = true;
  }
  if (removed) {
    storageQuotaHardLimitActive = false;
  }
  return removed;
}

export function configureSafeStorageHooks(nextHooks: SafeStorageHooks): void {
  hooks = { ...hooks, ...nextHooks };
}

export function purgeTokenCache(): number {
  let removed = 0;
  const storage = getStorage();
  try {
    if (storage) {
      const keys = Object.keys(storage).filter(key => key.startsWith(TOKEN_CACHE_PREFIX));
      for (const key of keys) {
        storage.removeItem(key);
        removed += 1;
      }
    }
  } catch (err) {
    console.warn('Failed to purge token cache from persistent storage:', err);
  }
  for (const key of Array.from(memoryStorageFallback.keys())) {
    if (!key.startsWith(TOKEN_CACHE_PREFIX)) continue;
    memoryStorageFallback.delete(key);
    removed += 1;
  }

  if (removed > 0) {
    hooks.onTokenCachePurged?.();
    storageQuotaHardLimitActive = false;
  }
  return removed;
}

export function safeStorageGet<T = unknown>(key: string, defaultValue: T | null = null): T | null {
  let item: string | null = null;
  const storage = getStorage();
  try {
    item = storage?.getItem(key) ?? null;
  } catch (err) {
    console.warn(`Storage read failed for ${key}:`, err);
  }

  if (item == null && memoryStorageFallback.has(key)) {
    item = memoryStorageFallback.get(key) ?? null;
  }

  if (item == null) {
    return defaultValue;
  }

  try {
    return JSON.parse(item) as T;
  } catch {
    return item as unknown as T;
  }
}

export function safeStorageSet(key: string, value: string): boolean {
  const fallbackToMemory = (err: unknown = null): boolean => {
    memoryStorageFallback.set(key, value);
    if (!storageQuotaWarningIssued) {
      hooks.onQuotaWarning?.(
        'Browser storage quota exceeded. Falling back to in-memory storage for this session.',
      );
      storageQuotaWarningIssued = true;
    }
    if (err) {
      console.warn(`Storage write failed for ${key}: using in-memory fallback`, err);
    }
    return false;
  };

  const attemptWrite = (): boolean => {
    const storage = getStorage();
    if (!storage) {
      return fallbackToMemory();
    }
    storage.setItem(key, value);
    memoryStorageFallback.delete(key);
    storageQuotaHardLimitActive = false;
    return true;
  };

  if (storageQuotaHardLimitActive) {
    return fallbackToMemory();
  }

  try {
    return attemptWrite();
  } catch (err) {
    if (!isQuotaExceededError(err)) {
      console.warn(`Storage write failed for ${key}:`, err);
      return false;
    }

    const cleanupSteps: Array<() => number | boolean> = [() => purgeTokenCache()];
    if (key !== DB_INDEX_KEY) {
      cleanupSteps.push(() => purgeSpecificKey(DB_INDEX_KEY));
    }
    if (key !== DB_RAW_KEY) {
      cleanupSteps.push(() => purgeSpecificKey(DB_RAW_KEY));
    }
    cleanupSteps.push(() => purgeSpecificKey(key));

    for (const step of cleanupSteps) {
      try {
        const removed = step();
        if (!removed) continue;
      } catch (cleanupErr) {
        console.warn('Storage cleanup step failed:', cleanupErr);
      }

      try {
        return attemptWrite();
      } catch (retryErr) {
        if (!isQuotaExceededError(retryErr)) {
          console.warn(`Storage write failed for ${key} after cleanup:`, retryErr);
          return false;
        }
      }
    }

    storageQuotaHardLimitActive = true;
    return fallbackToMemory(err);
  }
}

export function safeStorageRemove(key: string): boolean {
  let removed = false;
  const storage = getStorage();
  try {
    if (storage) {
      storage.removeItem(key);
      removed = true;
    }
  } catch (err) {
    console.warn(`Storage remove failed for ${key}:`, err);
  }
  if (memoryStorageFallback.delete(key)) {
    removed = true;
  }
  if (removed) {
    storageQuotaHardLimitActive = false;
  }
  return removed;
}

export function safeStorageKeys(prefix = ''): string[] {
  const keys = new Set<string>();
  const storage = getStorage();
  try {
    if (storage) {
      for (const key of Object.keys(storage)) {
        if (key.startsWith(prefix)) {
          keys.add(key);
        }
      }
    }
  } catch (err) {
    console.warn('Storage keys enumeration failed:', err);
  }

  memoryStorageFallback.forEach((_, key) => {
    if (key.startsWith(prefix)) {
      keys.add(key);
    }
  });

  return Array.from(keys);
}
