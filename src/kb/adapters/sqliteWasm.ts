import type { AdjQuery, EdgeRow, KBAdapter, TokenId } from '../index';

/**
 * Placeholder SQLite-WASM adapter. The implementation can be filled once the
 * host application bundles sql.js or wa-sqlite. The adapter currently throws
 * to highlight the missing dependency while still satisfying the KBAdapter
 * contract for environments that perform dynamic adapter selection.
 */
export class SQLiteWasmAdapter implements KBAdapter {
  async init(): Promise<void> {
    throw new Error('SQLite-WASM adapter not bundled');
  }

  async ensureToken(): Promise<TokenId> {
    throw new Error('SQLite-WASM adapter not available');
  }

  async getToken(): Promise<string> {
    throw new Error('SQLite-WASM adapter not available');
  }

  async getAdj(): Promise<EdgeRow[]> {
    throw new Error('SQLite-WASM adapter not available');
  }

  async upsertAdj(): Promise<void> {
    throw new Error('SQLite-WASM adapter not available');
  }

  async bulkImport(): Promise<void> {
    throw new Error('SQLite-WASM adapter not available');
  }

  async stats(): Promise<{ tokens: number; shards: number; edges: number; sizeBytes: number }> {
    throw new Error('SQLite-WASM adapter not available');
  }

  async compact(): Promise<void> {
    throw new Error('SQLite-WASM adapter not available');
  }

  async gc(): Promise<void> {
    throw new Error('SQLite-WASM adapter not available');
  }
}
