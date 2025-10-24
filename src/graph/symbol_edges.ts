import type { Token } from '../tokens/tokenize';

export const LEFT_BIND = new Set(['!', '?', '.', ',', ':', ';']);
export const RIGHT_BIND = new Set(['(', '[', '{', '“', '‘']);
export const CLOSE_BIND = new Set([')', ']', '}', '”', '’']);

export interface EdgeMeta {
  type: string;
  w?: number;
  meta?: Record<string, unknown>;
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
  mode: 'paired' | 'standalone' | 'both' = 'paired'
) {
  const len = tokens.length;
  for (let i = 0; i < len; i += 1) {
    const tok = tokens[i];
    if (!tok || tok.kind !== 'sym') continue;

    const ch = tok.t;
    const type = modifierTypeForSymbol(ch);

    if (mode === 'standalone' || mode === 'both') {
      addEdge(tok, tok, { type: 'self:symbol', w: 0.01, meta: { ch } });
    }

    if (mode === 'paired' || mode === 'both') {
      let left = i - 1;
      while (left >= 0 && tokens[left]?.kind !== 'word') left -= 1;
      let right = i + 1;
      while (right < len && tokens[right]?.kind !== 'word') right += 1;

      if (LEFT_BIND.has(ch) && left >= 0) {
        addEdge(tokens[left], tok, { type, w: weightScale, meta: { ch } });
      } else if (RIGHT_BIND.has(ch) && right < len) {
        addEdge(tok, tokens[right], { type, w: weightScale, meta: { ch } });
      } else if (CLOSE_BIND.has(ch) && left >= 0) {
        addEdge(tok, tokens[left], { type, w: weightScale * 0.9, meta: { ch } });
      } else {
        const target = left >= 0 ? tokens[left] : right < len ? tokens[right] : null;
        if (target) {
          addEdge(target, tok, { type, w: weightScale * 0.8, meta: { ch } });
        }
      }
    }
  }
}
