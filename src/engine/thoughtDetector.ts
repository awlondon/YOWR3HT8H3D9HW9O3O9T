/**
 * Detects ThoughtEvents from clusters based on structural, spectral, and
 * semantic thresholds. Also handles cooldowns and novelty filtering.
 */

import {
  type Cluster,
  type ThoughtEvent,
  type NodeCooldownState,
} from './cognitionTypes.js';
import { cosine, averageEmbedding } from './vectorUtils.js';

export interface ThoughtDetectorConfig {
  structuralThreshold: number; // Sₜ
  spectralThreshold: number; // Fₜ
  semanticThreshold: number; // Cₜ
  thoughtScoreThreshold: number; // Θ_thought
  minClusterSize: number; // K_min
  minPersistenceFrames: number; // P_min
  minNovelty: number; // 0..1 (vs recent thought centroids)
  cooldownMs: number; // per-node cooldown
  recentThoughtCentroidLimit: number; // for novelty memory
}

export interface ThoughtDetectorState {
  nodeCooldowns: Map<string, NodeCooldownState>;
  recentThoughtCentroids: number[][];
  nextThoughtId: number;
}

export interface ClusterFeaturesInput {
  cluster: Cluster;
  nodeEmbeddings: Map<string, number[]>;
  structuralScore: number; // precomputed structural metric S
  spectralScore: number; // precomputed spectral metric F
  semanticScore: number; // precomputed semantic metric C
}

export class ThoughtDetector {
  private config: ThoughtDetectorConfig;

  private state: ThoughtDetectorState;

  constructor(config?: Partial<ThoughtDetectorConfig>) {
    this.config = {
      structuralThreshold: 0.65,
      spectralThreshold: 0.7,
      semanticThreshold: 0.7,
      thoughtScoreThreshold: 0.8,
      minClusterSize: 3,
      minPersistenceFrames: 5,
      minNovelty: 0.6,
      cooldownMs: 5000,
      recentThoughtCentroidLimit: 32,
      ...config,
    };
    this.state = {
      nodeCooldowns: new Map(),
      recentThoughtCentroids: [],
      nextThoughtId: 1,
    };
  }

  private canFire(cluster: Cluster, now: number): boolean {
    for (const nid of cluster.nodeIds) {
      const cd = this.state.nodeCooldowns.get(nid);
      if (cd && now - cd.lastThoughtAt < cd.cooldownMs) return false;
    }
    return true;
  }

  private isNovel(centroid: number[]): boolean {
    if (centroid.length === 0) return false;
    let maxSim = 0;
    for (const c of this.state.recentThoughtCentroids) {
      const sim = cosine(centroid, c);
      if (sim > maxSim) maxSim = sim;
    }
    const novelty = 1 - maxSim;
    return novelty >= this.config.minNovelty;
  }

  private rememberCentroid(centroid: number[]): void {
    this.state.recentThoughtCentroids.push(centroid);
    if (this.state.recentThoughtCentroids.length > this.config.recentThoughtCentroidLimit) {
      this.state.recentThoughtCentroids.shift();
    }
  }

  private updateCooldowns(cluster: Cluster, now: number): void {
    for (const nid of cluster.nodeIds) {
      this.state.nodeCooldowns.set(nid, {
        lastThoughtAt: now,
        cooldownMs: this.config.cooldownMs,
      });
    }
  }

  public evaluateCluster(
    input: ClusterFeaturesInput,
    now: number,
  ): ThoughtEvent | null {
    const { cluster, structuralScore, spectralScore, semanticScore, nodeEmbeddings } = input;

    if (cluster.nodeIds.length < this.config.minClusterSize) return null;
    if (cluster.persistenceFrames < this.config.minPersistenceFrames) return null;
    if (!this.canFire(cluster, now)) return null;

    if (structuralScore < this.config.structuralThreshold) return null;
    if (spectralScore < this.config.spectralThreshold) return null;
    if (semanticScore < this.config.semanticThreshold) return null;

    const thoughtScore =
      0.33 * structuralScore +
      0.33 * spectralScore +
      0.34 * semanticScore;

    if (thoughtScore < this.config.thoughtScoreThreshold) return null;

    const embeddings: number[][] = [];
    for (const nid of cluster.nodeIds) {
      const emb = nodeEmbeddings.get(nid);
      if (emb) embeddings.push(emb);
    }
    const centroid = averageEmbedding(embeddings);
    if (!this.isNovel(centroid)) return null;

    this.rememberCentroid(centroid);
    this.updateCooldowns(cluster, now);

    const ev: ThoughtEvent = {
      id: `thought_${this.state.nextThoughtId++}`,
      type: 'cluster_thought',
      timestamp: now,
      cluster,
      thoughtScore,
    };

    return ev;
  }
}
