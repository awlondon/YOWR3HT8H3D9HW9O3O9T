export type TokenId = number;
export type EdgeType = number;
export type Weight = number;
export type EpochSec = number;

export type EdgeRow = {
  neighborId: TokenId;
  type: EdgeType;
  w: Weight;
  lastSeen: EpochSec;
  flags?: number;
};

export type AdjQuery = {
  tokenId: TokenId;
  type?: EdgeType | EdgeType[];
  minWeight?: number;
  limit?: number;
  reverse?: boolean;
};

export interface KBAdapter {
  init(): Promise<void>;
  ensureToken(token: string): Promise<TokenId>;
  getToken(id: TokenId): Promise<string>;
  getAdj(q: AdjQuery): Promise<EdgeRow[]>;
  upsertAdj(tokenId: TokenId, edges: EdgeRow[], opts?: { merge?: boolean }): Promise<void>;
  bulkImport(stream: AsyncIterable<any>): Promise<void>;
  stats(): Promise<{ tokens: number; shards: number; edges: number; sizeBytes: number }>;
  compact(opts?: { aggressive?: boolean }): Promise<void>;
  gc(opts?: { maxAgeDays?: number; minWeight?: number; targetSizeMB?: number }): Promise<void>;
  close?(): Promise<void>;
}

export class KBStore {
  constructor(private driver: KBAdapter) {}

  init() { return this.driver.init(); }
  ensureToken(s: string) { return this.driver.ensureToken(s); }
  getToken(id: TokenId) { return this.driver.getToken(id); }
  getAdj(q: AdjQuery) { return this.driver.getAdj(q); }
  upsertAdj(id: TokenId, e: EdgeRow[], o?: { merge?: boolean }) {
    return this.driver.upsertAdj(id, e, o);
  }
  bulkImport(it: AsyncIterable<any>) { return this.driver.bulkImport(it); }
  stats() { return this.driver.stats(); }
  compact(o?: { aggressive?: boolean }) { return this.driver.compact(o); }
  gc(o?: { maxAgeDays?: number; minWeight?: number; targetSizeMB?: number }) { return this.driver.gc(o); }
  close() { return this.driver.close?.(); }
}

export type { EdgeBlock } from './schema';
