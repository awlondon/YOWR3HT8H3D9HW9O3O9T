export interface VisualizerNode {
  id: string;
  label?: string;
  weight?: number;
  layer?: number;
  cluster?: number;
  color?: string;
  status?: string;
  position?: [number, number];
  x?: number;
  y?: number;
  meta?: Record<string, unknown>;
}

export interface VisualizerEdge {
  id?: string;
  from?: string;
  to?: string;
  src?: string;
  dst?: string;
  source?: string;
  target?: string;
  weight?: number;
  w?: number;
  rtype?: string;
  role?: string;
  family?: string;
  meta?: Record<string, unknown>;
}

export interface VisualizerGraph {
  nodes: Map<string, VisualizerNode>;
  edges: VisualizerEdge[];
  links?: VisualizerEdge[];
  metadata?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  live?: boolean;
  dimensionLayout?: unknown;
}

function hashAngle(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (hash % 360) * (Math.PI / 180);
}

function ensurePosition(node: VisualizerNode): { x: number; y: number } {
  const pos = Array.isArray(node.position) ? node.position : null;
  const x = Number(pos?.[0]);
  const y = Number(pos?.[1]);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }
  const angle = hashAngle(node.id || 'node');
  const radius = 0.6;
  const px = Math.cos(angle) * radius;
  const py = Math.sin(angle) * radius;
  return { x: px, y: py };
}

function normalizeNode(node: VisualizerNode, id: string): VisualizerNode {
  const safeId = id || node?.id || '';
  const label = node?.label ?? (node as any)?.token ?? safeId;
  const weight = Number.isFinite(node?.weight) ? node.weight : 1;
  const layer = Number.isFinite(node?.layer) ? node.layer : Number(node?.meta?.layer ?? 0);
  const cluster = Number.isFinite(node?.cluster) ? node.cluster : Number(node?.meta?.cluster ?? 0);
  const position = ensurePosition({ ...node, id: safeId });
  return {
    ...node,
    id: safeId,
    label,
    weight,
    layer,
    cluster,
    position: [position.x, position.y],
    x: position.x,
    y: position.y,
  };
}

function normalizeEdges(edges: any[] = []): VisualizerEdge[] {
  const normalized: VisualizerEdge[] = [];
  edges.forEach((edge, idx) => {
    if (!edge) return;
    const source = edge.from ?? edge.src ?? edge.source ?? edge[0];
    const target = edge.to ?? edge.dst ?? edge.target ?? edge[1];
    if (!source || !target) return;
    const weight = Number.isFinite(edge.weight)
      ? edge.weight
      : Number.isFinite(edge.w)
        ? edge.w
        : 0.5;
    const role = edge.role ?? edge.rtype ?? edge.type ?? edge.rel ?? 'relation';
    normalized.push({
      id: edge.id ?? `${source}->${target}-${idx}`,
      from: source,
      to: target,
      src: source,
      dst: target,
      source,
      target,
      weight,
      w: weight,
      rtype: role,
      role,
      family: edge.family ?? edge.meta?.family ?? edge.rtypeFamily,
      meta: edge.meta ?? {},
    });
  });
  return normalized;
}

export function normalizeToVisualizerGraph(input: any): VisualizerGraph {
  if (!input) {
    return { nodes: new Map(), edges: [], links: [], metadata: {} };
  }

  const nodes = new Map<string, VisualizerNode>();
  if (input.nodes instanceof Map) {
    input.nodes.forEach((node: any, id: string) => {
      if (!id && !node?.id) return;
      const normalizedNode = normalizeNode(node, id || node.id);
      nodes.set(normalizedNode.id, normalizedNode);
    });
  } else if (Array.isArray(input.nodes)) {
    input.nodes.forEach((node: any) => {
      const nodeId = node?.id ?? node?.token;
      if (!nodeId) return;
      const normalizedNode = normalizeNode(node, String(nodeId));
      nodes.set(normalizedNode.id, normalizedNode);
    });
  }

  const edgeSource = Array.isArray(input.edges)
    ? input.edges
    : Array.isArray(input.links)
      ? input.links
      : [];
  const edges = normalizeEdges(edgeSource);

  const graph: VisualizerGraph = {
    ...input,
    nodes,
    edges,
    links: edges,
    metadata: input.metadata ?? input.meta ?? {},
  };

  return graph;
}
