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

export interface AvatarProfile {
  name: string;
}

export interface UserAvatarState {
  entries: AvatarInteraction[];
  metrics: AvatarMetrics;
  profile: AvatarProfile;
}

export interface UserAvatarStore {
  getState(): UserAvatarState;
  recordInteraction(entry: Partial<Omit<AvatarInteraction, 'id'>> & { prompt: string; tokens?: string[]; }): AvatarInteraction;
  updateInteraction(id: string, updates: Partial<Omit<AvatarInteraction, 'id' | 'timestamp'>>): AvatarInteraction | null;
  updateProfile(profile: Partial<AvatarProfile>, options?: { notify?: boolean }): AvatarProfile;
  replace(state: Partial<UserAvatarState>, options?: { notify?: boolean }): UserAvatarState;
  reset(options?: { notify?: boolean; clearProfile?: boolean }): void;
  subscribe(listener: (state: UserAvatarState) => void): () => void;
}

interface InternalState extends UserAvatarState {
  listeners: Set<(state: UserAvatarState) => void>;
}

const STORAGE_KEY = 'hlsf-user-avatar-v1';

function defaultAvatarProfile(): AvatarProfile {
  return { name: '' };
}

function normalizeProfile(raw: unknown): AvatarProfile {
  const profile = defaultAvatarProfile();
  if (!raw || typeof raw !== 'object') {
    return profile;
  }
  const name = (raw as { name?: unknown }).name;
  if (typeof name === 'string') {
    profile.name = name.trim();
  }
  return profile;
}

function normalizeEntries(entries: unknown): AvatarInteraction[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;
      const prompt = typeof (entry as any).prompt === 'string' ? (entry as any).prompt : '';
      if (!prompt) return null;
      const tokens = Array.isArray((entry as any).tokens)
        ? (entry as any).tokens.map((token: unknown) => (typeof token === 'string' ? token : '')).filter(Boolean)
        : [];
      const status: AvatarStatus = (entry as any).status === 'completed'
        || (entry as any).status === 'processing'
        || (entry as any).status === 'failed'
        ? (entry as any).status
        : 'idle';
      const timestamp = Number.isFinite((entry as any).timestamp) ? Number((entry as any).timestamp) : Date.now();
      const responseSummary = typeof (entry as any).responseSummary === 'string' ? (entry as any).responseSummary : undefined;
      const newTokenCount = Number.isFinite((entry as any).newTokenCount) ? Number((entry as any).newTokenCount) : undefined;
      const normalized: AvatarInteraction = {
        id: typeof (entry as any).id === 'string' && (entry as any).id ? (entry as any).id : cryptoSafeUuid(),
        prompt,
        tokens,
        status,
        timestamp,
        responseSummary,
        newTokenCount,
      };
      return normalized;
    })
    .filter((entry): entry is AvatarInteraction => Boolean(entry));
}

function loadPersistedState(): { entries: AvatarInteraction[]; profile: AvatarProfile } {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return { entries: [], profile: defaultAvatarProfile() };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { entries: [], profile: defaultAvatarProfile() };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { entries: normalizeEntries(parsed), profile: defaultAvatarProfile() };
    }
    if (parsed && typeof parsed === 'object') {
      const entries = normalizeEntries((parsed as any).entries);
      const profile = normalizeProfile((parsed as any).profile);
      return { entries, profile };
    }
  } catch (error) {
    console.warn('Unable to read persisted UserAvatar state:', error);
  }
  return { entries: [], profile: defaultAvatarProfile() };
}

function cryptoSafeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function persistState(state: InternalState): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    const payload = {
      version: 2,
      entries: state.entries,
      profile: state.profile,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
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
    profile: { ...state.profile },
  };
}

export function initializeUserAvatarStore(): UserAvatarStore {
  const initialState = loadPersistedState();
  const sortedEntries = [...initialState.entries].sort((a, b) => a.timestamp - b.timestamp);

  const state: InternalState = {
    entries: sortedEntries,
    metrics: recalcMetrics(sortedEntries),
    profile: initialState.profile,
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
    persistState(state);
    notify();
  }

  function recordInteraction(
    entry: Partial<Omit<AvatarInteraction, 'id'>> & { prompt: string; tokens?: string[] },
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

  function updateProfile(profile: Partial<AvatarProfile>, options?: { notify?: boolean }): AvatarProfile {
    const shouldNotify = options?.notify !== false;
    if (profile && typeof profile === 'object') {
      if (profile.name !== undefined) {
        state.profile.name = typeof profile.name === 'string' ? profile.name.trim() : state.profile.name;
      }
      persistState(state);
      if (shouldNotify) {
        notify();
      }
    }
    return { ...state.profile };
  }

  function replace(nextState: Partial<UserAvatarState>, options?: { notify?: boolean }): UserAvatarState {
    const shouldNotify = options?.notify !== false;
    const nextEntries = normalizeEntries(nextState?.entries);
    state.entries = nextEntries.sort((a, b) => a.timestamp - b.timestamp);
    state.profile = normalizeProfile(nextState?.profile);
    state.metrics = recalcMetrics(state.entries);
    persistState(state);
    if (shouldNotify) {
      notify();
    }
    return cloneState(state);
  }

  function reset(options?: { notify?: boolean; clearProfile?: boolean }): void {
    const shouldNotify = options?.notify !== false;
    const clearProfile = options?.clearProfile === true;
    state.entries.length = 0;
    if (clearProfile) {
      state.profile = defaultAvatarProfile();
    }
    state.metrics = recalcMetrics(state.entries);
    if (clearProfile) {
      clearPersistedEntries();
    } else {
      persistState(state);
    }
    if (shouldNotify) {
      notify();
    }
  }

  return {
    getState,
    recordInteraction,
    updateInteraction,
    updateProfile,
    replace,
    reset,
    subscribe,
  };
}
