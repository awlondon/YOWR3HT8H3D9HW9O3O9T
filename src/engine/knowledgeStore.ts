export interface KnowledgeRecord {
  token: string;
  relationships?: Record<string, Array<{ token?: string; weight?: number }>>;
  attention_score?: number;
  total_relationships?: number;
}

const DB_NAME = 'hlsf-knowledge';
const DB_VERSION = 1;
const STORE_NAME = 'adjacency';

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

export class KnowledgeStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private inMemoryTokens = new Set<string>();

  private ensureDb(): Promise<IDBDatabase> {
    if (!supportsIndexedDb()) {
      return Promise.reject(new Error('IndexedDB unavailable'));
    }
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'token' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      });
    }
    return this.dbPromise;
  }

  hasInMemory(token: string): boolean {
    if (!token) return false;
    return this.inMemoryTokens.has(token.toLowerCase());
  }

  markInMemory(token: string): void {
    if (!token) return;
    this.inMemoryTokens.add(token.toLowerCase());
  }

  async put(record: KnowledgeRecord): Promise<void> {
    if (!record?.token || !supportsIndexedDb()) return;
    const db = await this.ensureDb().catch(() => null);
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(record);
    this.markInMemory(record.token);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB put aborted'));
    }).catch((error) => {
      console.warn('KnowledgeStore.put failed:', error);
    });
  }

  async get(token: string): Promise<KnowledgeRecord | null> {
    if (!token || !supportsIndexedDb()) return null;
    const db = await this.ensureDb().catch(() => null);
    if (!db) return null;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(token);
    const record = await new Promise<KnowledgeRecord | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as KnowledgeRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB get failed'));
    }).catch((error) => {
      console.warn('KnowledgeStore.get failed:', error);
      return undefined;
    });
    if (record) {
      this.markInMemory(token);
      return record;
    }
    return null;
  }

  async bulkGet(tokens: string[]): Promise<Map<string, KnowledgeRecord>> {
    const results = new Map<string, KnowledgeRecord>();
    if (!Array.isArray(tokens) || !tokens.length) return results;
    await Promise.all(tokens.map(async (token) => {
      const record = await this.get(token);
      if (record) {
        results.set(token, record);
      }
    }));
    return results;
  }
}

export const knowledgeStore = new KnowledgeStore();
