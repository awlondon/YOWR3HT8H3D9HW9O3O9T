import { AgentScheduler } from './scheduler';
import type {
  AgentConfig,
  AgentContext,
  AgentKernelHooks,
  AgentPlan,
  AgentStatus,
} from './types';
import { graphPlan } from './strategies/graphPlan';
import { selfQueryLLM } from './strategies/selfQueryLLM';
import type { AgentTelemetryEvent } from './types';

function clampInterval(cfg: AgentConfig, backoffMultiplier: number): number {
  const base = Math.max(1000, Number(cfg.intervalMs) || 15000);
  const energy = cfg.energy || {};
  const min = Math.max(1000, Number(energy.minIntervalMs ?? base));
  const max = Math.max(min, Number(energy.maxIntervalMs ?? Math.max(base, min)));
  const interval = Math.min(Math.max(base, min), max) * Math.max(1, backoffMultiplier);
  return Math.max(min, Math.min(interval, max));
}

function mergeConfig(existing: AgentConfig, patch: Partial<AgentConfig>): AgentConfig {
  const next: AgentConfig = {
    ...existing,
    ...patch,
    energy: { ...existing.energy, ...(patch.energy ?? {}) },
  };
  return next;
}

export class AgentKernel {
  private mode: AgentStatus['mode'] = 'off';
  private cfg: AgentConfig;
  private readonly scheduler: AgentScheduler;
  private readonly hooks: AgentKernelHooks;
  private backoff = 1;
  private lastRun: number | null = null;
  private runTimestamps: number[] = [];

  constructor(initial: AgentConfig, private readonly ctxFactory: () => AgentContext, hooks: AgentKernelHooks = {}) {
    this.cfg = mergeConfig(initial, {});
    this.hooks = hooks;
    this.mode = this.cfg.enabled ? 'idle' : 'off';
    this.scheduler = new AgentScheduler(() => this.tick(), () => clampInterval(this.cfg, this.backoff));
  }

  get status(): AgentStatus {
    return {
      enabled: this.cfg.enabled,
      mode: this.mode,
      cfg: mergeConfig(this.cfg, {}),
      lastRunAt: this.lastRun,
    };
  }

  start(): void {
    this.cfg.enabled = true;
    this.mode = 'idle';
    this.scheduler.start();
    this.emitConfig();
  }

  stop(): void {
    this.scheduler.stop();
    this.cfg.enabled = false;
    this.mode = 'off';
    this.emitConfig();
  }

  pause(): void {
    this.scheduler.pause();
  }

  resume(): void {
    this.scheduler.resume();
  }

  isRunning(): boolean {
    return this.scheduler.isRunning();
  }

  once(): Promise<void> {
    return this.tick();
  }

  updateConfig(patch: Partial<AgentConfig>): void {
    this.cfg = mergeConfig(this.cfg, patch);
    if (this.cfg.enabled && !this.scheduler.isRunning()) {
      this.scheduler.start();
      this.mode = 'idle';
    }
    this.emitConfig();
  }

  private emit(event: AgentTelemetryEvent): void {
    if (typeof this.hooks.recordEvent === 'function') {
      this.hooks.recordEvent(event);
    }
  }

  private emitConfig(): void {
    if (typeof this.hooks.onConfigChange === 'function') {
      this.hooks.onConfigChange(mergeConfig(this.cfg, {}));
    }
  }

  private pruneHistory(now: number): void {
    const windowMs = 60 * 60 * 1000;
    this.runTimestamps = this.runTimestamps.filter(ts => now - ts < windowMs);
  }

  private withinRunBudget(now: number): boolean {
    const { maxRunsPerHour, minIntervalMs } = this.cfg.energy || {};
    if (typeof minIntervalMs === 'number' && minIntervalMs > 0 && this.lastRun != null) {
      if (now - this.lastRun < minIntervalMs) {
        return false;
      }
    }
    if (typeof maxRunsPerHour === 'number' && maxRunsPerHour > 0) {
      this.pruneHistory(now);
      if (this.runTimestamps.length >= maxRunsPerHour) {
        return false;
      }
    }
    return true;
  }

  private async tick(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.mode === 'thinking') return;

    const now = Date.now();
    if (!this.withinRunBudget(now)) {
      this.emit({
        type: 'skipped',
        timestamp: new Date(now).toISOString(),
        mode: this.mode,
        strategy: this.cfg.strategy,
        message: 'Rate limit active',
      });
      return;
    }

    this.mode = 'thinking';
    const ctx = this.ctxFactory();
    const startTime = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

    try {
      const plan = await this.plan(ctx);
      if (!plan) {
        ctx.log('No plan generated.');
        this.emit({
          type: 'no_plan',
          timestamp: new Date(now).toISOString(),
          mode: 'idle',
          strategy: this.cfg.strategy,
        });
        this.backoff = Math.min(this.backoff * 1.5, 6);
        return;
      }

      this.emit({
        type: 'plan_generated',
        timestamp: new Date(now).toISOString(),
        mode: 'thinking',
        strategy: this.cfg.strategy,
        meta: {
          promptLength: plan.prompt.length,
          rationale: plan.rationale,
        },
      });

      if (plan.rationale) {
        ctx.log(`Rationale: ${plan.rationale}`);
      }

      if (this.cfg.autoExecute) {
        const command = plan.prompt;
        if (this.cfg.echoCommands) {
          ctx.log(`→ ${command}`);
        }
        await ctx.runCommand(command);
        const duration = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime;
        this.emit({
          type: 'executed',
          timestamp: new Date().toISOString(),
          mode: 'idle',
          strategy: this.cfg.strategy,
          meta: {
            durationMs: Math.max(0, Math.round(duration)),
          },
        });
      } else {
        ctx.log(`Suggestion: ${plan.prompt}`);
      }

      this.lastRun = now;
      this.runTimestamps.push(now);
      this.backoff = 1;
    } catch (error: any) {
      const message = error?.message ?? String(error ?? 'Unknown error');
      ctx.log(`Error: ${message}`);
      this.emit({
        type: 'error',
        timestamp: new Date().toISOString(),
        mode: 'idle',
        strategy: this.cfg.strategy,
        message,
      });
      this.backoff = Math.min(this.backoff * 2, 8);
      this.mode = 'idle';
      throw error;
    } finally {
      this.mode = 'idle';
    }
  }

  private async plan(ctx: AgentContext): Promise<AgentPlan | null> {
    switch (this.cfg.strategy) {
      case 'selfQueryLLM':
        return (await selfQueryLLM(ctx)) ?? (await graphPlan(ctx));
      case 'graphPlan':
      default:
        return graphPlan(ctx);
    }
  }
}
