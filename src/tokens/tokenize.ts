import { symbolCategory } from './symbols';

export interface Token {
  t: string;
  kind: 'sym' | 'word';
  cat?: string | null;
  i: number;
  n: number;
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
