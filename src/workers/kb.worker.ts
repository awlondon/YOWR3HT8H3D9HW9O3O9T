import { KBStore } from '../kb';
import { IdbAdapter } from '../kb/adapters/idb';
import { MemoryAdapter } from '../kb/adapters/memory';

type Message = {
  id: number;
  fn: keyof KBStore | 'stats' | 'gc' | 'compact' | 'bulkImport';
  args?: any[];
};

declare const self: DedicatedWorkerGlobalScope;

function createStore(): KBStore {
  try {
    if (typeof indexedDB !== 'undefined') {
      return new KBStore(new IdbAdapter());
    }
  } catch {
    // fall through
  }
  return new KBStore(new MemoryAdapter());
}

const store = createStore();
const ready = store.init();

self.addEventListener('message', async (event: MessageEvent<Message>) => {
  const { id, fn, args = [] } = event.data;
  try {
    await ready;
    const target = (store as any)[fn];
    if (typeof target !== 'function') {
      throw new Error(`Unknown KB method: ${String(fn)}`);
    }
    const result = await target.apply(store, args);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
