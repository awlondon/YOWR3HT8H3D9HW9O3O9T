import type { AgentTelemetryEvent } from '../agent/types';

const MAX_HISTORY = 100;
const history: AgentTelemetryEvent[] = [];
const sinks = new Set<(event: AgentTelemetryEvent) => void>();

function getGlobalAgentStore(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  const root = ((window as any).CognitionEngine = (window as any).CognitionEngine || {});
  const telemetry = (root.telemetry = root.telemetry || {});
  telemetry.agent = telemetry.agent || {};
  return telemetry.agent as Record<string, unknown>;
}

export function recordAgentTelemetryEvent(event: AgentTelemetryEvent): void {
  const copy: AgentTelemetryEvent = {
    ...event,
    meta: event.meta ? { ...event.meta } : undefined,
  };
  history.push(copy);
  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  const store = getGlobalAgentStore();
  if (store) {
    store.history = history.slice();
    store.lastEvent = copy;
  }

  for (const sink of sinks) {
    try {
      sink(copy);
    } catch (err) {
      console.warn('Agent telemetry sink failed:', err);
    }
  }
}

export function registerAgentTelemetrySink(sink: (event: AgentTelemetryEvent) => void): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function getAgentTelemetryHistory(): AgentTelemetryEvent[] {
  return history.slice();
}

export function resetAgentTelemetryForTest(): void {
  history.length = 0;
  sinks.clear();
  const store = getGlobalAgentStore();
  if (store) {
    delete store.history;
    delete store.lastEvent;
  }
}
