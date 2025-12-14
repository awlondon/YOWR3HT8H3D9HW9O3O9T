import { normalizeRelationship } from './relationshipMap.js';
import {
  computeContextualSalience,
  computeIntertwiningIndex,
  computeTokenSalience,
  topSalienceTokens,
  collapseGraph,
} from './salience.js';
import { deriveContextsFromGraph } from './contextBuilder.js';
import { projectToBasis } from './contextMeaning.js';
import type { ContextBasis } from './contextBasis.js';
import { embedTextToVector } from './embeddingStore.js';
import type { AdjacencyResult } from './adjacencyProvider.js';
import type { AdjacencyDelta, AdjacencyDeltaEdge, AdjacencyDeltaNode } from './cognitionTypes.js';
import type { HLSFGraph } from './cognitionCycle.js';
import { callLLM, type CognitionConfig, type LLMResult } from './cognitionCycle.js';
import { tokenizeWithSymbols } from '../tokens/tokenize.js';

type WorkingNode = { id: string; label: string; meta?: Record<string, unknown> };
type WorkingEdge = { src: string; dst: string; weight: number; role?: string; meta?: Record<string, unknown> };

type ContextInsight = {
  lines: string[];
  activeTokens: string[];
  hubProjections: Array<{ token: string; prob: number }>;
  intertwining: Array<{ token: string; score: number }>;
};

interface WorkingGraph {
  nodes: Map<string, WorkingNode>;
  edges: WorkingEdge[];
  metadata?: Record<string, unknown>;
}

export interface ConvergentConfig {
  depthMax: number;
  convergeMinCycles: number;
  salienceTopK: number;
  collapseRadius: number;
  firstLevelTopN: number;
  recurseBranches: number;
  recurseDepth: number;
  affinityThreshold: number;
  maxNodes: number;
  maxEdges: number;
  concurrency: number;
  allowSynthetic: boolean;
}

export interface ConvergentDeps {
  getAdjacency(token: string): Promise<AdjacencyResult>;
  applyDelta(graph: HLSFGraph, delta: AdjacencyDelta): void;
  commitGraph(graph: HLSFGraph): void;
  emitThought(traceLine: string): void;
  log(line: string): void;
  shouldAbort(): boolean;
  now(): number;
}

interface RunState {
  graph: WorkingGraph;
  visualGraph: HLSFGraph;
  trace: string[];
  lastHub?: string;
  embeddings: Map<string, number[]>;
  contexts: ContextBasis[];
  intertwining: Map<string, number>;
  activeContext?: ContextBasis;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'i', 'my', 'me', 'it', 'you']);

function slugify(token: string): string {
  return token.trim().toLowerCase().replace(/\s+/g, '-');
}

function ensureEmbedding(
  embeddings: Map<string, number[]>,
  id: string,
  label: string,
  hint?: number[],
): number[] {
  const existing = embeddings.get(id);
  if (existing?.length) return existing;
  const vector = hint && hint.length ? hint : embedTextToVector(label || id, 24);
  embeddings.set(id, vector);
  return vector;
}

function adjacencyToDelta(adjacency: AdjacencyResult): AdjacencyDelta {
  const centerId = slugify(adjacency.token) || adjacency.token;
  const nodes: AdjacencyDeltaNode[] = [
    { id: centerId, label: adjacency.token, meta: { source: adjacency.source } },
  ];
  const edges: AdjacencyDeltaEdge[] = adjacency.neighbors.map((neighbor) => ({
    src: centerId,
    dst: slugify(neighbor.token) || neighbor.token,
    weight: Number.isFinite(neighbor.weight) ? Number(neighbor.weight) : 0,
    role: normalizeRelationship(neighbor.rel),
    meta: { rel: neighbor.rel },
  }));
  adjacency.neighbors.forEach((neighbor) => {
    nodes.push({
      id: slugify(neighbor.token) || neighbor.token,
      label: neighbor.token,
      meta: { source: adjacency.source },
    });
  });
  return { nodes, edges, notes: adjacency.definition };
}

function applyDeltaToWorkingGraph(
  graph: WorkingGraph,
  delta: AdjacencyDelta,
  cfg: ConvergentConfig,
  embeddings: Map<string, number[]>,
): void {
  if (delta.nodes) {
    for (const node of delta.nodes) {
      if (graph.nodes.size >= cfg.maxNodes && !graph.nodes.has(node.id)) continue;
      if (!graph.nodes.has(node.id)) {
        graph.nodes.set(node.id, { id: node.id, label: node.label, meta: node.meta });
      }
      const label = node.label || node.id;
      ensureEmbedding(embeddings, node.id, label, node.hintEmbedding);
    }
  }
  if (delta.edges) {
    for (const edge of delta.edges) {
      if (graph.edges.length >= cfg.maxEdges) break;
      graph.edges.push({
        src: edge.src,
        dst: edge.dst,
        weight: edge.weight,
        role: edge.role,
        meta: edge.meta,
      });
    }
  }
}

function toHlsfGraph(graph: WorkingGraph, state?: RunState): HLSFGraph {
  const nodes = Array.from(graph.nodes.values()).map((node, index) => ({
    id: node.id,
    label: node.label,
    weight: 1,
    layer: index % 4,
    cluster: index % 5,
  }));
  const edges = graph.edges.map((edge, index) => ({
    id: `${edge.src}->${edge.dst}#${index}`,
    source: edge.src,
    target: edge.dst,
    weight: edge.weight,
    role: edge.role,
    meta: edge.meta,
  } as any));
  const metadata = Object.assign(
    {},
    graph.metadata || {},
    { updatedAt: Date.now() },
    state
      ? {
          embeddings: state.embeddings,
          contexts: state.contexts,
          activeContextId: state.activeContext?.id,
          intertwining: state.intertwining,
        }
      : {},
  );
  return { nodes, edges, metadata } as HLSFGraph;
}

function buildWorkingGraphFromVisual(graph: HLSFGraph): WorkingGraph {
  const nodes = new Map<string, WorkingNode>();
  (graph.nodes || []).forEach((node: any) => {
    nodes.set(node.id, { id: node.id, label: node.label, meta: (node as any).meta });
  });
  const edges: WorkingEdge[] = (graph.edges || []).map((edge: any) => ({
    src: edge.source ?? edge.src,
    dst: edge.target ?? edge.dst,
    weight: edge.weight ?? edge.w ?? 0,
    role: (edge as any).role,
    meta: (edge as any).meta,
  }));
  return { nodes, edges, metadata: graph.metadata as any };
}

function pickHub(
  graph: WorkingGraph,
  cfg: ConvergentConfig,
  lastHub?: string,
  salienceOverride?: Map<string, number>,
): string {
  const salience = salienceOverride ?? computeTokenSalience(graph as any);
  const top = topSalienceTokens(salience, cfg.salienceTopK).filter((token) => {
    const node = graph.nodes.get(token);
    if (!node) return false;
    return !STOPWORDS.has(node.label.toLowerCase());
  });
  if (top[0]) return top[0];
  if (lastHub) return lastHub;
  const first = graph.nodes.keys().next().value;
  return first || 'hub';
}

function refreshContextualSignals(
  state: RunState,
  hub: string,
  level: number,
  cfg: ConvergentConfig,
): Map<string, number> {
  state.contexts = deriveContextsFromGraph(
    state.graph,
    hub,
    { ringSize: cfg.firstLevelTopN, branchLimit: cfg.recurseBranches, level },
    state.embeddings,
  );
  state.intertwining = computeIntertwiningIndex(state.contexts);
  const hubLabel = state.graph.nodes.get(hub)?.label || hub;
  const hubVec = ensureEmbedding(state.embeddings, hub, hubLabel);
  if (state.contexts.length) {
    let best: { ctx: ContextBasis; score: number } | null = null;
    state.contexts.forEach((ctx) => {
      const { probs } = projectToBasis(hubVec, ctx);
      const score = probs.length ? Math.max(...probs) : 0;
      if (!best || score > best.score) {
        best = { ctx, score };
      }
    });
    state.activeContext = best?.ctx;
  } else {
    state.activeContext = undefined;
  }
  const contextualSalience = computeContextualSalience(
    state.graph as any,
    state.contexts,
    state.activeContext,
    state.embeddings,
  );
  return contextualSalience;
}

function buildContextInsight(state: RunState, hubToken: string): ContextInsight {
  const hubVec = state.embeddings.get(hubToken);
  const lines: string[] = [];
  const hubProjections: Array<{ token: string; prob: number }> = [];
  if (state.activeContext && hubVec) {
    const { probs } = projectToBasis(hubVec, state.activeContext);
    const paired = state.activeContext.tokenIds.map((token, idx) => ({
      token,
      prob: probs[idx] ?? 0,
    }));
    hubProjections.push(...paired.sort((a, b) => b.prob - a.prob).slice(0, 3));
  }

  state.contexts.forEach((ctx, idx) => {
    const tokens = ctx.tokenIds.slice(0, 8).join(', ');
    let projLabel = 'n/a';
    if (hubVec) {
      const { probs } = projectToBasis(hubVec, ctx);
      const projection = ctx.tokenIds
        .map((token, i) => ({ token, prob: probs[i] ?? 0 }))
        .sort((a, b) => b.prob - a.prob)
        .slice(0, 3)
        .map((entry) => `${entry.token}:${entry.prob.toFixed(2)}`)
        .join(', ');
      projLabel = projection || projLabel;
    }
    lines.push(`Context ${idx + 1} (${ctx.meta.source}) tokens: [${tokens || '—'}]; hub projection top-3: ${projLabel}`);
  });

  const intertwining = Array.from(state.intertwining.entries())
    .map(([token, score]) => ({ token, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    lines,
    activeTokens: state.activeContext?.tokenIds.slice(0, 8) ?? [],
    hubProjections,
    intertwining,
  };
}

function summarizeGraph(graph: WorkingGraph, hubToken: string, trace: string[], k = 12) {
  const salience = computeTokenSalience(graph as any);
  const topTokens = topSalienceTokens(salience, k);
  const weightedEdges = [...graph.edges]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, k)
    .map((edge) => {
      const src = graph.nodes.get(edge.src)?.label || edge.src;
      const dst = graph.nodes.get(edge.dst)?.label || edge.dst;
      return `${src} -(${edge.role ?? 'rel'}:${(edge.weight ?? 0).toFixed(2)})→ ${dst}`;
    });
  return {
    topTokens: topTokens.map((id) => graph.nodes.get(id)?.label || id),
    edges: weightedEdges,
    salience,
    trace,
    hubToken,
  };
}

async function articulate(
  graph: WorkingGraph,
  hubToken: string,
  trace: string[],
  input: { mode: 'prompt' | 'seed'; text: string },
  cfg: ConvergentConfig,
  state: RunState,
): Promise<{ response: string; llm?: LLMResult }>
// eslint-disable-next-line brace-style
{
  const summary = summarizeGraph(graph, hubToken, trace);
  const contextInsight = buildContextInsight(state, hubToken);
  const prompt = [
    `You are synthesizing a response from a localized semantic field graph.`,
    `Hub token: ${hubToken}`,
    `Input mode: ${input.mode}`,
    `Original text: ${input.text}`,
    `Top salient tokens: ${summary.topTokens.join(', ') || '—'}`,
    `Representative relationships:\n${summary.edges.join('\n') || 'None captured'}`,
    `Context frames:\n${contextInsight.lines.join('\n') || 'None'}`,
    `Trace lines:\n${trace.map((line) => `- ${line}`).join('\n') || 'None'}`,
    `Provide a coherent explanation or answer grounded in the hub and salient tokens.`,
  ].join('\n\n');

  const config: CognitionConfig = {
    thinkingStyle: 'analytic',
    iterations: Math.max(1, cfg.depthMax),
    rotationSpeed: 0.3,
    affinityThreshold: cfg.affinityThreshold,
    maxPromptWords: 120,
    maxIterations: cfg.depthMax,
  } as any;

  try {
    const llm = await callLLM(prompt, trace, config, 'visible', [], {
      rawPrompt: input.text,
      adjacencyTokens: summary.topTokens,
    });
    if (llm?.response) return { response: llm.response, llm };
  } catch (error) {
    // fall through to deterministic fallback
    console.warn('LLM articulation failed, using fallback', error);
  }

  const fallback = [
    `Hub: ${hubToken}`,
    `Top tokens: ${summary.topTokens.slice(0, 6).join(', ') || '—'}`,
    `Key relations:`,
    ...summary.edges.slice(0, 6),
    ...(contextInsight.lines.length ? ['Contexts:', ...contextInsight.lines.slice(0, 4)] : []),
    '',
    trace.length ? `Trace: ${trace.join(' | ')}` : 'Trace unavailable',
  ];
  return { response: fallback.join('\n') };
}

async function expandFrontier(
  frontier: string[],
  deps: ConvergentDeps,
  cfg: ConvergentConfig,
  state: RunState,
): Promise<void> {
  const queue = [...frontier];
  const active: Promise<void>[] = [];
  const processNext = async (): Promise<void> => {
    const token = queue.shift();
    if (!token || deps.shouldAbort()) return;
    const adjacency = await deps.getAdjacency(token);
    if (deps.shouldAbort()) return;
    const delta = adjacencyToDelta(adjacency);
    applyDeltaToWorkingGraph(state.graph, delta, cfg, state.embeddings);
    deps.applyDelta(state.visualGraph, delta);
    deps.log(`[converge] expand token=${token} neighbors=${adjacency.neighbors.length}`);
  };

  for (let i = 0; i < cfg.concurrency; i += 1) {
    active.push(
      (async function worker(): Promise<void> {
        while (queue.length && !deps.shouldAbort()) {
          await processNext();
        }
      })(),
    );
  }
  await Promise.all(active);
  state.visualGraph = toHlsfGraph(state.graph, state);
  deps.commitGraph(state.visualGraph);
}

async function buildFirstLevel(
  hubToken: string,
  deps: ConvergentDeps,
  cfg: ConvergentConfig,
  state: RunState,
  emit: (line: string) => void,
): Promise<void> {
  const adjacency = await deps.getAdjacency(hubToken);
  const sorted = [...adjacency.neighbors].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const topNeighbors = sorted.slice(0, cfg.firstLevelTopN);
  const filteredAdjacency: AdjacencyResult = {
    ...adjacency,
    neighbors: topNeighbors,
  };
  const delta = adjacencyToDelta(filteredAdjacency);
  state.graph = { nodes: new Map(), edges: [], metadata: {} };
  applyDeltaToWorkingGraph(state.graph, delta, cfg, state.embeddings);
  state.visualGraph = toHlsfGraph(state.graph, state);
  deps.applyDelta(state.visualGraph, delta);
  deps.commitGraph(state.visualGraph);
  const neighborList = topNeighbors.map((n) => n.token).join(', ');
  emit(`FIRST-LEVEL: hub=${hubToken} topN=${cfg.firstLevelTopN} neighbors=${neighborList}`);
}

async function recurseRing(
  hubToken: string,
  deps: ConvergentDeps,
  cfg: ConvergentConfig,
  state: RunState,
  emit: (line: string) => void,
): Promise<void> {
  const ring = [...state.graph.nodes.keys()].filter((id) => id !== slugify(hubToken));
  const visited = new Set<string>(ring);
  let depth = 0;
  let frontier = [...ring];
  while (frontier.length && depth < cfg.recurseDepth && !deps.shouldAbort()) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      const node = state.graph.nodes.get(nodeId);
      if (!node) continue;
      const adjacency = await deps.getAdjacency(node.label);
      const sorted = [...adjacency.neighbors].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      const neighbors = sorted.slice(0, cfg.recurseBranches);
      const delta = adjacencyToDelta({ ...adjacency, neighbors });
      applyDeltaToWorkingGraph(state.graph, delta, cfg, state.embeddings);
      deps.applyDelta(state.visualGraph, delta);
      neighbors.forEach((neighbor) => {
        const id = slugify(neighbor.token) || neighbor.token;
        if (!visited.has(id)) {
          visited.add(id);
          nextFrontier.push(neighbor.token);
        }
      });
      if (state.graph.nodes.size >= cfg.maxNodes || state.graph.edges.length >= cfg.maxEdges) break;
    }
    frontier = nextFrontier;
    depth += 1;
    state.visualGraph = toHlsfGraph(state.graph, state);
    deps.commitGraph(state.visualGraph);
  }
  emit(`RECURSE: depth=${cfg.recurseDepth} branches=${cfg.recurseBranches} nodes=${state.graph.nodes.size}`);
}

function normalizePromptSeed(input: { mode: 'prompt' | 'seed'; text: string }): string {
  const rawTokens = tokenizeWithSymbols(input.text).filter((t) => t?.kind === 'word');
  const words = rawTokens.map((t: any) => String(t.t || t.token || '').trim()).filter(Boolean);
  if (input.mode === 'seed') return words[0]?.toLowerCase?.() || input.text;
  const proper = words.find((t) => /^[A-Z]/.test(t));
  if (proper) return proper;
  const filtered = words.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  if (filtered.length) {
    const freq = new Map<string, number>();
    filtered.forEach((token) => {
      const key = token.toLowerCase();
      freq.set(key, (freq.get(key) || 0) + 1);
    });
    return filtered.sort((a, b) => (freq.get(b.toLowerCase()) || 0) - (freq.get(a.toLowerCase()) || 0))[0];
  }
  return words[0] || input.text || 'seed';
}

export async function runConvergentHlsf(
  input: { mode: 'prompt' | 'seed'; text: string },
  cfg: ConvergentConfig,
  deps: ConvergentDeps,
): Promise<{
  finalGraph: HLSFGraph;
  hubToken: string;
  trace: string[];
  responseText: string;
  contextInsight: ContextInsight;
}>
// eslint-disable-next-line brace-style
{
  const seedToken = normalizePromptSeed(input);
  deps.log(`[converge] seed=${seedToken}`);
  const trace: string[] = [];
  const emit = (line: string) => {
    trace.push(line);
    deps.emitThought(line);
  };
  const visualGraph: HLSFGraph = { nodes: [], edges: [], metadata: {} };
  const working: WorkingGraph = { nodes: new Map(), edges: [], metadata: {} };
  const state: RunState = {
    graph: working,
    visualGraph,
    trace,
    embeddings: new Map(),
    contexts: [],
    intertwining: new Map(),
  };
  const seedDelta: AdjacencyDelta = {
    nodes: [{ id: slugify(seedToken), label: seedToken }],
    edges: [],
  };
  applyDeltaToWorkingGraph(working, seedDelta, cfg, state.embeddings);
  deps.applyDelta(visualGraph, seedDelta);
  deps.commitGraph(toHlsfGraph(working, state));

  let hub = slugify(seedToken);
  let stableCount = 0;
  const frontierTokens = [seedToken];

  for (let level = 1; level <= cfg.depthMax; level += 1) {
    if (deps.shouldAbort()) break;
    await expandFrontier(frontierTokens.splice(0), deps, cfg, state);
    const contextualSalience = refreshContextualSignals(state, hub, level, cfg);
    const ranked = topSalienceTokens(contextualSalience, cfg.salienceTopK).filter((id) => {
      const node = state.graph.nodes.get(id);
      if (!node) return false;
      return !STOPWORDS.has(node.label.toLowerCase());
    });
    const salienceHub = ranked[0] || pickHub(state.graph, cfg, hub, contextualSalience);
    const runnerUpScore = ranked[1] ? contextualSalience.get(ranked[1]) || 0 : 0;
    const hubScore = contextualSalience.get(salienceHub) || 0;
    const marginGap = hubScore - runnerUpScore;
    if (salienceHub === hub) {
      stableCount += 1;
    } else {
      stableCount = 0;
    }
    hub = salienceHub;
    emit(`LEVEL ${level}: hub candidate = ${hub}`);
    deps.log(
      `[converge] level=${level} nodes=${state.graph.nodes.size} edges=${state.graph.edges.length} hub=${hub}`,
    );
    if (level >= cfg.convergeMinCycles && (stableCount >= 2 || marginGap >= 0.1)) {
      break;
    }
    frontierTokens.push(...ranked);
  }

  const collapsedWorking = collapseGraph(state.graph as any, [hub], cfg.collapseRadius) as any as WorkingGraph;
  state.graph = buildWorkingGraphFromVisual(toHlsfGraph(collapsedWorking, state));
  state.visualGraph = toHlsfGraph(state.graph, state);
  deps.commitGraph(state.visualGraph);
  emit(`CONVERGED: hub=${hub} → collapse radius=${cfg.collapseRadius} nodes=${state.graph.nodes.size}`);
  deps.log(
    `[converge] collapsed nodes=${state.graph.nodes.size} edges=${state.graph.edges.length}`,
  );

  await buildFirstLevel(hub, deps, cfg, state, emit);
  refreshContextualSignals(state, hub, cfg.depthMax + 1, cfg);
  state.visualGraph = toHlsfGraph(state.graph, state);
  deps.commitGraph(state.visualGraph);
  await recurseRing(hub, deps, cfg, state, emit);
  refreshContextualSignals(state, hub, cfg.depthMax + 2, cfg);
  state.visualGraph = toHlsfGraph(state.graph, state);
  deps.commitGraph(state.visualGraph);

  const contextInsight = buildContextInsight(state, hub);
  const articulation = await articulate(state.graph, hub, state.trace, input, cfg, state);
  return {
    finalGraph: state.visualGraph,
    hubToken: hub,
    trace: state.trace,
    responseText: articulation.response,
    contextInsight,
  };
}
