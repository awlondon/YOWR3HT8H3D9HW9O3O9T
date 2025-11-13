/**
 * Generic cache abstraction used by the cognition engine to read and persist
 * adjacency and messaging records. The minimal interface keeps the storage
 * backend pluggable for tests and low-memory runtimes.
 */
export interface CacheStore<TValue = unknown> {
  /** Retrieve a value for the provided key. */
  get(key: string): TValue | null | undefined;
  /** Persist a value for the provided key. */
  set(key: string, value: TValue): void;
}

/**
 * In-memory {@link CacheStore} backed by a `Map`. Useful for unit tests and
 * Node.js environments where `localStorage` is not available.
 */
export class MemoryStore<TValue = unknown> implements CacheStore<TValue> {
  private readonly map = new Map<string, TValue>();

  get(key: string): TValue | null | undefined {
    return this.map.get(key);
  }

  set(key: string, value: TValue): void {
    this.map.set(key, value);
  }
}

/**
 * {@link CacheStore} wrapper around the browser `localStorage` API. Errors are
 * swallowed to avoid breaking the pipeline when storage quotas are reached.
 */
export class LocalStorageStore implements CacheStore<string> {
  constructor(private readonly storage: Storage) {}

  get(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch {
      // Ignore quota errors; callers can fallback to in-memory caches.
    }
  }
}

/**
 * Dispatches `get` calls to each store until a value is returned while
 * mirroring writes to all stores. This enables hybrid caching strategies where
 * reads prefer fast in-memory stores but writes persist to localStorage.
 */
export class CompositeCacheStore<TValue = unknown> implements CacheStore<TValue> {
  constructor(private readonly stores: CacheStore<TValue>[]) {}

  get(key: string): TValue | null | undefined {
    for (const store of this.stores) {
      const value = store.get(key);
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    return null;
  }

  set(key: string, value: TValue): void {
    for (const store of this.stores) {
      store.set(key, value);
    }
  }
}

/**
 * Helper that normalises a loosely typed cache-like object (for example the
 * legacy `__HLSF_ADJ_CACHE__` global) into a {@link CacheStore} implementation.
 */
export function wrapCacheLike<TValue = unknown>(candidate: unknown): CacheStore<TValue> | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const maybeGet = (candidate as any).get;
  const maybeSet = (candidate as any).set;
  if (typeof maybeGet === 'function' && typeof maybeSet === 'function') {
    return {
      get(key: string) {
        return maybeGet.call(candidate, key);
      },
      set(key: string, value: TValue) {
        maybeSet.call(candidate, key, value);
      },
    };
  }
  return null;
}
