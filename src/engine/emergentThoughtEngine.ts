import {
  type ArticulationEvent,
  type ClusterResult,
  type DecompositionResult,
  type EmergentConfig,
  type EmergentResult,
  type HLSFGraph,
  type ReflectionResult,
  type RotationEvent,
  type RotationOptions,
  type SpectralFeatures,
  type StepResult,
} from './emergentThoughtTypes.js';

/**
 * Lightweight orchestration of the seven steps described in
 * docs/HLSF_EMERGENT_TRACE.md. Each function includes comments noting the
 * numbered step for future maintainers.
 */
export async function runEmergentThoughtProcess(
  prompt: string,
  config: EmergentConfig = {},
): Promise<EmergentResult> {
  const started = Date.now();
  const tokens = prompt.split(/\s+/).filter(Boolean);
  const decomposition = decomposePrompt(tokens.slice(0, config.maxTokens ?? tokens.length));
  const clusters = clusterConcepts(decomposition);
  let hlsf = buildHLSF(clusters);
  const reflection = config.enableReflection ? reflectInterconnections(hlsf) : { insights: [], interconnections: [] };
  if (!config.skipRefinement) {
    hlsf = refineHLSF(hlsf, reflection);
  }
  const steps: StepResult[] = [
    { step: 1, summary: `Decomposed ${decomposition.tokens.length} tokens` },
    { step: 2, summary: `Identified ${clusters.clusters.length} clusters` },
    { step: 3, summary: `Built HLSF with ${hlsf.nodes.length} nodes` },
  ];
  if (reflection.insights.length) {
    steps.push({ step: 4, summary: reflection.insights.join('; ') });
  }
  const trace = traceThoughts(steps);
  const structuredResponse = composeStructuredResponse(hlsf, trace);

  return {
    trace,
    structuredResponse,
    hlsf,
    meta: { elapsedMs: Date.now() - started, config },
  };
}

/**
 * Step 1: Prompt decomposition. Extract raw tokens and surface explicit
 * assumptions that need clarification.
 */
export function decomposePrompt(tokens: string[]): DecompositionResult {
  const assumptions = tokens.filter(t => t.endsWith('?')).map(t => `Assumption needed for ${t.replace(/\?$/, '')}`);
  return { tokens, assumptions };
}

/**
 * Step 2: Conceptual clustering. Groups tokens by simple prefix buckets to
 * provide deterministic grouping for now.
 */
export function clusterConcepts(decomposition: DecompositionResult): ClusterResult {
  const buckets = new Map<string, string[]>();
  for (const token of decomposition.tokens) {
    const key = token[0]?.toLowerCase() ?? 'misc';
    const list = buckets.get(key) ?? [];
    list.push(token);
    buckets.set(key, list);
  }

  const clusters = Array.from(buckets.entries()).map(([key, tokens], index) => ({
    id: `cluster-${index + 1}`,
    label: `Group ${key.toUpperCase()}`,
    tokens,
    rationale: `Grouped by initial token character ${key}`,
  }));

  return { clusters };
}

/**
 * Step 3: HLSF mapping. Converts clusters into graph nodes with simple edges
 * between sequential clusters so downstream renderers have structure.
 */
export function buildHLSF(clusters: ClusterResult): HLSFGraph {
  const nodes = clusters.clusters.map(cluster => ({
    id: cluster.id,
    label: cluster.label,
    clusterId: cluster.id,
  }));
  const edges = clusters.clusters.slice(1).map((cluster, idx) => ({
    id: `edge-${idx + 1}`,
    source: clusters.clusters[idx]?.id ?? cluster.id,
    target: cluster.id,
    description: 'Sequential linkage from decomposition order',
  }));
  return { nodes, edges, notes: 'Placeholder HLSF built from tokens' };
}

/**
 * Step 4: Interconnection reflection. Evaluates how clusters influence one
 * another and records ripple paths.
 */
export function reflectInterconnections(hlsf: HLSFGraph): ReflectionResult {
  const insights = hlsf.edges.map(edge => `Edge ${edge.id} connects ${edge.source} -> ${edge.target}`);
  const interconnections = hlsf.edges.map(edge => ({
    from: edge.source,
    to: edge.target,
    note: edge.description ?? 'Sequenced linkage',
  }));
  return { insights, interconnections };
}

/**
 * Step 5: Iterative refinement. Performs a lightweight deduplication pass.
 */
export function refineHLSF(hlsf: HLSFGraph, reflection: ReflectionResult): HLSFGraph {
  const uniqueEdges = new Map<string, typeof hlsf.edges[number]>();
  for (const edge of hlsf.edges) {
    uniqueEdges.set(`${edge.source}-${edge.target}`, edge);
  }
  return {
    ...hlsf,
    edges: Array.from(uniqueEdges.values()),
    notes: `${hlsf.notes ?? ''} Refined with ${reflection.insights.length} reflections.`.trim(),
  };
}

/**
 * Step 6: Emergent thought trace. Returns human-readable notes while keeping
 * the detailed reasoning internal.
 */
export function traceThoughts(steps: StepResult[]): string[] {
  return steps.map(step => `Step ${step.step}: ${step.summary}`);
}

/**
 * Step 7: Structured response composition. Produces a user-facing answer that
 * follows the HLSF ordering while separating internal trace details.
 */
export function composeStructuredResponse(hlsf: HLSFGraph, trace: string[]): string {
  const traceSection = trace.map(t => `- ${t}`).join('\n');
  const structureSection = hlsf.nodes
    .map(node => `* ${node.label}: synthesized insight based on ${node.clusterId ?? node.id}`)
    .join('\n');
  return [
    'Emergent Thought Trace:',
    traceSection,
    '',
    'Structured Response:',
    structureSection,
  ].join('\n');
}

// Re-export rotation helpers so callers can keep pipeline imports centralized
export type { RotationEvent, RotationOptions, SpectralFeatures };
