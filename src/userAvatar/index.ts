export type AvatarStatus = 'idle' | 'processing' | 'completed' | 'failed';

export interface AvatarInteraction {
  id: string;
  prompt: string;
  timestamp: number;
  tokens: string[];
  status: AvatarStatus;
  responseSummary?: string;
  newTokenCount?: number;
}

export interface AvatarMetrics {
  totalInteractions: number;
  totalTokens: number;
  uniqueTokenCount: number;
  adjacencyBloomEvents: number;
  lastUpdated: number | null;
}

export interface UserAvatarState {
  entries: AvatarInteraction[];
  metrics: AvatarMetrics;
}

export interface UserAvatarStore {
  getState(): UserAvatarState;
  recordInteraction(entry: Partial<Omit<AvatarInteraction, 'id' | 'timestamp'>> & { prompt: string; tokens?: string[]; }): AvatarInteraction;
  updateInteraction(id: string, updates: Partial<Omit<AvatarInteraction, 'id' | 'timestamp'>>): AvatarInteraction | null;
  reset(options?: { notify?: boolean }): void;
  subscribe(listener: (state: UserAvatarState) => void): () => void;
}

interface InternalState extends UserAvatarState {
  listeners: Set<(state: UserAvatarState) => void>;
}

const STORAGE_KEY = 'hlsf-user-avatar-v1';

function safeParse(raw: string | null): AvatarInteraction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(entry => {
        if (!entry || typeof entry !== 'object') return null;
        const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
        if (!prompt) return null;
        const tokens = Array.isArray(entry.tokens)
          ? entry.tokens.map(token => (typeof token === 'string' ? token : '')).filter(Boolean)
          : [];
        const status: AvatarStatus = entry.status === 'completed'
          || entry.status === 'processing'
          || entry.status === 'failed'
          ? entry.status
          : 'idle';
        const timestamp = Number.isFinite(entry.timestamp) ? Number(entry.timestamp) : Date.now();
        const responseSummary = typeof entry.responseSummary === 'string' ? entry.responseSummary : undefined;
        const newTokenCount = Number.isFinite(entry.newTokenCount) ? Number(entry.newTokenCount) : undefined;
        return {
          id: typeof entry.id === 'string' && entry.id ? entry.id : cryptoSafeUuid(),
          prompt,
          tokens,
          status,
          timestamp,
          responseSummary,
          newTokenCount,
        } satisfies AvatarInteraction;
      })
      .filter((entry): entry is AvatarInteraction => Boolean(entry));
  } catch {
    return [];
  }
}

function cryptoSafeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function persistEntries(entries: AvatarInteraction[]): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn('Unable to persist UserAvatar entries:', error);
  }
}

function clearPersistedEntries(): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Unable to clear persisted UserAvatar entries:', error);
  }
}

function recalcMetrics(entries: AvatarInteraction[]): AvatarMetrics {
  const seen = new Set<string>();
  let totalTokens = 0;
  let bloomEvents = 0;
  let latest = 0;

  for (const entry of entries) {
    const tokens = Array.isArray(entry.tokens) ? entry.tokens : [];
    let newTokenCount = 0;
    for (const rawToken of tokens) {
      if (typeof rawToken !== 'string' || !rawToken) continue;
      const key = rawToken.toLowerCase();
      totalTokens += 1;
      if (!seen.has(key)) {
        seen.add(key);
        bloomEvents += 1;
        newTokenCount += 1;
      }
    }
    entry.newTokenCount = newTokenCount;
    if (Number.isFinite(entry.timestamp) && entry.timestamp > latest) {
      latest = entry.timestamp;
    }
  }

  return {
    totalInteractions: entries.length,
    totalTokens,
    uniqueTokenCount: seen.size,
    adjacencyBloomEvents: bloomEvents,
    lastUpdated: entries.length ? latest : null,
  } satisfies AvatarMetrics;
}

function cloneState(state: InternalState): UserAvatarState {
  return {
    entries: state.entries.map(entry => ({ ...entry })),
    metrics: { ...state.metrics },
  };
}

export function initializeUserAvatarStore(): UserAvatarStore {
  const initialEntries = (() => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return [];
    return safeParse(window.localStorage.getItem(STORAGE_KEY));
  })();

  const state: InternalState = {
    entries: [...initialEntries].sort((a, b) => a.timestamp - b.timestamp),
    metrics: recalcMetrics(initialEntries),
    listeners: new Set(),
  };

  function notify(): void {
    const snapshot = cloneState(state);
    for (const listener of state.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('UserAvatar subscriber error:', error);
      }
    }
  }

  function commit(): void {
    state.metrics = recalcMetrics(state.entries);
    persistEntries(state.entries);
    notify();
  }

  function recordInteraction(
    entry: Partial<Omit<AvatarInteraction, 'id' | 'timestamp'>> & { prompt: string; tokens?: string[] },
  ): AvatarInteraction {
    const now = Date.now();
    const normalizedTokens = Array.isArray(entry.tokens)
      ? entry.tokens.map(token => (typeof token === 'string' ? token : '')).filter(Boolean)
      : [];
    const record: AvatarInteraction = {
      id: cryptoSafeUuid(),
      prompt: entry.prompt,
      timestamp: Number.isFinite(entry.timestamp) ? Number(entry.timestamp) : now,
      tokens: normalizedTokens,
      status: entry.status ?? 'idle',
      responseSummary: entry.responseSummary,
      newTokenCount: 0,
    };

    state.entries.push(record);
    state.entries.sort((a, b) => a.timestamp - b.timestamp);
    commit();
    return { ...record };
  }

  function updateInteraction(
    id: string,
    updates: Partial<Omit<AvatarInteraction, 'id' | 'timestamp'>>,
  ): AvatarInteraction | null {
    if (!id) return null;
    const target = state.entries.find(entry => entry.id === id);
    if (!target) return null;

    if (updates.prompt && typeof updates.prompt === 'string') {
      target.prompt = updates.prompt;
    }
    if (Array.isArray(updates.tokens)) {
      target.tokens = updates.tokens.map(token => (typeof token === 'string' ? token : '')).filter(Boolean);
    }
    if (updates.status && (updates.status === 'completed' || updates.status === 'processing' || updates.status === 'failed' || updates.status === 'idle')) {
      target.status = updates.status;
    }
    if (typeof updates.responseSummary === 'string') {
      target.responseSummary = updates.responseSummary;
    }

    commit();
    return { ...target };
  }

  function getState(): UserAvatarState {
    return cloneState(state);
  }

  function subscribe(listener: (state: UserAvatarState) => void): () => void {
    if (typeof listener !== 'function') {
      return () => {};
    }
    state.listeners.add(listener);
    listener(getState());
    return () => {
      state.listeners.delete(listener);
    };
  }

  function reset(options?: { notify?: boolean }): void {
    const shouldNotify = options?.notify !== false;
    state.entries.length = 0;
    state.metrics = recalcMetrics(state.entries);
    clearPersistedEntries();
    if (shouldNotify) {
      notify();
    }
  }

  return {
    getState,
    recordInteraction,
    updateInteraction,
    reset,
    subscribe,
  };
}
