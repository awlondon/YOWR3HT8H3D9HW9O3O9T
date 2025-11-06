import { decodeEdgeBlock, encodeEdgeBlock } from '../encode';
import type { AdjQuery, EdgeRow, KBAdapter, TokenId } from '../index';
import { BLOCK_MAX, hashPrefix } from '../shard';
import { KB_SCHEMA_VERSION } from '../schema';
import type { EdgeBlock } from '../schema';

const DB_NAME = 'hlsf_kb';
const DB_VERSION = 1;

type EdgeRecord = {
  key: string;
  tokenId: number;
  part: number;
  prefix: string;
  blob: Blob;
  compressed?: boolean;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('tokens')) {
        const tokens = db.createObjectStore('tokens', { keyPath: 'id', autoIncrement: true });
        tokens.createIndex('by_s', 's', { unique: true });
      }
      if (!db.objectStoreNames.contains('edgeBlocks')) {
        const edgeBlocks = db.createObjectStore('edgeBlocks', { keyPath: 'key' });
        edgeBlocks.createIndex('by_token', 'tokenId');
        edgeBlocks.createIndex('by_prefix', 'prefix');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function matchType(value: number, expected?: number | number[]): boolean {
  if (expected == null) return true;
  return Array.isArray(expected) ? expected.includes(value) : value === expected;
}

class EdgeAccumulator {
  private map = new Map<string, EdgeRow>();

  constructor(initial: EdgeRow[] = []) {
    initial.forEach(row => this.add(row));
  }

  add(row: EdgeRow) {
    const key = `${row.neighborId}|${row.type}`;
    const existing = this.map.get(key);
    if (existing) {
      this.map.set(key, { ...existing, ...row });
    } else {
      this.map.set(key, { ...row });
    }
  }

  addBlock(block: EdgeBlock) {
    const { neighbor, type, weight, lastSeen, count } = block;
    for (let i = 0; i < count; i += 1) {
      this.add({
        neighborId: neighbor[i],
        type: type[i],
        w: weight[i],
        lastSeen: lastSeen[i],
        flags: block.flags ? block.flags[i] : undefined,
      });
    }
  }

  toRows(): EdgeRow[] {
    return Array.from(this.map.values());
  }

  toBlocks(tokenId: number): EdgeBlock[] {
    const rows = this.toRows();
    const blocks: EdgeBlock[] = [];
    for (let offset = 0; offset < rows.length; offset += BLOCK_MAX) {
      const slice = rows.slice(offset, offset + BLOCK_MAX);
      const count = slice.length;
      const neighbor = new Uint32Array(count);
      const type = new Uint16Array(count);
      const weight = new Uint32Array(count);
      const lastSeen = new Uint32Array(count);
      const flags = new Uint8Array(count);
      let hasFlags = false;
      slice.forEach((row, idx) => {
        neighbor[idx] = row.neighborId;
        type[idx] = row.type;
        weight[idx] = row.w;
        lastSeen[idx] = row.lastSeen;
        if (row.flags != null) {
          hasFlags = true;
          flags[idx] = row.flags;
        }
      });
      blocks.push({
        tokenId,
        part: blocks.length,
        count,
        neighbor,
        type,
        weight,
        lastSeen,
        flags: hasFlags ? flags : undefined,
      });
    }
    return blocks;
  }
}

function supportsCompression() {
  return typeof CompressionStream !== 'undefined'
    && typeof DecompressionStream !== 'undefined';
}

export class IdbAdapter implements KBAdapter {
  private db!: IDBDatabase;

  async init(): Promise<void> {
    this.db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = this.transaction(['meta'], 'readwrite');
      const store = tx.objectStore('meta');
      const req = store.put(KB_SCHEMA_VERSION, 'schemaVersion');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private transaction<T extends string[]>(stores: T, mode: IDBTransactionMode) {
    return this.db.transaction(stores, mode);
  }

  async ensureToken(token: string): Promise<TokenId> {
    const normalized = token.trim();
    if (!normalized) throw new Error('Token cannot be empty');
    const existing = await new Promise<TokenId | undefined>((resolve, reject) => {
      const tx = this.transaction(['tokens'], 'readonly');
      const index = tx.objectStore('tokens').index('by_s');
      const request = index.get(normalized);
      request.onsuccess = () => resolve(request.result?.id);
      request.onerror = () => reject(request.error);
    });
    if (existing != null) return existing;
    return await new Promise<TokenId>((resolve, reject) => {
      const tx = this.transaction(['tokens'], 'readwrite');
      const request = tx.objectStore('tokens').add({ s: normalized });
      request.onsuccess = () => resolve(request.result as number);
      request.onerror = () => reject(request.error);
    });
  }

  async getToken(id: TokenId): Promise<string> {
    return await new Promise((resolve, reject) => {
      const tx = this.transaction(['tokens'], 'readonly');
      const request = tx.objectStore('tokens').get(id);
      request.onsuccess = () => resolve(request.result?.s ?? '');
      request.onerror = () => reject(request.error);
    });
  }

  private async listPartKeys(tokenId: TokenId): Promise<string[]> {
    const keys: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const tx = this.transaction(['edgeBlocks'], 'readonly');
      const index = tx.objectStore('edgeBlocks').index('by_token');
      const request = index.openCursor(IDBKeyRange.only(tokenId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        keys.push(cursor.primaryKey as string);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    return keys;
  }

  private async loadBlockRecord(key: string): Promise<EdgeRecord | undefined> {
    return await new Promise((resolve, reject) => {
      const tx = this.transaction(['edgeBlocks'], 'readonly');
      const request = tx.objectStore('edgeBlocks').get(key);
      request.onsuccess = () => resolve(request.result as EdgeRecord | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  private async loadBlock(key: string): Promise<EdgeBlock | null> {
    const record = await this.loadBlockRecord(key);
    if (!record) return null;
    const blob = record.blob;
    const decoded = await decodeEdgeBlock(blob);
    return decoded;
  }

  async getAdj(q: AdjQuery): Promise<EdgeRow[]> {
    if (q.reverse) {
      return this.getReverseAdj(q);
    }
    const keys = await this.listPartKeys(q.tokenId);
    const rows: EdgeRow[] = [];
    for (const key of keys) {
      const block = await this.loadBlock(key);
      if (!block) continue;
      const { neighbor, type, weight, lastSeen, count } = block;
      for (let i = 0; i < count; i += 1) {
        if (!matchType(type[i], q.type)) continue;
        if (q.minWeight != null && weight[i] < q.minWeight) continue;
        rows.push({ neighborId: neighbor[i], type: type[i], w: weight[i], lastSeen: lastSeen[i] });
        if (q.limit != null && rows.length >= q.limit) break;
      }
      if (q.limit != null && rows.length >= q.limit) break;
    }
    rows.sort((a, b) => b.w - a.w);
    return q.limit != null ? rows.slice(0, q.limit) : rows;
  }

  private async getReverseAdj(q: AdjQuery): Promise<EdgeRow[]> {
    const rows: EdgeRow[] = [];
    await new Promise<void>((resolve, reject) => {
      const tx = this.transaction(['edgeBlocks'], 'readonly');
      const store = tx.objectStore('edgeBlocks');
      const request = store.openCursor();
      request.onsuccess = async () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const record = cursor.value as EdgeRecord;
        const block = await decodeEdgeBlock(record.blob);
        const { neighbor, type, weight, lastSeen, count } = block;
        for (let i = 0; i < count; i += 1) {
          if (neighbor[i] !== q.tokenId) continue;
          if (!matchType(type[i], q.type)) continue;
          if (q.minWeight != null && weight[i] < q.minWeight) continue;
          rows.push({ neighborId: record.tokenId, type: type[i], w: weight[i], lastSeen: lastSeen[i] });
          if (q.limit != null && rows.length >= q.limit) {
            tx.abort();
            return resolve();
          }
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    rows.sort((a, b) => b.w - a.w);
    return q.limit != null ? rows.slice(0, q.limit) : rows;
  }

  private async loadAccumulator(tokenId: TokenId): Promise<EdgeAccumulator> {
    const keys = await this.listPartKeys(tokenId);
    const acc = new EdgeAccumulator();
    for (const key of keys) {
      const block = await this.loadBlock(key);
      if (block) acc.addBlock(block);
    }
    return acc;
  }

  async upsertAdj(tokenId: TokenId, edges: EdgeRow[], opts?: { merge?: boolean }): Promise<void> {
    const acc = opts?.merge ? await this.loadAccumulator(tokenId) : new EdgeAccumulator();
    edges.forEach(edge => acc.add(edge));
    const blocks = acc.toBlocks(tokenId);
    const existingKeys = await this.listPartKeys(tokenId);
    const encodedBlocks = await Promise.all(blocks.map(async block => {
      const blob = await encodeEdgeBlock(block, supportsCompression());
      const key = `${block.tokenId}:${block.part}`;
      const record: EdgeRecord = {
        key,
        tokenId: block.tokenId,
        part: block.part,
        prefix: hashPrefix(block.tokenId),
        blob,
        compressed: supportsCompression(),
      };
      return { key, record };
    }));

    await new Promise<void>((resolve, reject) => {
      const tx = this.transaction(['edgeBlocks'], 'readwrite');
      const store = tx.objectStore('edgeBlocks');
      const keysToKeep = new Set(encodedBlocks.map(item => item.key));
      for (const key of existingKeys) {
        if (!keysToKeep.has(key)) {
          store.delete(key);
        }
      }
      for (const { record } of encodedBlocks) {
        store.put(record);
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('KB upsert aborted'));
      tx.onerror = () => reject(tx.error || new Error('KB upsert failed'));
    });
  }

  async bulkImport(stream: AsyncIterable<any>): Promise<void> {
    for await (const item of stream) {
      if (!item) continue;
      let tokenId: TokenId | null = null;
      if (typeof item.tokenId === 'number') {
        tokenId = item.tokenId;
      } else if (typeof item.token === 'string') {
        tokenId = await this.ensureToken(item.token);
      }
      if (tokenId == null) continue;
      const rows: EdgeRow[] = Array.isArray(item.edges) ? item.edges : [];
      await this.upsertAdj(tokenId, rows, { merge: true });
    }
  }

  async stats(): Promise<{ tokens: number; shards: number; edges: number; sizeBytes: number }> {
    const [tokens, edgeStats] = await Promise.all([
      this.countTokens(),
      this.summariseEdges(),
    ]);
    return { ...edgeStats, tokens };
  }

  private async countTokens(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const tx = this.transaction(['tokens'], 'readonly');
      const req = tx.objectStore('tokens').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async summariseEdges(): Promise<{ shards: number; edges: number; sizeBytes: number }> {
    const records = await this.collectEdgeRecords();
    let shards = 0;
    let edges = 0;
    let sizeBytes = 0;
    for (const record of records) {
      const block = await decodeEdgeBlock(record.blob);
      shards += 1;
      edges += block.count;
      sizeBytes += record.blob.size;
    }
    return { shards, edges, sizeBytes };
  }

  private async collectEdgeRecords(): Promise<EdgeRecord[]> {
    const records: EdgeRecord[] = [];
    await new Promise<void>((resolve, reject) => {
      const tx = this.transaction(['edgeBlocks'], 'readonly');
      const req = tx.objectStore('edgeBlocks').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        records.push(cursor.value as EdgeRecord);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return records;
  }

  async compact(): Promise<void> {
    const records = await this.collectEdgeRecords();
    const rewritten = await Promise.all(records.map(async record => {
      const block = await decodeEdgeBlock(record.blob);
      const blob = await encodeEdgeBlock(block, supportsCompression());
      return { ...record, blob, compressed: supportsCompression() };
    }));
    await new Promise<void>((resolve, reject) => {
      const tx = this.transaction(['edgeBlocks'], 'readwrite');
      const store = tx.objectStore('edgeBlocks');
      for (const record of rewritten) {
        store.put(record);
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('KB compact aborted'));
      tx.onerror = () => reject(tx.error || new Error('KB compact failed'));
    });
  }

  async gc(): Promise<void> {
    const records = await this.collectEdgeRecords();
    const decoded = await Promise.all(records.map(async record => ({
      record,
      block: await decodeEdgeBlock(record.blob),
    })));
    await new Promise<void>((resolve, reject) => {
      const tx = this.transaction(['edgeBlocks'], 'readwrite');
      const store = tx.objectStore('edgeBlocks');
      for (const { record, block } of decoded) {
        if (block.count === 0) {
          store.delete(record.key);
        } else {
          store.put(record);
        }
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('KB gc aborted'));
      tx.onerror = () => reject(tx.error || new Error('KB gc failed'));
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
