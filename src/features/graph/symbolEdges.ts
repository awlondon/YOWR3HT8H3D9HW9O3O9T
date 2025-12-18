import type { Token, WordNeighborIndex } from '../../tokens/tokenize.js';
import { computeWordNeighborMap } from '../../tokens/tokenize.js';
import { AdjacencyFamily, classifyRelation } from '../../types/adjacencyFamilies.js';

export const LEFT_BIND = new Set(['!', '?', '.', ',', ':', ';']);
export const RIGHT_BIND = new Set(['(', '[', '{', '“', '‘']);
export const CLOSE_BIND = new Set([')', ']', '}', '”', '’']);

export interface EdgeMeta {
  type: string;
  w?: number;
  meta?: Record<string, unknown>;
  family?: AdjacencyFamily;
}

export type AddEdge = (source: Token, target: Token, meta: EdgeMeta) => void;

function modifierTypeForSymbol(ch: string): string {
  if (ch === '!') return 'modifier:emphasis';
  if (ch === '?') return 'modifier:query';
  if (LEFT_BIND.has(ch)) return 'modifier:left';
  if (RIGHT_BIND.has(ch)) return 'modifier:right';
  if (CLOSE_BIND.has(ch)) return 'modifier:close';
  return 'modifier:other';
}

export function emitSymbolEdges(
  tokens: Token[],
  addEdge: AddEdge,
  weightScale = 0.35,
  mode: 'paired' | 'standalone' | 'both' = 'paired',
  neighbors: WordNeighborIndex[] | null = null,
) {
  const len = tokens.length;
  const neighborMap = neighbors ?? computeWordNeighborMap(tokens);

  for (let i = 0; i < len; i += 1) {
    const tok = tokens[i];
    if (!tok || tok.kind !== 'sym') continue;

    const ch = tok.t;
    const type = modifierTypeForSymbol(ch);
    const family = classifyRelation(type);

    if (mode === 'standalone' || mode === 'both') {
      addEdge(tok, tok, {
        type: 'self:symbol',
        family: classifyRelation('self:symbol'),
        w: 0.01,
        meta: { ch },
      });
    }

    if (mode === 'paired' || mode === 'both') {
      const neighbor = neighborMap[i];
      const left = neighbor?.leftWordIndex ?? -1;
      const right = neighbor?.rightWordIndex ?? len;

      if (LEFT_BIND.has(ch) && left >= 0) {
        addEdge(tokens[left], tok, { type, family, w: weightScale, meta: { ch } });
      } else if (RIGHT_BIND.has(ch) && right < len) {
        addEdge(tok, tokens[right], { type, family, w: weightScale, meta: { ch } });
      } else if (CLOSE_BIND.has(ch) && left >= 0) {
        addEdge(tok, tokens[left], { type, family, w: weightScale * 0.9, meta: { ch } });
      } else {
        const target = left >= 0 ? tokens[left] : right < len ? tokens[right] : null;
        if (target) {
          addEdge(target, tok, { type, family, w: weightScale * 0.8, meta: { ch } });
        }
      }
    }
  }
}
