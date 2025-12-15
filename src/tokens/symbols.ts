import symbolCategories from '../../hlsf_db_tools/data/symbols.json';

export const SYMBOLS = Object.fromEntries(
  Object.entries(symbolCategories).map(([key, symbols]) => [key, new Set(symbols)])
) as Record<string, Set<string>>;

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
