import { buildContextBasis, type ContextBasis } from './contextBasis.js';
import { embedTextToVector } from './embeddingStore.js';

type WorkingNode = { id: string; label: string; meta?: Record<string, unknown> };
type WorkingEdge = { src: string; dst: string; weight: number };

type WorkingGraph = {
  nodes: Map<string, WorkingNode>;
  edges: WorkingEdge[];
};

interface ContextBuilderConfig {
  ringSize?: number;
  branchLimit?: number;
  level?: number;
}

function ensureEmbedding(
  embeddings: Map<string, number[]>,
  nodeId: string,
  label: string,
  hint?: number[],
): number[] {
  const existing = embeddings.get(nodeId);
  if (existing?.length) return existing;
  const vector = hint && hint.length ? hint : embedTextToVector(label || nodeId, 24);
  embeddings.set(nodeId, vector);
  return vector;
}

function topNeighbors(graph: WorkingGraph, nodeId: string, limit: number): string[] {
  const neighbors: Array<{ id: string; weight: number }> = [];
  graph.edges.forEach((edge) => {
    if (edge.src === nodeId) neighbors.push({ id: edge.dst, weight: edge.weight });
    else if (edge.dst === nodeId) neighbors.push({ id: edge.src, weight: edge.weight });
  });
  return neighbors
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.id);
}

export function deriveContextsFromGraph(
  graph: WorkingGraph,
  hubId: string,
  cfg: ContextBuilderConfig,
  embeddings: Map<string, number[]>,
): ContextBasis[] {
  const contexts: ContextBasis[] = [];
  const hubNode = graph.nodes.get(hubId);
  const hubVec = ensureEmbedding(embeddings, hubId, hubNode?.label ?? hubId, (hubNode as any)?.hintEmbedding);
  const ringSize = cfg.ringSize ?? 9;
  const branchLimit = cfg.branchLimit ?? 5;
  const level = cfg.level ?? 0;

  const ringNeighbors = topNeighbors(graph, hubId, ringSize);
  if (ringNeighbors.length) {
    const memberVecs = ringNeighbors.map((id) => {
      const node = graph.nodes.get(id);
      return ensureEmbedding(embeddings, id, node?.label ?? id, (node as any)?.hintEmbedding);
    });
    contexts.push(
      buildContextBasis(hubVec, memberVecs, Math.min(ringNeighbors.length + 1, hubVec.length), ringNeighbors, hubId, {
        createdAt: Date.now(),
        level,
        source: 'ring',
      }),
    );
  }

  ringNeighbors.forEach((ringId) => {
    const children = topNeighbors(graph, ringId, branchLimit).filter((id) => id !== hubId);
    const memberIds = [ringId, ...children];
    if (!memberIds.length) return;
    const memberVecs = memberIds.map((id) => {
      const node = graph.nodes.get(id);
      return ensureEmbedding(embeddings, id, node?.label ?? id, (node as any)?.hintEmbedding);
    });
    contexts.push(
      buildContextBasis(
        hubVec,
        memberVecs,
        Math.min(memberVecs.length + 1, hubVec.length),
        memberIds,
        hubId,
        { createdAt: Date.now(), level, source: 'cc' },
      ),
    );
  });

  return contexts;
}
