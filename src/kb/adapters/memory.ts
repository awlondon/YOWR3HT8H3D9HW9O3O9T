import { BLOCK_MAX } from '../shard';
import type { AdjQuery, EdgeRow, KBAdapter, TokenId } from '../index';
import type { EdgeBlock } from '../schema';
import { notifyGraphUpdated, notifyTokenObserved } from '../../vector/globals';

function matchType(value: number, expected?: number | number[]): boolean {
  if (expected == null) return true;
  return Array.isArray(expected) ? expected.includes(value) : value === expected;
}

class EdgeAccumulator {
  private byKey = new Map<string, EdgeRow>();

  constructor(initial: EdgeRow[] = []) {
    for (const row of initial) {
      this.add(row);
    }
  }

  add(row: EdgeRow) {
    const key = `${row.neighborId}|${row.type}`;
    const existing = this.byKey.get(key);
    if (existing) {
      this.byKey.set(key, { ...existing, ...row });
    } else {
      this.byKey.set(key, { ...row });
    }
  }

  toRows(): EdgeRow[] {
    return Array.from(this.byKey.values());
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
      slice.forEach((row, idx) => {
        neighbor[idx] = row.neighborId;
        type[idx] = row.type;
        weight[idx] = row.w;
        lastSeen[idx] = row.lastSeen;
      });
      blocks.push({ tokenId, part: blocks.length, count, neighbor, type, weight, lastSeen });
    }
    return blocks;
  }
}

export class MemoryAdapter implements KBAdapter {
  private tokens = new Map<string, TokenId>();
  private tokenList: string[] = [];
  private edges = new Map<TokenId, EdgeAccumulator>();
  private sizeBytes = 0;

  async init(): Promise<void> {}

  async ensureToken(token: string): Promise<TokenId> {
    const key = token.trim();
    if (!this.tokens.has(key)) {
      const id = this.tokenList.length + 1;
      this.tokens.set(key, id);
      this.tokenList.push(key);
      notifyTokenObserved(id, key);
      return id;
    }
    const id = this.tokens.get(key)!;
    notifyTokenObserved(id, key);
    return id;
  }

  async getToken(id: TokenId): Promise<string> {
    return this.tokenList[id - 1] ?? '';
  }

  private ensureAccumulator(tokenId: TokenId): EdgeAccumulator {
    let acc = this.edges.get(tokenId);
    if (!acc) {
      acc = new EdgeAccumulator();
      this.edges.set(tokenId, acc);
    }
    return acc;
  }

  async getAdj(q: AdjQuery): Promise<EdgeRow[]> {
    const acc = this.edges.get(q.tokenId);
    if (!acc) return [];
    const rows = acc.toRows().filter(row => {
      if (!matchType(row.type, q.type)) return false;
      if (q.minWeight != null && row.w < q.minWeight) return false;
      return true;
    });
    rows.sort((a, b) => b.w - a.w);
    return q.limit != null ? rows.slice(0, q.limit) : rows;
  }

  async upsertAdj(tokenId: TokenId, edges: EdgeRow[], opts?: { merge?: boolean }): Promise<void> {
    if (!opts?.merge) {
      this.edges.set(tokenId, new EdgeAccumulator(edges));
      this.recomputeSize();
      const changed = new Set<TokenId>([tokenId, ...edges.map(edge => edge.neighborId)]);
      notifyGraphUpdated(Array.from(changed));
      return;
    }
    const acc = this.ensureAccumulator(tokenId);
    for (const row of edges) {
      acc.add(row);
    }
    this.recomputeSize();
    const changed = new Set<TokenId>([tokenId, ...edges.map(edge => edge.neighborId)]);
    notifyGraphUpdated(Array.from(changed));
  }

  async bulkImport(stream: AsyncIterable<any>): Promise<void> {
    for await (const item of stream) {
      if (!item) continue;
      let tokenId: TokenId | null = null;
      if (typeof item.tokenId === 'number') tokenId = item.tokenId;
      else if (typeof item.token === 'string') tokenId = await this.ensureToken(item.token);
      if (tokenId == null) continue;
      const rows: EdgeRow[] = Array.isArray(item.edges) ? item.edges : [];
      await this.upsertAdj(tokenId, rows, { merge: true });
    }
  }

  private recomputeSize() {
    let total = 0;
    for (const acc of this.edges.values()) {
      total += acc.toRows().length * 24;
    }
    this.sizeBytes = total;
  }

  async stats(): Promise<{ tokens: number; shards: number; edges: number; sizeBytes: number }> {
    let edgeCount = 0;
    for (const acc of this.edges.values()) {
      edgeCount += acc.toRows().length;
    }
    return {
      tokens: this.tokenList.length,
      shards: this.edges.size,
      edges: edgeCount,
      sizeBytes: this.sizeBytes,
    };
  }

  async compact(): Promise<void> {}

  async gc(): Promise<void> {}

  async close(): Promise<void> {}
}
