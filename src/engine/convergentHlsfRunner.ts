import { normalizeRelationship } from './relationshipMap.js';
import { computeTokenSalience, topSalienceTokens, collapseGraph } from './salience.js';
import type { AdjacencyResult } from './adjacencyProvider.js';
import type { AdjacencyDelta, AdjacencyDeltaEdge, AdjacencyDeltaNode } from './cognitionTypes.js';
import type { HLSFGraph } from './cognitionCycle.js';
import { callLLM, type CognitionConfig, type LLMResult } from './cognitionCycle.js';
import { tokenizeWithSymbols } from '../tokens/tokenize.js';

type WorkingNode = { id: string; label: string; meta?: Record<string, unknown> };
type WorkingEdge = { src: string; dst: string; weight: number; role?: string; meta?: Record<string, unknown> };

interface WorkingGraph {
  nodes: Map<string, WorkingNode>;
  edges: WorkingEdge[];
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
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'i', 'my', 'me', 'it', 'you']);

function slugify(token: string): string {
  return token.trim().toLowerCase().replace(/\s+/g, '-');
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

function applyDeltaToWorkingGraph(graph: WorkingGraph, delta: AdjacencyDelta, cfg: ConvergentConfig): void {
  if (delta.nodes) {
    for (const node of delta.nodes) {
      if (graph.nodes.size >= cfg.maxNodes && !graph.nodes.has(node.id)) continue;
      if (!graph.nodes.has(node.id)) {
        graph.nodes.set(node.id, { id: node.id, label: node.label, meta: node.meta });
      }
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

function toHlsfGraph(graph: WorkingGraph): HLSFGraph {
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
  return { nodes, edges, metadata: { updatedAt: Date.now() } } as HLSFGraph;
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
  return { nodes, edges };
}

function pickHub(graph: WorkingGraph, cfg: ConvergentConfig, lastHub?: string): string {
  const salience = computeTokenSalience(graph as any);
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
): Promise<{ response: string; llm?: LLMResult }>
// eslint-disable-next-line brace-style
{
  const summary = summarizeGraph(graph, hubToken, trace);
  const prompt = [
    `You are synthesizing a response from a localized semantic field graph.`,
    `Hub token: ${hubToken}`,
    `Input mode: ${input.mode}`,
    `Original text: ${input.text}`,
    `Top salient tokens: ${summary.topTokens.join(', ') || '—'}`,
    `Representative relationships:\n${summary.edges.join('\n') || 'None captured'}`,
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
    applyDeltaToWorkingGraph(state.graph, delta, cfg);
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
  state.visualGraph = toHlsfGraph(state.graph);
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
  state.graph = { nodes: new Map(), edges: [] };
  applyDeltaToWorkingGraph(state.graph, delta, cfg);
  state.visualGraph = toHlsfGraph(state.graph);
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
      applyDeltaToWorkingGraph(state.graph, delta, cfg);
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
    state.visualGraph = toHlsfGraph(state.graph);
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
): Promise<{ finalGraph: HLSFGraph; hubToken: string; trace: string[]; responseText: string }>
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
  const working: WorkingGraph = { nodes: new Map(), edges: [] };
  const state: RunState = { graph: working, visualGraph, trace };
  const seedDelta: AdjacencyDelta = {
    nodes: [{ id: slugify(seedToken), label: seedToken }],
    edges: [],
  };
  applyDeltaToWorkingGraph(working, seedDelta, cfg);
  deps.applyDelta(visualGraph, seedDelta);
  deps.commitGraph(toHlsfGraph(working));

  let hub = slugify(seedToken);
  let stableCount = 0;
  const frontierTokens = [seedToken];

  for (let level = 1; level <= cfg.depthMax; level += 1) {
    if (deps.shouldAbort()) break;
    await expandFrontier(frontierTokens.splice(0), deps, cfg, state);
    const salienceHub = pickHub(state.graph, cfg, hub);
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
    if (level >= cfg.convergeMinCycles && stableCount >= 1) {
      break;
    }
    frontierTokens.push(...topSalienceTokens(computeTokenSalience(state.graph as any), cfg.salienceTopK));
  }

  const collapsedWorking = collapseGraph(state.graph as any, [hub], cfg.collapseRadius) as any as WorkingGraph;
  state.graph = buildWorkingGraphFromVisual(toHlsfGraph(collapsedWorking));
  state.visualGraph = toHlsfGraph(state.graph);
  deps.commitGraph(state.visualGraph);
  emit(`CONVERGED: hub=${hub} → collapse radius=${cfg.collapseRadius} nodes=${state.graph.nodes.size}`);
  deps.log(
    `[converge] collapsed nodes=${state.graph.nodes.size} edges=${state.graph.edges.length}`,
  );

  await buildFirstLevel(hub, deps, cfg, state, emit);
  await recurseRing(hub, deps, cfg, state, emit);

  const articulation = await articulate(state.graph, hub, state.trace, input, cfg);
  return { finalGraph: state.visualGraph, hubToken: hub, trace: state.trace, responseText: articulation.response };
}
