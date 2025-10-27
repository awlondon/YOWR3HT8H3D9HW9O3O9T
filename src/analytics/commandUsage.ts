export interface CommandUsageRecord {
  command: string;
  membership: string;
  args: string[];
  timestamp: string;
  source: 'dispatch' | 'handler';
}

export type CommandUsageSink = (record: CommandUsageRecord) => void;

const history: CommandUsageRecord[] = [];
const MAX_HISTORY = 200;
const sinks = new Set<CommandUsageSink>();
const counts = new Map<string, number>();

function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed.toLowerCase() : `/${trimmed.toLowerCase()}`;
}

function getGlobalCommandStore(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  const root = ((window as any).CognitionEngine = (window as any).CognitionEngine || {});
  root.commandUsage = root.commandUsage || {};
  return root.commandUsage as Record<string, unknown>;
}

export function recordCommandUsage(event: {
  command: string;
  membership: string;
  args?: string[];
  source?: 'dispatch' | 'handler';
  timestamp?: string;
}): void {
  const normalized = normalizeCommand(event.command);
  if (!normalized) return;

  const timestamp = event.timestamp || new Date().toISOString();
  const payload: CommandUsageRecord = {
    command: normalized,
    membership: event.membership || 'unknown',
    args: Array.isArray(event.args) ? event.args : [],
    timestamp,
    source: event.source || 'handler',
  };

  history.push(payload);
  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  counts.set(normalized, (counts.get(normalized) || 0) + 1);

  const globalStore = getGlobalCommandStore();
  if (globalStore) {
    (globalStore as any).history = history.slice();
    (globalStore as any).counts = Object.fromEntries(counts.entries());
    (globalStore as any).last = payload;
  }

  for (const sink of sinks) {
    try {
      sink(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Command usage sink failed:', err);
    }
  }
}

export function registerCommandUsageSink(sink: CommandUsageSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function getCommandUsageHistory(): CommandUsageRecord[] {
  return history.slice();
}

export function getCommandUsageCounts(): Record<string, number> {
  return Object.fromEntries(counts.entries());
}

/**
 * Resets in-memory command usage analytics. This is primarily exposed for the
 * unit test suite so that each test can run in isolation without depending on
 * global state accumulated by previous runs.
 */
export function resetCommandUsageStateForTest(): void {
  history.length = 0;
  counts.clear();
  sinks.clear();

  const store = getGlobalCommandStore();
  if (store) {
    delete (store as any).history;
    delete (store as any).counts;
    delete (store as any).last;
  }
}
