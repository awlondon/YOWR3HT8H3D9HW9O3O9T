export class AgentScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly getIntervalMs: () => number,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    const loop = async () => {
      if (this.paused) {
        this.timer = null;
        return;
      }
      const visibilityHidden = typeof document !== 'undefined' && document?.hidden === true;
      if (visibilityHidden) {
        const hiddenInterval = Math.max(this.computeInterval(2), 10_000);
        this.timer = setTimeout(loop, hiddenInterval);
        return;
      }
      try {
        await this.tick();
      } catch (err) {
        console.warn('[agent] scheduler tick failed:', err);
      }
      this.timer = setTimeout(loop, this.computeInterval());
    };
    this.timer = setTimeout(loop, this.computeInterval());
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.timer === null) {
      this.start();
    }
  }

  isRunning(): boolean {
    return this.timer !== null && !this.paused;
  }

  private computeInterval(multiplier = 1): number {
    const base = Math.max(0, Number(this.getIntervalMs()) || 0);
    const interval = Math.max(base, 1000);
    return Math.max(1000, Math.floor(interval * multiplier));
  }
}
