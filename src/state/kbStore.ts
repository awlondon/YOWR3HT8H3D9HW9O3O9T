import { KBStore } from '../kb';
import { IdbAdapter } from '../kb/adapters/idb';
import { MemoryAdapter } from '../kb/adapters/memory';

let store: KBStore | null = null;
let initPromise: Promise<void> | null = null;

function selectAdapter() {
  if (typeof indexedDB !== 'undefined') {
    return new IdbAdapter();
  }
  return new MemoryAdapter();
}

export function getKBStore(): KBStore {
  if (!store) {
    store = new KBStore(selectAdapter());
    initPromise = store.init();
  }
  return store;
}

export async function ensureKBReady(): Promise<KBStore> {
  const kb = getKBStore();
  if (initPromise) await initPromise;
  return kb;
}
