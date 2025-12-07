import { type ArticulationEvent, type ThoughtEvent } from './emergentThoughtTypes.js';

export interface ArticulationConfig {
  minThoughts?: number;
  cooldownMs?: number;
  noveltyThreshold?: number;
}

export class ArticulationManager {
  private thoughts: ThoughtEvent[] = [];
  private lastArticulationAt = 0;

  constructor(private config: ArticulationConfig = {}) {}

  recordThought(thought: ThoughtEvent): void {
    this.thoughts.push(thought);
  }

  maybeArticulate(relevantThoughts: ThoughtEvent[], queryEmbedding: number[], now: number): ArticulationEvent | null {
    const minThoughts = this.config.minThoughts ?? 1;
    const cooldown = this.config.cooldownMs ?? 750;
    if (relevantThoughts.length < minThoughts) return null;
    if (now - this.lastArticulationAt < cooldown) return null;

    const event: ArticulationEvent = {
      id: `art-${Date.now()}`,
      message: `Synthesized ${relevantThoughts.length} thoughts for response`,
      timestamp: now,
      thoughts: relevantThoughts,
    };
    this.lastArticulationAt = now;
    this.thoughts = [];
    return event;
  }
}
