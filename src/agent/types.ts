export type AgentMode = 'off' | 'idle' | 'thinking';

export type AgentEnergyPolicy = {
  maxTokensPerHour?: number;
  maxRunsPerHour?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
};

export type AgentConfig = {
  enabled: boolean;
  intervalMs: number;
  energy: AgentEnergyPolicy;
  strategy: 'graphPlan' | 'selfQueryLLM';
  echoCommands: boolean;
  autoExecute: boolean;
};

export type AgentPlan = {
  prompt: string;
  rationale?: string;
  meta?: Record<string, unknown>;
};

export type AgentContext = {
  now: number;
  state: {
    prompt: string;
    graph: unknown;
    metrics: Record<string, number>;
    history: string[];
  };
  runCommand: (raw: string) => Promise<void>;
  log: (line: string) => void;
  llm?: (input: string) => Promise<string>;
};

export type AgentTelemetryEventType =
  | 'plan_generated'
  | 'no_plan'
  | 'executed'
  | 'error'
  | 'skipped';

export type AgentTelemetryEvent = {
  type: AgentTelemetryEventType;
  timestamp: string;
  mode: AgentMode;
  strategy: AgentConfig['strategy'];
  message?: string;
  meta?: Record<string, unknown>;
};

export type AgentStatus = {
  enabled: boolean;
  mode: AgentMode;
  cfg: AgentConfig;
  lastRunAt: number | null;
};

export type AgentKernelHooks = {
  onConfigChange?: (cfg: AgentConfig) => void;
  recordEvent?: (event: AgentTelemetryEvent) => void;
};
