import {
  type AdjacencyDelta,
  type ThoughtEvent,
  type Cluster,
  type ArticulationEvent,
} from './cognitionTypes.js';
import { ThoughtDetector } from './thoughtDetector.js';
import { ResponseAccumulatorEngine } from './responseAccumulator.js';
import { cosine } from './vectorUtils.js';
import { collapseGraph, computeTokenSalience, topSalienceTokens } from './salience.js';
import type { SeedSphereConfig } from './expansionModes.js';
import { getAdjacency } from './adjacencyProvider.js';
import { normalizeRelationship } from './relationshipMap.js';

export type SphereLayer = 'visible' | 'hidden';

export interface SphereNode {
  id: string;
  label: string;
  embedding: number[];
  meta?: Record<string, unknown>;
}

export interface SphereEdge {
  src: string;
  dst: string;
  weight: number;
  role: string;
  layer?: SphereLayer;
  meta?: Record<string, unknown>;
}

export interface SphereGraph {
  nodes: Map<string, SphereNode>;
  edges: SphereEdge[];
}

export interface BuildDeps {
  llm: {
    seedAdjacency: (token: string) => Promise<AdjacencyDelta>;
    expandAdjacency: (token: string) => Promise<AdjacencyDelta>;
    expandAdjacencyTyped?: (token: string) => Promise<{
      definition?: string;
      edges?: Array<{ neighbor?: string; rel?: string; weight?: number }>;
    }>;
    articulateResponse?: (
      articulation: ArticulationEvent,
      userQuestion: string,
      salientContext?: { tokens: string[]; summary: string },
    ) => Promise<string>;
    modelName?: string;
  };
  embedder: { embed: (text: string) => Promise<number[]> };
  applyDelta?: (graph: SphereGraph, delta: AdjacencyDelta, layer: SphereLayer) => Set<string>;
  onGraphUpdate?: (graphSnapshot: SphereGraph) => void;
  shouldAbort?: () => boolean;
  thoughtDetector?: ThoughtDetector;
  accumulatorEngine?: ResponseAccumulatorEngine;
  accumulator?: ReturnType<ResponseAccumulatorEngine['initAccumulator']>;
  onThought?: (ev: ThoughtEvent) => void;
  affinityThreshold?: number;
  spectralOverlayEnabled?: boolean;
  onStatus?: (status: string) => void;
}

export interface BuildResult {
  graph: SphereGraph;
  collapsedGraph: SphereGraph;
  thoughts: ThoughtEvent[];
  response?: string;
  articulation?: ArticulationEvent | null;
  lastAdjacencySource: 'kb' | 'llm' | 'synthetic';
}

interface FrontierEntry {
  id: string;
  weight: number;
}

const adjacencyCache = new Map<string, AdjacencyDelta>();
const adjacencySourceCache = new Map<string, 'kb' | 'llm' | 'synthetic'>();

function prioritizeTokensBySynthetic(tokens: string[], graph: SphereGraph): string[] {
  const realTokens = tokens.filter((id) => graph.nodes.get(id)?.meta?.synthetic !== true);
  const syntheticTokens = tokens.filter((id) => graph.nodes.get(id)?.meta?.synthetic === true);
  if (realTokens.length) return [...realTokens, ...syntheticTokens];
  return tokens;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

function defaultApplyDelta(
  graph: SphereGraph,
  delta: AdjacencyDelta,
  layer: SphereLayer,
): Set<string> {
  const added = new Set<string>();
  if (Array.isArray(delta.nodes)) {
    delta.nodes.forEach((node) => {
      if (!node?.id) return;
      const existing = graph.nodes.get(node.id);
      if (existing) return;
      graph.nodes.set(node.id, {
        id: node.id,
        label: node.label ?? node.id,
        embedding: node.hintEmbedding ?? [],
        meta: { ...(node.meta || {}), layer },
      });
      added.add(node.id);
    });
  }
  if (Array.isArray(delta.edges)) {
    delta.edges.forEach((edge) => {
      if (!edge?.src || !edge.dst) return;
      graph.edges.push({
        src: edge.src,
        dst: edge.dst,
        weight: edge.weight ?? 0.1,
        role: edge.role ?? 'instance',
        layer,
        meta: edge.meta,
      });
    });
  }
  return added;
}

async function embedNewNodes(graph: SphereGraph, embedder: BuildDeps['embedder']): Promise<void> {
  const promises: Promise<void>[] = [];
  graph.nodes.forEach((node) => {
    if (!node.embedding || node.embedding.length === 0) {
      promises.push(
        embedder
          .embed(node.label)
          .then((emb) => {
            node.embedding = emb;
          })
          .catch(() => {
            node.embedding = [];
          }),
      );
    }
  });
  await Promise.all(promises);
}

function pickFrontier(graph: SphereGraph, fromNodes: Set<string>, dimension: number): FrontierEntry[] {
  const candidates: FrontierEntry[] = [];
  graph.edges.forEach((edge) => {
    if (!fromNodes.has(edge.src) && !fromNodes.has(edge.dst)) return;
    const target = fromNodes.has(edge.src) ? edge.dst : edge.src;
    candidates.push({ id: target, weight: edge.weight ?? 0 });
  });
  const unique = new Map<string, FrontierEntry>();
  candidates
    .sort((a, b) => b.weight - a.weight)
    .forEach((c) => {
      if (!unique.has(c.id)) unique.set(c.id, c);
    });
  return Array.from(unique.values()).slice(0, Math.max(1, dimension));
}

function clusterGraph(graph: SphereGraph, threshold: number): Cluster[] {
  const adjacency = new Map<string, Set<string>>();
  graph.edges.forEach((edge) => {
    if (edge.weight < threshold) return;
    if (!adjacency.has(edge.src)) adjacency.set(edge.src, new Set());
    if (!adjacency.has(edge.dst)) adjacency.set(edge.dst, new Set());
    adjacency.get(edge.src)!.add(edge.dst);
    adjacency.get(edge.dst)!.add(edge.src);
  });
  const visited = new Set<string>();
  const clusters: Cluster[] = [];
  graph.nodes.forEach((node, id) => {
    if (visited.has(id)) return;
    const queue = [id];
    const members: string[] = [];
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      members.push(current);
      const neighbors = adjacency.get(current) || new Set<string>();
      neighbors.forEach((n) => {
        if (!visited.has(n)) queue.push(n);
      });
    }
    if (members.length) {
      clusters.push({
        id: `cluster-${clusters.length + 1}`,
        nodeIds: members,
        density: 0.5,
        persistenceFrames: 2,
        spectral: { energy: 0.5, centroid: 0.5, flatness: 0.5, roleBandpower: [0.5, 0.5, 0.5, 0.5, 0.5] },
        semanticCoherence: 0.5,
        novelty: 0.5,
      });
    }
  });
  return clusters;
}

function computeSemanticCoherence(cluster: Cluster, graph: SphereGraph): number {
  const embeddings: number[][] = [];
  cluster.nodeIds.forEach((id) => {
    const emb = graph.nodes.get(id)?.embedding || [];
    if (emb.length) embeddings.push(emb);
  });
  if (embeddings.length <= 1) return 0.5;
  let total = 0;
  let count = 0;
  for (let i = 0; i < embeddings.length; i += 1) {
    for (let j = i + 1; j < embeddings.length; j += 1) {
      total += cosine(embeddings[i], embeddings[j]);
      count += 1;
    }
  }
  return count ? Math.max(0, Math.min(1, total / count)) : 0.5;
}

function emitThoughts(
  graph: SphereGraph,
  deps: BuildDeps,
  clusters: Cluster[],
  thoughts: ThoughtEvent[],
): void {
  const detector = deps.thoughtDetector;
  if (!detector) return;
  const now = Date.now();
  clusters.forEach((cluster) => {
    const structuralScore = Math.min(1, 0.6 + cluster.nodeIds.length * 0.05);
    const spectralScore = deps.spectralOverlayEnabled ? cluster.spectral.energy : 0.5;
    const semanticScore = computeSemanticCoherence(cluster, graph);
    const ev = detector.evaluateCluster(
      { cluster, nodeEmbeddings: new Map(Array.from(graph.nodes.entries()).map(([id, node]) => [id, node.embedding])), structuralScore, spectralScore, semanticScore },
      now,
    );
    if (ev) {
      ev.cluster.nodeIds = ev.cluster.nodeIds.map((id) => graph.nodes.get(id)?.label || id);
      thoughts.push(ev);
      if (deps.accumulator && deps.accumulatorEngine) {
        deps.accumulatorEngine.addThought(deps.accumulator, ev, (nid) => graph.nodes.get(nid)?.label);
      }
      deps.onThought?.(ev);
    }
  });
}

async function getAdjacencyDelta(
  token: string,
  deps: BuildDeps,
  kind: 'seed' | 'expand',
  cfg: SeedSphereConfig,
): Promise<{ delta: AdjacencyDelta; source: 'kb' | 'llm' | 'synthetic' }>
// eslint-disable-next-line brace-style
{
  const lower = token.toLowerCase();
  const cacheKey = `${deps.llm.modelName || 'default'}:${lower}:${kind}`;
  if (adjacencyCache.has(cacheKey)) {
    return { delta: adjacencyCache.get(cacheKey)!, source: adjacencySourceCache.get(cacheKey) || 'kb' };
  }
  let source: 'kb' | 'llm' | 'synthetic' = 'kb';
  const adjacency = await getAdjacency(token, {
    allowSynthetic: cfg.allowSyntheticFallback === true,
    llm: { expandAdjacencyTyped: deps.llm.expandAdjacencyTyped, modelName: deps.llm.modelName },
  });
  source = adjacency.source;
  const centerId = slugify(token);
  const nodes = adjacency.neighbors.map((neighbor) => ({
    id: slugify(neighbor.token),
    label: neighbor.token,
    hintEmbedding: [],
    meta: { source: adjacency.source, synthetic: adjacency.source === 'synthetic' },
  }));
  const edges = adjacency.neighbors.map((neighbor) => ({
    src: centerId,
    dst: slugify(neighbor.token),
    weight: neighbor.weight,
    role: normalizeRelationship(neighbor.rel),
    meta: { rel: neighbor.rel },
  }));
  const delta: AdjacencyDelta = { nodes, edges, notes: adjacency.definition };
  adjacencyCache.set(cacheKey, delta);
  adjacencySourceCache.set(cacheKey, source);
  return { delta, source };
}

async function expandFrontier(
  frontier: FrontierEntry[],
  cfg: SeedSphereConfig,
  deps: BuildDeps,
  graph: SphereGraph,
  layer: SphereLayer,
  thoughts: ThoughtEvent[],
  tokenFreq: Map<string, number>,
  lastSource: { current: 'kb' | 'llm' | 'synthetic' },
): Promise<Set<string>> {
  const added = new Set<string>();
  const concurrency = Math.max(1, Math.floor(cfg.concurrency) || 1);
  const queue = frontier.slice();

  const worker = async (): Promise<void> => {
    while (queue.length && added.size + graph.nodes.size < cfg.maxNodes) {
      if (deps.shouldAbort?.()) return;
      const next = queue.shift();
      if (!next) return;
      const { delta, source } = await getAdjacencyDelta(next.id, deps, 'expand', cfg);
      lastSource.current = source;
      deps.onStatus?.(`Adjacency source: ${source === 'synthetic' ? 'synthetic (OFFLINE)' : source.toUpperCase()}`);
      const apply = deps.applyDelta ?? defaultApplyDelta;
      const newNodes = apply(graph, delta, layer);
      newNodes.forEach((id) => {
        const label = graph.nodes.get(id)?.label || id;
        const count = tokenFreq.get(label.toLowerCase()) || 0;
        tokenFreq.set(label.toLowerCase(), count + 1);
      });
      newNodes.forEach((id) => {
        const node = graph.nodes.get(id);
        if (node) node.meta = { ...(node.meta || {}), layer };
        added.add(id);
      });
      added.add(next.id);
      await embedNewNodes(graph, deps.embedder);
      emitThoughts(graph, deps, clusterGraph(graph, cfg.affinityThreshold), thoughts);
      if (graph.edges.length >= cfg.maxEdges) return;
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return added;
}

export async function buildSeedSphere(cfgInput: SeedSphereConfig, deps: BuildDeps): Promise<BuildResult> {
  const cfg: SeedSphereConfig = {
    ...cfgInput,
    allowSyntheticFallback: cfgInput.allowSyntheticFallback === true,
  };
  const graph: SphereGraph = { nodes: new Map(), edges: [] };
  const apply = deps.applyDelta ?? defaultApplyDelta;
  const tokenFreq = new Map<string, number>();
  const thoughts: ThoughtEvent[] = [];
  let lastAdjacencySource: 'kb' | 'llm' | 'synthetic' = 'kb';

  const seedId = slugify(cfg.seedToken || 'seed');
  graph.nodes.set(seedId, {
    id: seedId,
    label: cfg.seedToken,
    embedding: [],
    meta: { layer: 'visible' },
  });
  tokenFreq.set(cfg.seedToken.toLowerCase(), 1);

  const { delta: seedDelta, source: seedSource } = await getAdjacencyDelta(cfg.seedToken, deps, 'seed', cfg);
  lastAdjacencySource = seedSource;
  deps.onStatus?.(`Adjacency source: ${seedSource === 'synthetic' ? 'synthetic (OFFLINE)' : seedSource.toUpperCase()}`);
  apply(graph, seedDelta, 'visible');
  await embedNewNodes(graph, deps.embedder);
  deps.onGraphUpdate?.(graph);

  const frontierSeed = new Set<string>();
  graph.edges.forEach((edge) => {
    if (edge.src === seedId) frontierSeed.add(edge.dst);
    if (edge.dst === seedId) frontierSeed.add(edge.src);
  });
  let frontier = pickFrontier(graph, frontierSeed, cfg.dimension);

  const adjacencyState = { current: lastAdjacencySource };
  for (let level = 0; level < cfg.level; level += 1) {
    if (deps.shouldAbort?.()) break;
    const newNodes = await expandFrontier(frontier, cfg, deps, graph, 'visible', thoughts, tokenFreq, adjacencyState);
    frontier = pickFrontier(graph, newNodes, cfg.dimension + level);
    deps.onGraphUpdate?.(graph);
    if (graph.nodes.size >= cfg.maxNodes || graph.edges.length >= cfg.maxEdges) break;
  }

  // Hidden depth expansion based on salience
  for (let depth = 0; depth < cfg.hiddenDepth; depth += 1) {
    if (deps.shouldAbort?.()) break;
    const salience = computeTokenSalience(graph as any);
    const centers = prioritizeTokensBySynthetic(topSalienceTokens(salience, cfg.salienceTopK), graph);
    const hiddenFrontier = centers.map((id) => ({ id, weight: salience.get(id) || 0 }));
    await expandFrontier(hiddenFrontier, cfg, deps, graph, 'hidden', thoughts, tokenFreq, adjacencyState);
    deps.onGraphUpdate?.(graph);
  }

  const salienceMap = computeTokenSalience(graph as any);
  const centers = prioritizeTokensBySynthetic(topSalienceTokens(salienceMap, cfg.salienceTopK), graph);
  const collapsedGraph = collapseGraph(graph as any, centers, cfg.collapseRadius) as SphereGraph;
  deps.onGraphUpdate?.(collapsedGraph);
  const embeddingMap = new Map(Array.from(graph.nodes.entries()).map(([id, node]) => [id, node.embedding]));
  let articulation: ArticulationEvent | null = null;
  let response: string | undefined;
  if (deps.accumulator && deps.accumulatorEngine) {
    articulation =
      deps.accumulatorEngine.maybeArticulate(
        deps.accumulator,
        embeddingMap,
        Date.now(),
      ) ?? null;
  }
  if (articulation && deps.llm.articulateResponse) {
    response = await deps.llm.articulateResponse(articulation, cfg.seedToken, {
      tokens: centers,
      summary: centers.join(', '),
    });
  }

  return { graph, collapsedGraph, thoughts, response, articulation, lastAdjacencySource: adjacencyState.current };
}
