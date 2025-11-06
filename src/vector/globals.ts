type TokenObservedHandler = (payload: { id: number; text: string }) => void;
type GraphUpdatedHandler = (payload: { changedTokenIds: number[] }) => void;

const TOKEN_OBSERVER_KEY = '__HLSF_VECTOR_TOKEN_OBSERVER__';
const GRAPH_OBSERVER_KEY = '__HLSF_VECTOR_GRAPH_OBSERVER__';

declare global {
  interface Window {
    [TOKEN_OBSERVER_KEY]?: TokenObservedHandler;
    [GRAPH_OBSERVER_KEY]?: GraphUpdatedHandler;
  }
  interface Global {
    [TOKEN_OBSERVER_KEY]?: TokenObservedHandler;
    [GRAPH_OBSERVER_KEY]?: GraphUpdatedHandler;
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface WorkerGlobalScope {
    [TOKEN_OBSERVER_KEY]?: TokenObservedHandler;
    [GRAPH_OBSERVER_KEY]?: GraphUpdatedHandler;
  }
}

function getHost(): Record<string, unknown> {
  if (typeof globalThis !== 'undefined') {
    return globalThis as unknown as Record<string, unknown>;
  }
  return {};
}

export function registerTokenObserver(handler: TokenObservedHandler | null): void {
  const host = getHost();
  if (handler) {
    host[TOKEN_OBSERVER_KEY] = handler;
  } else {
    delete host[TOKEN_OBSERVER_KEY];
  }
}

export function notifyTokenObserved(id: number, text: string): void {
  const host = getHost();
  const handler = host[TOKEN_OBSERVER_KEY];
  if (typeof handler === 'function') {
    (handler as TokenObservedHandler)({ id, text });
  }
}

export function registerGraphObserver(handler: GraphUpdatedHandler | null): void {
  const host = getHost();
  if (handler) {
    host[GRAPH_OBSERVER_KEY] = handler;
  } else {
    delete host[GRAPH_OBSERVER_KEY];
  }
}

export function notifyGraphUpdated(changedTokenIds: number[]): void {
  const host = getHost();
  const handler = host[GRAPH_OBSERVER_KEY];
  if (typeof handler === 'function') {
    (handler as GraphUpdatedHandler)({ changedTokenIds });
  }
}
