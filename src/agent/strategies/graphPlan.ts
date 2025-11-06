import type { AgentContext, AgentPlan } from '../types';

function normalizeNodes(graph: any): Array<Record<string, any>> {
  if (!graph) return [];
  if (Array.isArray(graph.nodes)) {
    return graph.nodes as Array<Record<string, any>>;
  }
  if (graph.nodes instanceof Map) {
    return Array.from(graph.nodes.values()) as Array<Record<string, any>>;
  }
  if (typeof graph === 'object' && Array.isArray(graph)) {
    return graph as Array<Record<string, any>>;
  }
  if (typeof graph === 'object' && graph) {
    const maybeNodes = (graph as Record<string, unknown>).nodes;
    if (Array.isArray(maybeNodes)) {
      return maybeNodes as Array<Record<string, any>>;
    }
    if (maybeNodes instanceof Map) {
      return Array.from(maybeNodes.values()) as Array<Record<string, any>>;
    }
  }
  return [];
}

export async function graphPlan(ctx: AgentContext): Promise<AgentPlan | null> {
  const graph = ctx.state.graph;
  const nodes = normalizeNodes(graph);
  if (nodes.length === 0) {
    return null;
  }

  const scored = nodes
    .map(node => {
      const id = typeof node.id === 'string' ? node.id : String(node.token ?? node.name ?? '');
      const deg = Number((node as any).deg ?? (node as any).degree ?? 0) || 0;
      const weight = Number((node as any).w ?? (node as any).weight ?? 0) || 0;
      const frequency = Number((node as any).f ?? (node as any).frequency ?? 0) || 0;
      const noveltyPenalty = 1 + Math.max(0, frequency);
      const score = (deg + weight) / noveltyPenalty;
      return { id, score, deg, weight, frequency };
    })
    .filter(entry => entry.id)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return null;
  }

  const top = scored.slice(0, 3);
  const prompt = `Expand on: ${top.map(entry => entry.id).join(', ')}.\nAdd 3-5 adjacent concepts that deepen weakly connected areas and reveal hidden structure.`;

  return {
    prompt,
    rationale: `Targeting high-bridge/low-frequency nodes: ${top.map(entry => entry.id).join(', ')}`,
    meta: {
      selection: top,
      nodeCount: nodes.length,
    },
  };
}
