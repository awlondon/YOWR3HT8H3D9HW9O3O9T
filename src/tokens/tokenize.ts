import { symbolCategory } from './symbols.js';

export interface Token {
  t: string;
  kind: 'sym' | 'word';
  cat?: string | null;
  i: number;
  n: number;
}

export interface WordNeighborIndex {
  leftWordIndex: number;
  rightWordIndex: number;
}

export interface TokenizeOptions {
  keepOffsets?: boolean;
}

export function tokenizeWithSymbols(source: string, options: TokenizeOptions = {}): Token[] {
  const text = typeof source === 'string' ? source : '';
  if (!text) return [];

  const opts = options || {};
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const cat = symbolCategory(ch);
    if (cat) {
      out.push({ t: ch, kind: 'sym', cat, i, n: 1 });
      i += 1;
      continue;
    }

    const isWord = /[A-Za-z0-9_]/.test(ch);
    if (isWord) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) {
        i += 1;
      }
      const slice = text.slice(start, i);
      out.push({ t: slice, kind: 'word', i: start, n: slice.length });
      continue;
    }

    i += 1;
  }
  if (!opts.keepOffsets) {
    return out.map(token => ({ ...token, i: -1 }));
  }
  return out;
}

export function computeWordNeighborMap(tokens: Token[]): WordNeighborIndex[] {
  const neighbors: WordNeighborIndex[] = tokens.map(() => ({ leftWordIndex: -1, rightWordIndex: -1 }));

  let lastWord = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    neighbors[i].leftWordIndex = lastWord;
    if (tokens[i]?.kind === 'word') {
      lastWord = i;
    }
  }

  let nextWord = -1;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    neighbors[i].rightWordIndex = nextWord;
    if (tokens[i]?.kind === 'word') {
      nextWord = i;
    }
  }

  return neighbors;
}

export function tokenizeWords(source: string): Token[] {
  const text = typeof source === 'string' ? source : '';
  if (!text) return [];
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/[A-Za-z0-9_]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i += 1;
      const slice = text.slice(start, i);
      out.push({ t: slice, kind: 'word', i: start, n: slice.length });
      continue;
    }
    i += 1;
  }
  return out;
}
