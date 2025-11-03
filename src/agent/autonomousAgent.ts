import type {
  LocalHlsfAdjacencySummary,
  LocalHlsfAdjacencyTokenSummary,
} from '../controllers/sessionManager';
import type { VectorSemanticStore } from '../engine/vectorSemantics';

export interface AutonomousAgentOptions {
  intervalMs?: number;
  runPrompt: (prompt: string, source?: string) => Promise<void>;
  getContext: () => {
    isProcessing: boolean;
    lastAdjacency: LocalHlsfAdjacencySummary | null;
  };
  log: (message: string, level?: 'info' | 'warning' | 'error') => void;
  vectorStore: VectorSemanticStore;
}

export class AutonomousAgent {
  private readonly options: AutonomousAgentOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private readonly intervalMs: number;

  constructor(options: AutonomousAgentOptions) {
    this.options = options;
    this.intervalMs = Math.max(15000, options.intervalMs ?? 45000);
  }

  isRunning(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.options.log('🤖 Autonomous agent engaged. Initiating periodic reflections.');
    this.scheduleThink(2000);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.options.log('🛑 Autonomous agent paused.');
  }

  async think(): Promise<void> {
    if (!this.active) return;
    const context = this.options.getContext();
    if (context.isProcessing) {
      this.scheduleThink(this.intervalMs);
      return;
    }

    const summary = context.lastAdjacency;
    if (!summary || !Array.isArray(summary.summary) || summary.summary.length === 0) {
      this.options.log('🤔 Agent awaiting richer adjacency context before acting.', 'warning');
      this.scheduleThink(this.intervalMs);
      return;
    }

    const focus = this.selectFocus(summary.summary);
    if (!focus) {
      this.scheduleThink(this.intervalMs);
      return;
    }

    const prompt = this.composePrompt(focus, summary);
    try {
      await this.options.runPrompt(prompt, 'agent');
      this.options.log(`🧠 Agent proposed: ${prompt}`);
    } catch (error) {
      this.options.log(`⚠️ Agent prompt failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.scheduleThink(this.intervalMs);
    }
  }

  private scheduleThink(delay: number): void {
    if (!this.active) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.think(), Math.max(1000, delay));
  }

  private selectFocus(entries: LocalHlsfAdjacencyTokenSummary[]): LocalHlsfAdjacencyTokenSummary | null {
    const enriched = entries
      .map(entry => ({
        entry,
        embedding: this.options.vectorStore.get(entry.token),
      }))
      .sort((a, b) => {
        const scoreA = this.scoreEntry(a.entry, a.embedding?.vector ?? []);
        const scoreB = this.scoreEntry(b.entry, b.embedding?.vector ?? []);
        return scoreB - scoreA;
      });
    return enriched.length ? enriched[0].entry : null;
  }

  private scoreEntry(entry: LocalHlsfAdjacencyTokenSummary, vector: number[]): number {
    const base = entry.attention + entry.totalRelationships;
    const vectorMagnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return base + vectorMagnitude;
  }

  private composePrompt(
    focus: LocalHlsfAdjacencyTokenSummary,
    summary: LocalHlsfAdjacencySummary,
  ): string {
    const relations = Object.entries(focus.relationships)
      .map(([relation, edges]) => `${relation}: ${edges.slice(0, 3).map(edge => edge.token).join(', ')}`)
      .slice(0, 3)
      .join(' | ');
    const context = summary.summary
      .slice(0, 3)
      .filter(entry => entry.token !== focus.token)
      .map(entry => entry.token)
      .join(', ');
    const focusDescriptor = relations ? `${focus.token} → ${relations}` : focus.token;
    const contextDescriptor = context ? ` (context: ${context})` : '';
    return `Reflect on ${focusDescriptor}${contextDescriptor} and propose the next insight.`;
  }
}
