import { collapseGraph, computeTokenSalience, topSalienceTokens } from './salience.js';

export interface BreathingConfig {
  dimension: number;
  depth: number;
  o10Size: number;
  ccBranches: number;
  collapseRadius: number;
  affinityThreshold: number;
  maxNodes: number;
  maxEdges: number;
  breathCycles: number;
  rotationItersPerCycle: number;
}

interface GraphNode {
  id: string;
  label?: string;
  embedding?: number[];
  meta?: Record<string, unknown>;
  appearanceFrequency?: number;
}

interface GraphEdge {
  src: string;
  dst: string;
  weight?: number;
  role?: string;
  layer?: string;
}

interface AdjacencyDelta {
  nodes?: Array<GraphNode & { hintEmbedding?: number[] }>;
  edges?: GraphEdge[];
}

export interface BreathingDeps {
  getGraph: () => { nodes?: Map<string, GraphNode> | GraphNode[]; edges?: GraphEdge[] } | undefined;
  setGraph: (graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] }) => void;
  expandAdjacency: (token: string) => Promise<AdjacencyDelta>;
  runEmergentRotation?: (
    graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] },
    options: { iterations: number },
  ) => Promise<{ intersections?: string[]; tokens?: string[] } | null>;
  computeSalience?: (graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] }) => Map<string, number>;
  collapseGraph?: (
    graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] },
    centers: string[] | string,
    radius: number,
  ) => { nodes: Map<string, GraphNode>; edges: GraphEdge[] };
  onThought?: (tokens: string[], meta?: Record<string, unknown>) => void;
  shouldAbort?: () => boolean;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/(^-|-$)+/g, '')
    .trim();
}

function ensureNodeMap(nodes: Map<string, GraphNode> | GraphNode[] | undefined): Map<string, GraphNode> {
  if (!nodes) return new Map();
  if (nodes instanceof Map) return nodes;
  return new Map(nodes.map((node) => [node.id, node]));
}

function isStopToken(token: string): boolean {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'i', 'my', 'me', 'it', 'you']);
  return stop.has(token.toLowerCase());
}

function applyDelta(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  delta: AdjacencyDelta,
  layer: string,
  limits: { maxNodes: number; maxEdges: number },
): void {
  const { maxNodes, maxEdges } = limits;
  if (Array.isArray(delta.nodes)) {
    for (const node of delta.nodes) {
      if (nodes.size >= maxNodes) break;
      if (!node?.id || nodes.has(node.id)) continue;
      nodes.set(node.id, {
        id: node.id,
        label: node.label ?? node.id,
        embedding: node.hintEmbedding ?? node.embedding ?? [],
        meta: { ...(node.meta ?? {}), layer },
        appearanceFrequency: 1,
      });
    }
  }

  if (Array.isArray(delta.edges)) {
    for (const edge of delta.edges) {
      if (edges.length >= maxEdges) break;
      if (!edge?.src || !edge.dst) continue;
      edges.push({
        src: edge.src,
        dst: edge.dst,
        weight: edge.weight ?? 0.1,
        role: edge.role ?? 'relation',
        layer,
      });
    }
  }
}

function pickSeedFromPrompt(prompt: string): string {
  const tokens = prompt
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9'-]/gi, ''))
    .filter(Boolean);
  const proper = tokens.find((t) => /^[A-Z]/.test(t));
  if (proper) return proper;
  const longest = tokens.filter((t) => !isStopToken(t)).sort((a, b) => b.length - a.length);
  return longest[0] || tokens[0] || 'seed';
}

function summarizeTokens(tokens: string[], limit: number): string {
  return tokens.slice(0, limit).join(', ');
}

export async function runBreathingLoop(
  seedTokenOrPrompt: string,
  cfg: BreathingConfig,
  deps: BreathingDeps,
): Promise<{ graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] }; collapsedGraph: any; hub: string; thoughtTraces: string[] }>
{
  const defaults = {
    o10Size: Math.max(3, cfg.o10Size || 9),
    ccBranches: Math.max(2, cfg.ccBranches || 5),
    breathCycles: cfg.breathCycles || Math.max(2, cfg.depth * 2),
    rotationItersPerCycle: cfg.rotationItersPerCycle || 3,
  };

  const source = deps.getGraph() || {};
  const nodes = ensureNodeMap(source.nodes);
  const edges = Array.isArray(source.edges) ? [...source.edges] : [];

  const baseSeed = seedTokenOrPrompt.trim() || 'seed';
  const seedToken = seedTokenOrPrompt.includes(' ') ? pickSeedFromPrompt(seedTokenOrPrompt) : baseSeed;
  const seedId = slugify(seedToken || 'seed');

  if (!nodes.has(seedId)) {
    nodes.set(seedId, { id: seedId, label: seedToken, embedding: [], meta: { layer: 'visible' }, appearanceFrequency: 1 });
  }

  let currentHub = seedId;
  let repeatedHub = 0;
  const thoughtTraces: string[] = [];

  for (let cycle = 0; cycle < defaults.breathCycles; cycle += 1) {
    if (deps.shouldAbort?.()) break;

    const hubLabel = nodes.get(currentHub)?.label || seedToken;
    const adjacency = await deps.expandAdjacency(hubLabel);
    applyDelta(nodes, edges, adjacency, 'visible', { maxNodes: cfg.maxNodes, maxEdges: cfg.maxEdges });

    const hubEdges = edges.filter((edge) => edge.src === currentHub || edge.dst === currentHub);
    const orderedHubEdges = hubEdges.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const ring = orderedHubEdges
      .map((edge) => (edge.src === currentHub ? edge.dst : edge.src))
      .filter(Boolean)
      .slice(0, defaults.o10Size);

    for (const ringNode of ring) {
      if (deps.shouldAbort?.()) break;
      const nodeLabel = nodes.get(ringNode)?.label || ringNode;
      const delta = await deps.expandAdjacency(nodeLabel);
      applyDelta(nodes, edges, delta, 'hidden', { maxNodes: cfg.maxNodes, maxEdges: cfg.maxEdges });
      const childEdges = edges
        .filter((edge) => edge.src === ringNode || edge.dst === ringNode)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      childEdges.slice(0, defaults.ccBranches).forEach((edge) => {
        const target = edge.src === ringNode ? edge.dst : edge.src;
        nodes.get(target)?.appearanceFrequency && (nodes.get(target)!.appearanceFrequency! += 1);
      });
    }

    deps.setGraph({ nodes, edges });

    let candidateTokens: string[] = [];
    if (deps.runEmergentRotation) {
      const rotation = await deps.runEmergentRotation({ nodes, edges }, { iterations: defaults.rotationItersPerCycle });
      if (rotation?.intersections?.length) {
        candidateTokens = rotation.intersections;
      } else if (rotation?.tokens?.length) {
        candidateTokens = rotation.tokens;
      }
    }

    const salienceMap = deps.computeSalience ? deps.computeSalience({ nodes, edges }) : computeTokenSalience({ nodes, edges });
    let nextHub = currentHub;
    if (candidateTokens.length) {
      const prioritized = candidateTokens.find((token) => !isStopToken(token));
      nextHub = prioritized || candidateTokens[0] || currentHub;
    } else {
      const ranked = topSalienceTokens(salienceMap, cfg.o10Size * 2).filter((token) => !isStopToken(token));
      nextHub = ranked[0] || currentHub;
    }

    const collapsed = deps.collapseGraph
      ? deps.collapseGraph({ nodes, edges }, [nextHub], cfg.collapseRadius)
      : collapseGraph({ nodes, edges }, [nextHub], cfg.collapseRadius);

    if (collapsed?.nodes) {
      nodes.clear();
      collapsed.nodes.forEach((node, id) => nodes.set(id, node));
    }
    if (Array.isArray(collapsed?.edges)) {
      edges.length = 0;
      collapsed.edges.forEach((edge) => edges.push(edge));
    }

    deps.setGraph({ nodes, edges });

    const ringSample = summarizeTokens(ring, 3);
    const ccSample = summarizeTokens(topSalienceTokens(salienceMap, 6).filter((t) => !isStopToken(t)), 3);
    const trace = `Hub: ${nextHub} | ring: ${ringSample || '—'} | cc: ${ccSample || '—'}`;
    thoughtTraces.push(trace);

    const thoughtTokens = [nextHub, ...ring.slice(0, 2), ...ccSample.split(',').map((t) => t.trim())].filter(Boolean);
    deps.onThought?.(thoughtTokens, { cycle, hub: nextHub });

    if (nextHub === currentHub) {
      repeatedHub += 1;
      if (repeatedHub >= 1) break;
    } else {
      repeatedHub = 0;
    }

    currentHub = nextHub;
  }

  const finalGraph = { nodes, edges };
  const collapsedGraph = deps.collapseGraph
    ? deps.collapseGraph(finalGraph, [currentHub], cfg.collapseRadius)
    : collapseGraph(finalGraph as any, [currentHub], cfg.collapseRadius);
  deps.setGraph(collapsedGraph as any);

  return { graph: finalGraph, collapsedGraph, hub: currentHub, thoughtTraces };
}
