/**
 * Accumulates ThoughtEvents per user query, computes an ArticulationScore,
 * and decides when to produce a user-facing response.
 */

import {
  type ResponseAccumulator,
  type ThoughtEvent,
  type ArticulationEvent,
} from './cognitionTypes.js';
import { cosine, averageEmbedding } from './vectorUtils.js';

export interface ArticulationConfig {
  relevanceThreshold: number; // minimum similarity to query
  minRelevantThoughts: number; // N_min
  targetThoughts: number; // N_target for scaling
  minTimeSinceLastResponseMs: number; // T_min_ms
  articulationScoreThreshold: number; // Θ_speak

  /**
   * Optional parameters enabling an “early articulation” escape hatch.
   * When a single thought has sufficiently high internal score and
   * relevance, the engine may speak immediately even if the usual
   * thresholds aren’t met. Use in fast cognition mode.
   */
  strongThoughtScoreThreshold?: number;
  strongRelevanceThreshold?: number;
  minStrongArticulationIntervalMs?: number;
}

export class ResponseAccumulatorEngine {
  private config: ArticulationConfig;

  constructor(config?: Partial<ArticulationConfig>) {
    this.config = {
      relevanceThreshold: 0.6,
      minRelevantThoughts: 3,
      targetThoughts: 6,
      minTimeSinceLastResponseMs: 2000,
      articulationScoreThreshold: 0.75,
      strongThoughtScoreThreshold: 0.9,
      strongRelevanceThreshold: 0.75,
      minStrongArticulationIntervalMs: 500,
      ...config,
    };
  }

  public initAccumulator(queryEmbedding: number[], now: number): ResponseAccumulator {
    return {
      lastResponseAt: now,
      queryEmbedding,
      thoughtEvents: [],
    };
  }

  public addThought(acc: ResponseAccumulator, ev: ThoughtEvent): void {
    acc.thoughtEvents.push(ev);
  }

  private computeSemanticRelevance(
    ev: ThoughtEvent,
    nodeEmbeddings: Map<string, number[]>,
    queryEmbedding: number[],
  ): number {
    const embs: number[][] = [];
    for (const nid of ev.cluster.nodeIds) {
      const emb = nodeEmbeddings.get(nid);
      if (emb) embs.push(emb);
    }
    const centroid = averageEmbedding(embs);
    return cosine(centroid, queryEmbedding);
  }

  private semanticStability(centroids: number[][]): number {
    if (centroids.length < 2) return 0;
    let totalDrift = 0;
    let count = 0;
    for (let i = 1; i < centroids.length; i += 1) {
      const sim = cosine(centroids[i - 1], centroids[i]);
      const dist = 1 - sim;
      totalDrift += dist;
      count += 1;
    }
    const avgDrift = totalDrift / count;
    const clamped = Math.min(1, avgDrift);
    return 1 - clamped; // 1 = stable, 0 = unstable
  }

  // Placeholder: for now, we approximate “important nodes” as high-frequency nodes in thought clusters
  private inferImportantNodes(thoughts: ThoughtEvent[]): Set<string> {
    const freq = new Map<string, number>();
    for (const ev of thoughts) {
      for (const nid of ev.cluster.nodeIds) {
        freq.set(nid, (freq.get(nid) || 0) + 1);
      }
    }
    const entries = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 20);
    return new Set(top.map(([nid]) => nid));
  }

  private coverageScore(thoughts: ThoughtEvent[], importantNodeIds: Set<string>): number {
    if (importantNodeIds.size === 0) return 0;
    const visited = new Set<string>();
    for (const ev of thoughts) {
      for (const nid of ev.cluster.nodeIds) {
        visited.add(nid);
      }
    }
    let intersect = 0;
    for (const nid of importantNodeIds) {
      if (visited.has(nid)) intersect += 1;
    }
    return intersect / importantNodeIds.size; // 0..1
  }

  // Placeholder spectral confidence: treat cluster.spectral.flatness as inverse signal quality if available
  private spectralConfidence(thoughts: ThoughtEvent[]): number {
    if (thoughts.length === 0) return 0;
    const confidences: number[] = [];
    for (const ev of thoughts) {
      const flatness = ev.cluster.spectral.flatness; // assume 0..1
      const confidence = 1 - Math.min(1, flatness);
      confidences.push(confidence);
    }
    return confidences.reduce((a, b) => a + b, 0) / confidences.length;
  }

  private computeArticulationScore(
    relevantThoughts: ThoughtEvent[],
    nodeEmbeddings: Map<string, number[]>,
    queryEmbedding: number[],
  ): number {
    void queryEmbedding;
    const n = relevantThoughts.length;
    if (n === 0) return 0;

    const nTerm = Math.min(1, n / this.config.targetThoughts);

    const centroids: number[][] = [];
    for (const ev of relevantThoughts) {
      const embs: number[][] = [];
      for (const nid of ev.cluster.nodeIds) {
        const emb = nodeEmbeddings.get(nid);
        if (emb) embs.push(emb);
      }
      centroids.push(averageEmbedding(embs));
    }

    const stab = this.semanticStability(centroids.slice(-5));
    const cov = this.coverageScore(relevantThoughts, this.inferImportantNodes(relevantThoughts));
    const spec = this.spectralConfidence(relevantThoughts);

    const wN = 0.25;
    const wStab = 0.3;
    const wCov = 0.25;
    const wSpec = 0.2;

    return wN * nTerm + wStab * stab + wCov * cov + wSpec * spec;
  }

  /**
   * Decide whether to speak.
   * Returns ArticulationEvent if thresholds are satisfied; otherwise null.
   */
  public maybeArticulate(
    acc: ResponseAccumulator,
    nodeEmbeddings: Map<string, number[]>,
    now: number,
  ): ArticulationEvent | null {
    if (now - acc.lastResponseAt < this.config.minTimeSinceLastResponseMs) {
      return null;
    }

    const relevantThoughts: ThoughtEvent[] = [];
    const relevances: Map<string, number> = new Map();

    for (const ev of acc.thoughtEvents) {
      const rel = this.computeSemanticRelevance(ev, nodeEmbeddings, acc.queryEmbedding);
      if (rel >= this.config.relevanceThreshold) {
        relevantThoughts.push(ev);
        relevances.set(ev.id, rel);
      }
    }

    // Early articulation: speak immediately if a single thought is both high-scoring and highly relevant,
    // and enough time has passed since the last response.
    if (
      this.config.strongThoughtScoreThreshold !== undefined &&
      this.config.strongRelevanceThreshold !== undefined &&
      now - acc.lastResponseAt >= (this.config.minStrongArticulationIntervalMs ?? 0)
    ) {
      for (const ev of acc.thoughtEvents) {
        const rel = this.computeSemanticRelevance(ev, nodeEmbeddings, acc.queryEmbedding);
        if (
          rel >= this.config.strongRelevanceThreshold! &&
          ev.thoughtScore >= this.config.strongThoughtScoreThreshold!
        ) {
          const art: ArticulationEvent = {
            id: `articulation_${Date.now()}`,
            timestamp: now,
            articulationScore: 0.99,
            selectedThoughts: [ev],
          };
          acc.lastResponseAt = now;
          acc.thoughtEvents = [];
          return art;
        }
      }
    }

    if (relevantThoughts.length < this.config.minRelevantThoughts) return null;

    const score = this.computeArticulationScore(
      relevantThoughts,
      nodeEmbeddings,
      acc.queryEmbedding,
    );

    if (score < this.config.articulationScoreThreshold) return null;

    relevantThoughts.sort((a, b) => {
      const ra = relevances.get(a.id) ?? 0;
      const rb = relevances.get(b.id) ?? 0;
      return rb - ra;
    });

    const selected = relevantThoughts.slice(0, 6);

    const ev: ArticulationEvent = {
      id: `articulation_${Date.now()}`,
      timestamp: now,
      articulationScore: score,
      selectedThoughts: selected,
    };

    acc.lastResponseAt = now;
    acc.thoughtEvents = [];

    return ev;
  }
}
