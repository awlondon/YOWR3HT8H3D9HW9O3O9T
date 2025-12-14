import { StubLLMClient } from './llmClient.js';
import {
  type Cluster,
  type HlsfEdge,
  type HlsfGraph,
  type HlsfNode,
  type ReasoningStep,
  type ThoughtEvent,
  type ArticulationEvent,
  type AdjacencyDelta,
} from './cognitionTypes.js';
import { ThoughtDetector } from './thoughtDetector.js';
import { ResponseAccumulatorEngine } from './responseAccumulator.js';
import { averageEmbedding, cosine } from './vectorUtils.js';
import { DEFAULT_CONVERGENCE_THROTTLE_CONFIG, type ConvergenceThrottleConfig } from './expansionModes.js';
import {
  collapseToPoint,
  reseedFieldFromHub,
  selectHubForConvergence,
  shouldThrottleField,
  updateCycles,
  type ThrottleState,
} from './convergenceThrottler.js';

interface Token {
  label: string;
  type: 'noun' | 'verb' | 'relation' | 'other';
  index: number;
}

interface TraverseContext {
  graph: HlsfGraph;
  nodeEmbeddings: Map<string, number[]>;
  nodeLookup: Map<string, HlsfNode>;
  clusters: Cluster[];
  thoughtDetector: ThoughtDetector;
  accumulator: ReturnType<ResponseAccumulatorEngine['initAccumulator']>;
  respEngine: ResponseAccumulatorEngine;
  llm: StubLLMClient;
  maxAdjacencyDepth: number;
  onThought?: (ev: ThoughtEvent) => void;
  onArticulation?: (ev: ArticulationEvent) => void;
  prompt: string;
  trace: string[];
  throttleCfg: ConvergenceThrottleConfig;
  throttleState: ThrottleState;
}

interface ReasonerResult {
  trace: string[];
  response: string;
}

function embedToken(label: string): number[] {
  const base = label.toLowerCase().split('').map(char => (char.charCodeAt(0) % 32) / 32);
  const dims = 8;
  const emb: number[] = [];
  for (let i = 0; i < dims; i += 1) {
    emb.push(base[i % base.length] ?? 0.1 * (i + 1));
  }
  const norm = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0)) || 1;
  return emb.map(v => v / norm);
}

function decomposePrompt(prompt: string): { tokens: Token[]; step: ReasoningStep } {
  const rawTokens = prompt.match(/[\w']+/g) || [];
  const tokens: Token[] = rawTokens.map((word, idx) => {
    const lower = word.toLowerCase();
    const isVerb = /ing$/.test(lower) || ['am', 'is', 'are', 'meet', 'greet'].includes(lower);
    const isRelation = ['with', 'to', 'for', 'and', 'but'].includes(lower);
    const type: Token['type'] = isVerb ? 'verb' : isRelation ? 'relation' : 'noun';
    return { label: word, type, index: idx };
  });
  const summary = `Decomposed prompt into ${tokens.length} tokens: ${tokens
    .map(t => `${t.label}(${t.type})`)
    .join(', ')}`;
  return { tokens, step: { stage: 'prompt_decomposition', note: summary } };
}

function clusterConcepts(tokens: Token[]): { clusters: Cluster[]; nodes: Map<string, HlsfNode>; step: ReasoningStep } {
  const clusters: Cluster[] = [];
  const nodes = new Map<string, HlsfNode>();
  const spectralTemplate = { energy: 0.65, centroid: 0.4, flatness: 0.2, roleBandpower: [0.5, 0.4, 0.3, 0.2, 0.1] };
  let clusterIndex = 0;
  let cursor = 0;

  while (cursor < tokens.length) {
    const window = tokens.slice(cursor, cursor + 3);
    const windowTypes = new Set(window.map(t => t.type));
    const clusterTokens = windowTypes.size > 1 ? window : tokens.slice(cursor, cursor + 2);
    const nodeIds: string[] = [];
    clusterTokens.forEach(token => {
      const id = `node-${token.index}`;
      nodeIds.push(id);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label: token.label,
          tokenType: token.type,
          tokens: [token.label],
          embedding: embedToken(token.label),
        });
      }
    });

    const density = Math.min(1, nodeIds.length / Math.max(2, clusterTokens.length + 1));
    const semanticCoherence = 0.55 + 0.05 * Math.random();
    clusters.push({
      id: `cluster-${clusterIndex}`,
      nodeIds,
      density,
      persistenceFrames: 2,
      spectral: spectralTemplate,
      semanticCoherence,
      novelty: 0.75,
    });
    clusterIndex += 1;
    cursor += clusterTokens.length || 1;
  }

  const summary = `Grouped tokens into ${clusters.length} clusters.`;
  return { clusters, nodes, step: { stage: 'conceptual_clustering', note: summary } };
}

function buildGraph(clusters: Cluster[], nodes: Map<string, HlsfNode>): { graph: HlsfGraph; step: ReasoningStep } {
  const edges: HlsfEdge[] = [];
  for (let i = 0; i < clusters.length - 1; i += 1) {
    edges.push({
      id: `edge-${i}-${i + 1}`,
      source: clusters[i].id,
      target: clusters[i + 1].id,
      weight: 0.7,
      relation: 'sequence',
    });
  }
  const graph: HlsfGraph = { nodes: [...nodes.values()], edges, metadata: { clusterCount: clusters.length } };
  const summary = `Constructed HLSF graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges.`;
  return { graph, step: { stage: 'hlsf_graph', note: summary } };
}

function refineClusters(clusters: Cluster[]): { refined: Cluster[]; step: ReasoningStep } {
  if (clusters.length <= 1) {
    return { refined: clusters, step: { stage: 'refinement', note: 'No refinement needed.' } };
  }
  const merged: Cluster[] = [];
  for (let i = 0; i < clusters.length; i += 1) {
    const current = clusters[i];
    const next = clusters[i + 1];
    if (next && current.nodeIds.length === 1 && next.nodeIds.length === 1) {
      merged.push({
        ...current,
        id: `${current.id}+${next.id}`,
        nodeIds: [...current.nodeIds, ...next.nodeIds],
        density: Math.min(1, (current.density + next.density) / 2 + 0.1),
        semanticCoherence: Math.min(1, (current.semanticCoherence + next.semanticCoherence) / 2 + 0.05),
      });
      i += 1;
    } else {
      merged.push(current);
    }
  }
  const summary = `Refined clusters from ${clusters.length} to ${merged.length}.`;
  return { refined: merged, step: { stage: 'refinement', note: summary } };
}

function buildClusterFeatures(cluster: Cluster, nodeEmbeddings: Map<string, number[]>): {
  structuralScore: number;
  spectralScore: number;
  semanticScore: number;
} {
  const structuralScore = Math.min(1, 0.6 + cluster.density * 0.4);
  const spectralScore = Math.min(1, 0.6 + cluster.spectral.energy * 0.3);
  const embeddings: number[][] = [];
  cluster.nodeIds.forEach(id => {
    const emb = nodeEmbeddings.get(id);
    if (emb) embeddings.push(emb);
  });
  const centroid = averageEmbedding(embeddings);
  let semanticScore = 0;
  if (embeddings.length > 1) {
    let total = 0;
    let count = 0;
    for (let i = 0; i < embeddings.length; i += 1) {
      for (let j = i + 1; j < embeddings.length; j += 1) {
        total += cosine(embeddings[i], embeddings[j]);
        count += 1;
      }
    }
    semanticScore = count ? total / count : 0;
  }
  semanticScore = Math.min(1, Math.max(0.45, semanticScore));
  return { structuralScore, spectralScore, semanticScore };
}

function applyAdjacencyDeltaToHlsf(
  context: TraverseContext,
  delta: AdjacencyDelta,
): Set<string> {
  const addedNodeIds = new Set<string>();
  if (delta.nodes?.length) {
    delta.nodes.forEach(n => {
      const newNode: HlsfNode = {
        id: n.id,
        label: n.label,
        tokenType: 'noun',
        tokens: [n.label],
        embedding: n.hintEmbedding ?? embedToken(n.label),
      };
      context.graph.nodes.push(newNode);
      context.nodeEmbeddings.set(n.id, newNode.embedding);
      context.nodeLookup.set(n.id, newNode);
      addedNodeIds.add(n.id);
    });
  }

  if (delta.edges?.length) {
    delta.edges.forEach(e => {
      context.graph.edges.push({
        id: `${e.src}->${e.dst}`,
        source: e.src,
        target: e.dst,
        weight: e.weight,
        relation: e.role,
      });
    });
  }
  return addedNodeIds;
}

function buildPseudoThought(token: string): ThoughtEvent {
  const spectralTemplate = { energy: 0.5, centroid: 0.5, flatness: 0.5, roleBandpower: [0.5, 0.5, 0.5, 0.5, 0.5] } as const;
  const cluster: Cluster = {
    id: token,
    nodeIds: [token],
    density: 0.6,
    persistenceFrames: 1,
    spectral: spectralTemplate,
    semanticCoherence: 0.55,
    novelty: 0.5,
  };
  return {
    id: `thought-${token}`,
    type: 'cluster_thought',
    timestamp: Date.now(),
    cluster,
    thoughtScore: 0.75,
  };
}

function mapNodesFromThrottleGraph(nodes: Map<string, any>): HlsfNode[] {
  const mapped: HlsfNode[] = [];
  nodes.forEach((node, id) => {
    mapped.push({
      id,
      label: node.label ?? id,
      tokenType: 'noun',
      tokens: [node.label ?? id],
      embedding: Array.isArray(node.embedding) && node.embedding.length ? node.embedding : embedToken(node.label ?? id),
    });
  });
  return mapped;
}

function synthesizeHiddenCluster(
  thought: ThoughtEvent,
  delta: AdjacencyDelta,
  depth: number,
  addedNodeIds: Set<string>,
): Cluster | null {
  const nodeIds = new Set<string>([...addedNodeIds]);
  delta.edges?.forEach(e => {
    nodeIds.add(e.src);
    nodeIds.add(e.dst);
  });

  if (nodeIds.size === 0) return null;
  const memberIds = [...nodeIds];
  const possibleEdges = (memberIds.length * (memberIds.length - 1)) / 2;
  const density = Math.min(1, (delta.edges?.length ?? 0) / Math.max(1, possibleEdges));
  const semanticCoherence = Math.min(1, 0.5 + 0.1 * memberIds.length);

  return {
    id: `${thought.id}-hidden-${depth}`,
    nodeIds: memberIds,
    density: Math.max(density, thought.cluster.density * 0.5),
    persistenceFrames: Math.max(1, thought.cluster.persistenceFrames - depth),
    spectral: thought.cluster.spectral,
    semanticCoherence,
    novelty: Math.max(0.2, thought.cluster.novelty - 0.05 * depth),
  };
}

async function traverseGraph(context: TraverseContext): Promise<ArticulationEvent | null> {
  const visited = new Set<string>();
  const { clusters, thoughtDetector, respEngine, accumulator, llm, trace } = context;

  const maybeThrottle = async (): Promise<boolean> => {
    updateCycles(context.throttleState);
    const decision = shouldThrottleField(context.graph as any, context.throttleCfg, context.throttleState, Date.now());
    if (!decision.shouldThrottle) return false;
    const hubSelection = decision.hubId ? { hubId: decision.hubId, hubLabel: decision.hubLabel ?? context.nodeLookup.get(decision.hubId)?.label ?? decision.hubId } : selectHubForConvergence(context.graph as any);
    const hubId = hubSelection.hubId;
    const hubLabel = hubSelection.hubLabel ?? hubId;
    trace.push(
      `[throttle] converging field at nodes=${context.graph.nodes.length} edges=${context.graph.edges.length} hub=${hubLabel}`,
    );
    const collapsed = collapseToPoint(context.graph as any, hubId, context.throttleCfg);
    const reseeded = await reseedFieldFromHub(hubId, collapsed.collapsedGraph as any, context.throttleCfg, {
      getAdjacencyDelta: async (token) => llm.expandAdjacency(buildPseudoThought(token), 0, context.maxAdjacencyDepth),
      applyAdjacencyDelta: (target, delta, layer) => {
        const targetNodes = target.nodes instanceof Map ? target.nodes : new Map<string, any>(target.nodes ?? []);
        const targetEdges = Array.isArray(target.edges) ? target.edges : [];
        if (!(target.nodes instanceof Map)) {
          target.nodes = targetNodes;
        }
        if (!Array.isArray(target.edges)) {
          target.edges = targetEdges;
        }
        delta.nodes?.forEach((node: any) => {
          if (!node?.id || targetNodes.has(node.id)) return;
          targetNodes.set(node.id, { ...node, meta: { ...(node.meta ?? {}), layer } });
        });
        delta.edges?.forEach((edge: any) => {
          if (!edge?.src || !edge?.dst) return;
          targetEdges.push({ src: edge.src, dst: edge.dst, weight: edge.weight, role: edge.role });
        });
      },
      shouldAbort: llm.shouldAbort?.bind(llm),
      log: (msg) => trace.push(msg),
    });
    context.throttleState.lastThrottleAt = Date.now();
    context.throttleState.throttles += 1;
    const mappedNodes = mapNodesFromThrottleGraph(reseeded.nodes);
    const mappedEdges = (reseeded.edges || [])
      .map((edge: any, idx: number) => ({
        id: `${edge.src || edge.source}->${edge.dst || edge.target}-${idx}`,
        source: edge.src ?? edge.source,
        target: edge.dst ?? edge.target,
        weight: edge.weight ?? 0.1,
        relation: edge.role ?? 'relation',
      }))
      .filter((edge) => edge.source && edge.target);
    context.graph.nodes = mappedNodes;
    context.graph.edges = mappedEdges;
    context.nodeEmbeddings = new Map(mappedNodes.map((n) => [n.id, n.embedding]));
    context.nodeLookup = new Map(mappedNodes.map((n) => [n.id, n]));
    trace.push(
      `CONVERGENCE: hub=${hubLabel} nodes=${collapsed.collapsedGraph.nodes.size} edges=${collapsed.collapsedGraph.edges.length} → reseeded new field`,
    );
    return true;
  };

  const expandAndRecurse = async (
    thought: ThoughtEvent,
    depth: number,
  ): Promise<ArticulationEvent | null> => {
    const delta = await llm.expandAdjacency(thought, depth, context.maxAdjacencyDepth);
    const addedNodes = applyAdjacencyDeltaToHlsf(context, delta);
    if ((delta.nodes?.length ?? 0) + (delta.edges?.length ?? 0) > 0) {
      const nodeCount = delta.nodes?.length ?? 0;
      const edgeCount = delta.edges?.length ?? 0;
      trace.push(
        `Expanded adjacency for ${thought.id} (depth ${depth}) with ${nodeCount} nodes and ${edgeCount} edges.`,
      );
    }

    if (await maybeThrottle()) return null;

    if (depth >= context.maxAdjacencyDepth) return null;

    const hiddenCluster = synthesizeHiddenCluster(thought, delta, depth + 1, addedNodes);
    if (!hiddenCluster) return null;

    const { structuralScore, spectralScore, semanticScore } = buildClusterFeatures(hiddenCluster, context.nodeEmbeddings);
    const nestedThought = thoughtDetector.evaluateCluster(
      {
        cluster: hiddenCluster,
        structuralScore,
        spectralScore,
        semanticScore,
        nodeEmbeddings: context.nodeEmbeddings,
      },
      Date.now(),
    );

    if (!nestedThought) return null;
    return handleThought(nestedThought, depth + 1);
  };

  const handleThought = async (
    thought: ThoughtEvent,
    depth: number,
  ): Promise<ArticulationEvent | null> => {
    respEngine.addThought(accumulator, thought, nid => context.nodeLookup.get(nid)?.label);
    context.onThought?.(thought);
    trace.push(`Thought emitted on ${thought.cluster.id} with score ${thought.thoughtScore.toFixed(2)} at depth ${depth}.`);

    const articulation = respEngine.maybeArticulate(accumulator, context.nodeEmbeddings, Date.now());
    if (articulation) {
      context.onArticulation?.(articulation);
      return articulation;
    }

    return expandAndRecurse(thought, depth);
  };

  const dfs = async (index: number): Promise<ArticulationEvent | null> => {
    if (index < 0 || index >= clusters.length) return null;
    const cluster = clusters[index];
    if (visited.has(cluster.id)) return null;
    visited.add(cluster.id);

    const { structuralScore, spectralScore, semanticScore } = buildClusterFeatures(cluster, context.nodeEmbeddings);
    const thought = thoughtDetector.evaluateCluster(
      {
        cluster,
        structuralScore,
        spectralScore,
        semanticScore,
        nodeEmbeddings: context.nodeEmbeddings,
      },
      Date.now(),
    );

    if (thought) {
      const articulation = await handleThought(thought, 0);
      if (articulation) return articulation;
    }

    const next = index + 1;
    const articulation = await dfs(next);
    if (articulation) return articulation;
    return null;
  };

  for (let i = 0; i < clusters.length; i += 1) {
    const articulation = await dfs(i);
    if (articulation) return articulation;
  }
  return null;
}

function collapseGraphToSalient(
  graph: HlsfGraph,
  clusters: Cluster[],
  salientTokens: string[],
): { graph: HlsfGraph; clusters: Cluster[]; keptNodeIds: Set<string> } {
  if (salientTokens.length === 0) {
    return { graph, clusters, keptNodeIds: new Set(graph.nodes.map(n => n.id)) };
  }

  const nodeLabels = new Map(graph.nodes.map(n => [n.id, n.label]));
  const containsSalient = (cluster: Cluster) =>
    cluster.nodeIds.some(id => salientTokens.includes(nodeLabels.get(id) ?? id));

  const adjacency = new Map<string, Set<string>>();
  graph.edges.forEach(e => {
    const srcSet = adjacency.get(e.source) ?? new Set<string>();
    const dstSet = adjacency.get(e.target) ?? new Set<string>();
    srcSet.add(e.target);
    dstSet.add(e.source);
    adjacency.set(e.source, srcSet);
    adjacency.set(e.target, dstSet);
  });

  const keep = new Set<string>();
  clusters.forEach(c => {
    if (containsSalient(c)) {
      keep.add(c.id);
      adjacency.get(c.id)?.forEach(n => keep.add(n));
    }
  });

  if (keep.size === 0) {
    return { graph, clusters, keptNodeIds: new Set(graph.nodes.map(n => n.id)) };
  }

  const keptClusters = clusters.filter(c => keep.has(c.id));
  const keptNodeIds = new Set<string>();
  keptClusters.forEach(c => c.nodeIds.forEach(id => keptNodeIds.add(id)));

  const filteredNodes = graph.nodes.filter(n => keptNodeIds.has(n.id));
  const filteredEdges = graph.edges.filter(e => keep.has(e.source) && keep.has(e.target));

  return { graph: { ...graph, nodes: filteredNodes, edges: filteredEdges }, clusters: keptClusters, keptNodeIds };
}

function summarizeSalientContext(
  salientTokens: string[],
  graph: HlsfGraph,
  clusters: Cluster[],
): string {
  if (salientTokens.length === 0) return 'No salient tokens identified; using global context.';
  const nodeLabels = new Map(graph.nodes.map(n => [n.id, n.label]));
  const clusterMentions = clusters
    .slice(0, 5)
    .map(c => {
      const labels = c.nodeIds.map(id => nodeLabels.get(id) ?? id).join(', ');
      return `${c.id}: ${labels}`;
    })
    .join(' | ');
  return `Focus on ${salientTokens.join(', ')}. Neighbor clusters: ${clusterMentions}`;
}

function craftResponse(prompt: string, trace: string[], articulation: ArticulationEvent | null): string {
  const capitalized = (prompt.match(/\b[A-Z][a-zA-Z]+\b/g) || []).find(word => word.toLowerCase() !== 'i');
  const intro = capitalized ? `${capitalized} introduces themselves to the user.` : 'The speaker introduces themselves to the user.';
  const traceSnippet = trace.slice(0, 3).join(' ');
  const articulationSummary = articulation
    ? `Selected ${articulation.selectedThoughts.length} thought(s) to articulate.`
    : 'Articulation synthesized from available thoughts.';
  return `${intro} ${articulationSummary} Trace: ${traceSnippet}`;
}

export async function runHlsfReasoning(
  prompt: string,
  options?: {
    onThought?: (ev: ThoughtEvent) => void;
    onArticulation?: (ev: ArticulationEvent) => void;
  },
): Promise<ReasonerResult> {
  const trace: string[] = [];
  const maxAdjacencyDepth = 2;
  const llm = new StubLLMClient();
  const thoughtDetector = new ThoughtDetector({
    structuralThreshold: 0.4,
    spectralThreshold: 0.4,
    semanticThreshold: 0.45,
    thoughtScoreThreshold: 0.5,
    minClusterSize: 2,
    minPersistenceFrames: 1,
    minNovelty: 0.25,
    enableSpark: true,
    sparkStructuralThreshold: 0.5,
    sparkSpectralThreshold: 0.5,
    sparkSemanticThreshold: 0.5,
    sparkMinCount: 2,
  });
  const respEngine = new ResponseAccumulatorEngine({
    relevanceThreshold: 0.5,
    minRelevantThoughts: 2,
    targetThoughts: 3,
    articulationScoreThreshold: 0.55,
    minTimeSinceLastResponseMs: 0,
  });

  const decomp = decomposePrompt(prompt);
  trace.push(decomp.step.note);
  const { clusters, nodes, step: clusterStep } = clusterConcepts(decomp.tokens);
  trace.push(clusterStep.note);
  const { refined, step: refineStep } = refineClusters(clusters);
  trace.push(refineStep.note);
  const { graph, step: graphStep } = buildGraph(refined, nodes);
  trace.push(graphStep.note);

  const nodeEmbeddings = new Map<string, number[]>();
  graph.nodes.forEach(n => nodeEmbeddings.set(n.id, n.embedding));
  const nodeLookup = new Map<string, HlsfNode>();
  graph.nodes.forEach(n => nodeLookup.set(n.id, n));
  const queryEmbedding = averageEmbedding([...nodeEmbeddings.values()]);
  const accumulator = respEngine.initAccumulator(queryEmbedding, Date.now());
  const throttleCfg = DEFAULT_CONVERGENCE_THROTTLE_CONFIG;
  const throttleState: ThrottleState = { lastThrottleAt: 0, throttles: 0, cycles: 0 };

  const articulation = await traverseGraph({
    graph,
    nodeEmbeddings,
    nodeLookup,
    clusters: refined,
    thoughtDetector,
    accumulator,
    respEngine,
    llm,
    maxAdjacencyDepth,
    onThought: options?.onThought,
    onArticulation: options?.onArticulation,
    prompt,
    trace,
    throttleCfg,
    throttleState,
  });

  const salientTokens = respEngine.getHighSalienceTokens(accumulator);
  const collapsed = collapseGraphToSalient(graph, refined, salientTokens);
  if (salientTokens.length) {
    trace.push(
      `Collapsed HLSF to ${collapsed.clusters.length} clusters anchored on salient tokens: ${salientTokens.join(', ')}.`,
    );
  }

  const finalArticulation: ArticulationEvent =
    articulation ?? {
      id: `articulation_${Date.now()}`,
      timestamp: Date.now(),
      articulationScore: 0.6,
      selectedThoughts: accumulator.thoughtEvents.slice(0, 3),
    };

  const filteredSelected = (finalArticulation.selectedThoughts ?? []).filter(ev =>
    ev.cluster.nodeIds.some(id => collapsed.keptNodeIds.has(id)),
  );
  if (filteredSelected.length) {
    finalArticulation.selectedThoughts = filteredSelected;
  }

  const salientSummary = summarizeSalientContext(salientTokens, collapsed.graph, collapsed.clusters);

  const llmResponse = await llm.articulateResponse(finalArticulation, prompt, {
    tokens: salientTokens,
    summary: salientSummary,
  });
  const response = craftResponse(prompt, trace, finalArticulation) + `\nLLM: ${llmResponse}`;
  trace.push('Generated emergent thought trace and articulated response.');

  return { trace, response };
}

export type { ReasonerResult };
