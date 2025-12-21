import { classifyRelation } from '../../types/adjacencyFamilies.js';

export interface TokenNode {
  token: string;
  kind: string;
  rawScore: number;
  index: number;
  cat?: string | null;
  meta?: Record<string, unknown>;
}

export interface AdjacencyEdge {
  source: string;
  target: string;
  type: string;
  w: number;
  family?: ReturnType<typeof classifyRelation>;
  meta?: Record<string, unknown>;
}

/** Deduplicate nodes by token, keeping the first occurrence. */
export function dedupNodesByToken<T extends TokenNode>(nodes: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const node of nodes) {
    const tok = node?.token ?? '';
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    result.push(node);
  }
  return result;
}

export interface RecursiveSkgOptions {
  depth: number;
  expander?: (levelEdges: AdjacencyEdge[], levelNodes: TokenNode[]) => {
    newNodes: TokenNode[];
    newEdges: AdjacencyEdge[];
    crossEdges: AdjacencyEdge[];
  };
}

function annotateLevel(nodes: TokenNode[], level: number): TokenNode[] {
  return nodes.map((node) => ({
    ...node,
    meta: { ...node.meta, level: (node.meta as any)?.level ?? level },
  }));
}

/**
 * Default SKG expander: duplicates each edge into an intermediate node that
 * represents the relationship. Original endpoints connect to the mid-node and
 * cross-level edges fully connect all intermediaries from the same level.
 */
export function defaultSkgExpander(
  levelEdges: AdjacencyEdge[],
  levelNodes: TokenNode[],
): { newNodes: TokenNode[]; newEdges: AdjacencyEdge[]; crossEdges: AdjacencyEdge[] } {
  const newEdges: AdjacencyEdge[] = [];
  const crossEdges: AdjacencyEdge[] = [];
  const nodeMap = new Map<string, TokenNode>();
  const weightMap = new Map<string, number>();

  for (const edge of levelEdges) {
    const id = `${edge.source}->${edge.target}`;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        token: id,
        kind: 'skg',
        rawScore: 0.75,
        index: levelNodes.length + nodeMap.size - 1,
        meta: { from: edge.source, to: edge.target },
      });
      weightMap.set(id, edge.w);
    }
    const mid = nodeMap.get(id)!;
    const baseFamily = classifyRelation('skg-base');
    const inheritedWeight = weightMap.get(id) ?? edge.w ?? 1;
    newEdges.push({
      source: edge.source,
      target: mid.token,
      w: inheritedWeight,
      type: 'skg-base',
      family: baseFamily,
    });
    newEdges.push({
      source: mid.token,
      target: edge.target,
      w: inheritedWeight,
      type: 'skg-base',
      family: baseFamily,
    });
  }

  const mids = Array.from(nodeMap.values());
  for (let i = 0; i < mids.length; i += 1) {
    for (let j = i + 1; j < mids.length; j += 1) {
      crossEdges.push({
        source: mids[i].token,
        target: mids[j].token,
        w: 0.5,
        type: 'skg-cross-level',
        family: classifyRelation('skg-cross-level'),
      });
    }
  }

  return { newNodes: mids, newEdges, crossEdges };
}

/**
 * Build recursive SKG adjacency starting from base nodes and edges. Applies the
 * provided expander function up to `depth` times, merging new nodes and edges
 * back into the working graph at each step.
 */
export function buildRecursiveSkgAdjacency(
  baseNodes: TokenNode[],
  baseEdges: AdjacencyEdge[],
  options: RecursiveSkgOptions,
): { nodes: TokenNode[]; edges: AdjacencyEdge[] } {
  const depth = Math.max(0, options.depth | 0);
  if (depth === 0) {
    return { nodes: dedupNodesByToken([...baseNodes]), edges: [...baseEdges] };
  }

  const expander = options.expander ?? defaultSkgExpander;
  let currentNodes = dedupNodesByToken(annotateLevel([...baseNodes], 0));
  let currentEdges = [...baseEdges];

  for (let i = 1; i <= depth; i += 1) {
    const { newNodes, newEdges, crossEdges } = expander(currentEdges, currentNodes);
    const annotated = annotateLevel(newNodes, i);
    currentNodes = dedupNodesByToken([...currentNodes, ...annotated]);
    const edgeMap = new Map<string, AdjacencyEdge>();
    for (const edge of [...currentEdges, ...newEdges, ...crossEdges]) {
      const key = `${edge.source}->${edge.target}:${edge.type}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, edge);
      }
    }
    currentEdges = Array.from(edgeMap.values());
  }

  return { nodes: currentNodes, edges: currentEdges };
}
