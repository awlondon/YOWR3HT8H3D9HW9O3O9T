import { StubLLMClient } from './llmClient.js';
import {
  type Cluster,
  type HlsfEdge,
  type HlsfGraph,
  type HlsfNode,
  type ReasoningStep,
  type ThoughtEvent,
  type ArticulationEvent,
} from './cognitionTypes.js';
import { ThoughtDetector } from './thoughtDetector.js';
import { ResponseAccumulatorEngine } from './responseAccumulator.js';
import { averageEmbedding, cosine } from './vectorUtils.js';

interface Token {
  label: string;
  type: 'noun' | 'verb' | 'relation' | 'other';
  index: number;
}

interface TraverseContext {
  graph: HlsfGraph;
  nodeEmbeddings: Map<string, number[]>;
  clusters: Cluster[];
  thoughtDetector: ThoughtDetector;
  accumulator: ReturnType<ResponseAccumulatorEngine['initAccumulator']>;
  respEngine: ResponseAccumulatorEngine;
  llm: StubLLMClient;
  onThought?: (ev: ThoughtEvent) => void;
  onArticulation?: (ev: ArticulationEvent) => void;
  prompt: string;
  trace: string[];
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

async function traverseGraph(context: TraverseContext): Promise<ArticulationEvent | null> {
  const visited = new Set<string>();
  const { clusters, thoughtDetector, nodeEmbeddings, respEngine, accumulator, llm, trace } = context;

  const dfs = async (index: number): Promise<ArticulationEvent | null> => {
    if (index < 0 || index >= clusters.length) return null;
    const cluster = clusters[index];
    if (visited.has(cluster.id)) return null;
    visited.add(cluster.id);

    const { structuralScore, spectralScore, semanticScore } = buildClusterFeatures(cluster, nodeEmbeddings);
    const thought = thoughtDetector.evaluateCluster(
      {
        cluster,
        structuralScore,
        spectralScore,
        semanticScore,
        nodeEmbeddings,
      },
      Date.now(),
    );

    if (thought) {
      respEngine.addThought(accumulator, thought);
      context.onThought?.(thought);
      trace.push(`Thought emitted on ${cluster.id} with score ${thought.thoughtScore.toFixed(2)}.`);

      const articulation = respEngine.maybeArticulate(accumulator, nodeEmbeddings, Date.now());
      if (articulation) {
        context.onArticulation?.(articulation);
        return articulation;
      }

      const delta = await llm.expandAdjacency(thought);
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
          nodeEmbeddings.set(n.id, newNode.embedding);
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
  const queryEmbedding = averageEmbedding([...nodeEmbeddings.values()]);
  const accumulator = respEngine.initAccumulator(queryEmbedding, Date.now());

  const articulation = await traverseGraph({
    graph,
    nodeEmbeddings,
    clusters: refined,
    thoughtDetector,
    accumulator,
    respEngine,
    llm,
    onThought: options?.onThought,
    onArticulation: options?.onArticulation,
    prompt,
    trace,
  });

  const finalArticulation: ArticulationEvent =
    articulation ?? {
      id: `articulation_${Date.now()}`,
      timestamp: Date.now(),
      articulationScore: 0.6,
      selectedThoughts: accumulator.thoughtEvents.slice(0, 3),
    };

  const llmResponse = await llm.articulateResponse(finalArticulation, prompt);
  const response = craftResponse(prompt, trace, finalArticulation) + `\nLLM: ${llmResponse}`;
  trace.push('Generated emergent thought trace and articulated response.');

  return { trace, response };
}

export type { ReasonerResult };
