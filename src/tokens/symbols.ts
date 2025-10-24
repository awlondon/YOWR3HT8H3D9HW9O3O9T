export const SYMBOLS = {
  emph: new Set(['!', '¡']),
  query: new Set(['?', '¿']),
  stop: new Set(['.', '…']),
  comma: new Set([',']),
  sep: new Set([':', ';', '—', '-', '–']),
  quote: new Set(["\"", '“', '”', '‘', '’', "'"]),
  parenOpen: new Set(['(', '[', '{']),
  parenClose: new Set([')', ']', '}']),
  math: new Set(['+', '−', '-', '×', '*', '÷', '/', '=', '%', '^']),
  path: new Set(['/', '\\', '|']),
  at: new Set(['@', '#', '$']),
  other: new Set(['<', '>', '~', '_', '&']),
} as const;

type SymbolCategoryKey = keyof typeof SYMBOLS;

type CategoryLookup = { key: SymbolCategoryKey; set: Set<string> };
const CATEGORY_LIST: CategoryLookup[] = Object.entries(SYMBOLS).map(([key, set]) => ({
  key: key as SymbolCategoryKey,
  set,
}));

export function symbolCategory(ch: string): SymbolCategoryKey | null {
  for (const entry of CATEGORY_LIST) {
    if (entry.set.has(ch)) {
      return entry.key;
    }
  }
  return null;
}
