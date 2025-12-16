import { tokenizeWords } from '../tokens/tokenize.js';
import { computeCosineSimilarity } from '../vector/similarity.js';
import { callLLM as dispatchLlmRequest, resolveEndpoint as resolveLlmEndpoint } from './llmClient.js';
import {
  engineTick,
  onNewUserQuestion,
  registerAdjacencyDeltaHandler,
  registerArticulationHandler,
  registerThoughtEventHandler,
  updateEngineGraph,
} from './mainLoop.js';
import {
  type EdgeRole,
  type SpectralFeatures,
  type Node as EngineNode,
  type Edge as EngineEdge,
  type AdjacencyDelta,
  type ThoughtEvent,
  type ArticulationEvent,
} from './cognitionTypes.js';
import { computeSpectralFeaturesFromSeries } from './spectralUtils.js';

export type ThinkingStyle = 'concise' | 'analytic' | 'dreamlike' | 'dense';

export interface CognitionConfig {
  thinkingStyle: ThinkingStyle;
  iterations: number;
  rotationSpeed: number;
  affinityThreshold: number;
  maxPromptWords: number;
  maxIterations: number;
  /** Optional cap on how many tokens are kept per rotation. */
  maxTokensPerThought?: number;
  /** Optional angle spacing (in degrees) before flushing token batches to the UI. */
  tokenBatchAngle?: number;
}

export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  coherenceScore: number;
  clusters?: number;
}

interface HlsfNode {
  id: string;
  label: string;
  weight: number;
  layer: number;
  cluster: number;
}

interface HlsfEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
}

export interface HLSFGraph {
  nodes: HlsfNode[];
  edges: HlsfEdge[];
  metadata?: Record<string, unknown>;
  intersections?: IntersectionEvent[];
  spectralFeatures?: Record<string, SpectralFeatures>;
}

export const HLSF_ROTATION_EVENT = 'hlsf:rotation-preview';
export const HLSF_THOUGHT_COMMIT_EVENT = 'hlsf:thought-commit';

export interface RotationPreviewEventDetail {
  active: boolean;
  iteration: number;
  graph: HLSFGraph | null;
}

export interface ThoughtCommitEventDetail {
  iteration: number;
  text: string;
}

export interface IntersectionEvent {
  a: string;
  b: string;
  angle: number;
  affinity: number;
  tokens: string[];
}

export interface LLMResult {
  model: string;
  temperature: number;
  response: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  error?: string;
  isFallback?: boolean;
  endpoint?: string;
  status?: number;
  rawError?: string;
  fallbackText?: string;
  fallbackReason?: string;
  emergentTrace?: string[];
  lengthStatus?: 'ok' | 'length_violation';
}

export type CognitionMode = 'visible' | 'hidden';

export interface CognitionHistoryEntry {
  iteration: number;
  mode: CognitionMode;
  prompt: string;
  normalizedPrompt: string;
  response: string;
  hiddenPrompt?: string;
}

export interface ThoughtSummary {
  id: string;
  input: string;
  intersectionTokens: string[];
  metrics: {
    tokenCount: number;
    edgeCount: number;
    integrationScore: number;
  };
}

export interface CognitionRun {
  id: string;
  cycleIndex: number;
  timestamp: string;
  mode: CognitionMode;
  config: CognitionConfig;
  input: {
    userPrompt: string;
    rawPrompt?: string;
  };
  historyContext: CognitionHistoryEntry[];
  graphs: {
    visibleGraphSummary: GraphSummary;
    hiddenGraphSummary: GraphSummary;
  };
  thoughts: {
    perIterationTokens: string[][];
    perIterationText: string[];
    interpretationText?: string;
    adjacencyTokens?: string[];
    emergentTrace?: Record<string, string[]>;
  };
  llm: LLMResult;
  summary: ThoughtSummary;
}

export type CognitionTerminationReason = 'maxIterations' | 'exit' | 'error';

export interface CognitionCycleResult {
  cycleId: string;
  runs: CognitionRun[];
  history: CognitionHistoryEntry[];
  finalRun: CognitionRun | null;
  terminatedBy: CognitionTerminationReason;
  error?: string;
}

interface ThoughtNode {
  interpretationText?: string;
  rawText?: string;
  adjacencyTokens?: string[];
  rotationSummary?: string;
}

interface RotationResult {
  perIterationTokens: string[][];
  perIterationText: string[];
  emergentTrace: Record<string, string[]>;
}

interface ThoughtIterationDom {
  root: HTMLElement;
  tokensEl: HTMLElement;
  textEl: HTMLElement;
}

let activeRotationConfig: CognitionConfig | null = null;
let activeIterationIndex = 0;
const iterationDom = new Map<number, ThoughtIterationDom>();
const tokenStreamQueues = new Map<number, Promise<void>>();
const EDGE_ROLES: EdgeRole[] = ['cause', 'contrast', 'analogy', 'instance', 'meta'];
const FFT_WINDOW = 32;
let activeHiddenGraph: HLSFGraph | null = null;
let latestSpectralFeatures: Map<string, SpectralFeatures> = new Map();
let pendingArticulation: ArticulationEvent | null = null;
let articulationTriggered = false;

registerThoughtEventHandler(handleThoughtEventTokens);
registerAdjacencyDeltaHandler(applyAdjacencyDeltaToHiddenGraph);
registerArticulationHandler(handleArticulationResponse);

function getThoughtIterationRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('thought-iteration-log');
}

function ensureThoughtLogPanelVisible(root: HTMLElement): void {
  if (!root) return;
  const panel = root.closest('.thought-log-panel');
  const debugVisible = panel instanceof HTMLElement && panel.classList.contains('is-debug-visible');
  root.setAttribute('aria-hidden', debugVisible ? 'false' : 'true');
}

function createThoughtIterationDom(root: HTMLElement, iterationIndex: number): ThoughtIterationDom {
  const block = document.createElement('div');
  block.className = 'thought-iteration';
  block.dataset.iteration = String(iterationIndex);

  const header = document.createElement('div');
  header.className = 'thought-iteration__header';
  header.textContent = `Rotation ${iterationIndex + 1}`;

  const tokensEl = document.createElement('div');
  tokensEl.className = 'thought-iteration__tokens';

  const textEl = document.createElement('div');
  textEl.className = 'thought-iteration__text';
  textEl.textContent = 'Awaiting synthesis…';

  block.append(header, tokensEl, textEl);
  root.appendChild(block);
  const entry: ThoughtIterationDom = { root: block, tokensEl, textEl };
  iterationDom.set(iterationIndex, entry);
  return entry;
}

function ensureThoughtLogIterationEntry(iterationIndex: number): ThoughtIterationDom | null {
  let entry = iterationDom.get(iterationIndex);
  if (entry) return entry;
  const root = getThoughtIterationRoot();
  if (!root) return null;
  ensureThoughtLogPanelVisible(root);
  for (let nextIndex = iterationDom.size; nextIndex <= iterationIndex; nextIndex += 1) {
    createThoughtIterationDom(root, nextIndex);
  }
  entry = iterationDom.get(iterationIndex) ?? null;
  return entry;
}

async function executeCognitionPass(
  rawPrompt: string,
  config: CognitionConfig,
  history: CognitionHistoryEntry[],
  cycleIndex: number,
): Promise<CognitionRun> {
  const mode = detectCognitionMode(rawPrompt);
  const normalizedPrompt = normalizePromptForMode(rawPrompt, mode);
  const truncatedPrompt = truncateToWords(normalizedPrompt, config.maxPromptWords);

  const visibleGraph = expandVisibleGraph(truncatedPrompt);
  const visibleSummary = summarizeGraph(visibleGraph);

  const hiddenGraph = expandHiddenGraph(visibleGraph);
  const hiddenSummary = summarizeGraph(hiddenGraph);

  activeRotationConfig = config;
  prepareThoughtLogUI(config.iterations);
  const { perIterationTokens, perIterationText, emergentTrace } = await runEmergentRotation(
    hiddenGraph,
    config,
    truncatedPrompt,
  );
  const interpretationText = perIterationText[perIterationText.length - 1];
  const baseAdjacencyTokens = perIterationTokens.flat().filter(token => Boolean(token));
  const articulationContext = pendingArticulation
    ? summarizeArticulationThoughts(pendingArticulation, hiddenGraph)
    : null;
  const llmThoughts = articulationContext?.thoughts?.length
    ? articulationContext.thoughts
    : perIterationText;
  const adjacencyTokens = articulationContext?.adjacencyTokens?.length
    ? articulationContext.adjacencyTokens
    : baseAdjacencyTokens;
  pendingArticulation = null;

  const llmResult = await callLLM(
    truncatedPrompt,
    llmThoughts,
    config,
    mode,
    history,
    {
      interpretationText,
      rawPrompt,
      adjacencyTokens,
    },
  );

  const runId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const summary = buildThoughtSummary(
    runId,
    hiddenGraph,
    truncatedPrompt,
  );

  const run: CognitionRun = {
    id: runId,
    cycleIndex,
    timestamp: new Date().toISOString(),
    mode,
    config,
    input: { userPrompt: truncatedPrompt, rawPrompt },
    historyContext: history.map(entry => ({ ...entry })),
    graphs: {
      visibleGraphSummary: visibleSummary,
      hiddenGraphSummary: hiddenSummary,
    },
    thoughts: { perIterationTokens, perIterationText, interpretationText, adjacencyTokens, emergentTrace },
    llm: llmResult,
    summary,
  };

  await persistRun(run);

  return run;
}

export async function runCognitionCycle(
  initialPrompt: string,
  config: CognitionConfig,
): Promise<CognitionCycleResult> {
  const sanitizedConfig = normalizeConfig(config);
  const cycleId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const runs: CognitionRun[] = [];
  const history: CognitionHistoryEntry[] = [];
  let termination: CognitionTerminationReason = 'maxIterations';
  let errorMessage: string | undefined;

  let currentPrompt = initialPrompt;
  let iteration = 0;

  while (iteration < sanitizedConfig.maxIterations) {
    if (!currentPrompt || !currentPrompt.trim()) break;
    try {
      const run = await executeCognitionPass(
        currentPrompt,
        sanitizedConfig,
        history,
        iteration,
      );
      runs.push(run);
      const entry: CognitionHistoryEntry = {
        iteration,
        mode: run.mode,
        prompt: currentPrompt,
        normalizedPrompt: run.input.userPrompt,
        response: run.llm.response,
      };
      history.push(entry);

      if (run.llm.error) {
        termination = 'error';
        errorMessage = formatLlmError(run.llm);
        updateThoughtLogStatus(`LLM request failed: ${errorMessage}`);
        break;
      }

      if (shouldExitCycle(run.llm.response)) {
        termination = 'exit';
        break;
      }

      const responseText = run.llm.response?.trim() ?? '';

      if (articulationTriggered) {
        termination = 'exit';
        articulationTriggered = false;
        break;
      }

      const hasMaterialResponse = responseText.split(/\s+/).filter(Boolean).length >= 8;

      if (run.mode === 'visible' && hasMaterialResponse) {
        if (!responseText) {
          termination = 'error';
          errorMessage = 'LLM produced an empty visible response; hidden reflection skipped.';
          updateThoughtLogStatus(
            'Unable to continue: visible response was empty, so hidden reflection was skipped.',
          );
          break;
        }
        const hiddenPrompt = composeHiddenPrompt(history);
        entry.hiddenPrompt = hiddenPrompt;
        currentPrompt = hiddenPrompt;
      } else {
        currentPrompt = truncateToWords(responseText, sanitizedConfig.maxPromptWords);
        if (!hasMaterialResponse) {
          termination = 'exit';
          break;
        }
      }

      if (shouldExitCycle(currentPrompt)) {
        termination = 'exit';
        break;
      }
    } catch (error) {
      termination = 'error';
      errorMessage = error instanceof Error ? error.message : String(error);
      break;
    }

    iteration += 1;
  }

  const result: CognitionCycleResult = {
    cycleId,
    runs,
    history,
    finalRun: runs[runs.length - 1] ?? null,
    terminatedBy: termination,
    error: errorMessage,
  };

  await persistCycleResult(result);

  return result;
}

export function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (!maxWords || words.length <= maxWords) {
    return text.trim();
  }
  return words.slice(0, Math.max(1, maxWords)).join(' ');
}

export function collapseRotationNarrative(thoughts: string[], maxWords = 100): string | null {
  if (!Array.isArray(thoughts)) return null;
  const segments = thoughts
    .map(entry => (typeof entry === 'string' ? entry.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean);
  if (!segments.length) return null;
  const combined = segments.join(' ');
  const truncated = truncateToWords(combined, maxWords).replace(/\s+/g, ' ').trim();
  return truncated || null;
}

function summarizeArticulationThoughts(
  articulation: ArticulationEvent,
  graph: HLSFGraph,
): { thoughts: string[]; adjacencyTokens: string[] } {
  const labelLookup = new Map(graph.nodes.map(node => [node.id, node.label || node.id]));
  const thoughts = articulation.selectedThoughts.map((thought, idx) => {
    const labels = thought.cluster.nodeIds
      .map(id => labelLookup.get(id) || id)
      .filter(Boolean)
      .slice(0, 8);
    const score = Number.isFinite(thought.thoughtScore) ? thought.thoughtScore.toFixed(2) : '0.00';
    return `Thought ${idx + 1} (score ${score}): ${labels.join(', ')}`.trim();
  });

  const adjacencyTokens = Array.from(
    new Set(
      articulation.selectedThoughts.flatMap(thought =>
        thought.cluster.nodeIds.map(id => labelLookup.get(id) || id),
      ),
    ),
  )
    .filter(Boolean)
    .slice(0, 24);

  return { thoughts, adjacencyTokens };
}

const HIDDEN_PROMPT_PREFIXES = ['/hidden', '/expand'];
const escapeForRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HIDDEN_PROMPT_PATTERN = new RegExp(
  `^\\s*(?:${HIDDEN_PROMPT_PREFIXES.map(prefix => escapeForRegex(prefix)).join('|')})\\s*`,
  'i',
);

function detectCognitionMode(prompt: string): CognitionMode {
  const normalized = prompt?.trim().toLowerCase() ?? '';
  return HIDDEN_PROMPT_PREFIXES.some(prefix => normalized.startsWith(prefix)) ? 'hidden' : 'visible';
}

function normalizePromptForMode(prompt: string, mode: CognitionMode): string {
  if (mode !== 'hidden') {
    return prompt;
  }
  return prompt.replace(HIDDEN_PROMPT_PATTERN, '').trim();
}

export function composeHiddenPrompt(history: CognitionHistoryEntry[]): string {
  const lastVisible = [...history]
    .reverse()
    .find(entry => entry.mode === 'visible');
  const fallback = history.length ? history[history.length - 1]?.response?.trim() : '';
  const reference = lastVisible?.response?.trim() || fallback;
  const promptLines = [
    '/hidden Provide a concise rotation reflection on the previous visible answer.',
    'Rotate through three axes in order: horizontal, longitudinal, then sagittal.',
    'At each axis crossing, briefly note key intersections or overlaps.',
    'Summarize the main insight from those intersections before moving to the next axis.',
    'Close with a short overall takeaway combining all three rotations. Keep it tight—avoid verbose loops.',
  ];
  if (reference) {
    promptLines.push(`Reference answer: ${reference}`);
  }
  return promptLines.join('\n');
}

function shouldExitCycle(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  return normalized === '/exit' || normalized.startsWith('/exit ');
}

function normalizeConfig(config: CognitionConfig): CognitionConfig {
  const iterations = Number.isFinite(config?.iterations) ? Math.max(1, Math.round(config.iterations)) : 4;
  const rotationSpeed = Number.isFinite(config?.rotationSpeed)
    ? Number(config.rotationSpeed)
    : 0.3;
  const affinityThreshold = clamp01(config?.affinityThreshold ?? 0.35);
  const maxPromptWords = Number.isFinite(config?.maxPromptWords)
    ? Math.max(1, Math.round(config.maxPromptWords))
    : 100;
  const thinkingStyle: ThinkingStyle = config?.thinkingStyle ?? 'analytic';
  const maxIterations = Number.isFinite(config?.maxIterations)
    ? Math.max(1, Math.round(config.maxIterations))
    : Math.max(1, iterations * 2);
  const maxTokensPerThought = Number.isFinite(config?.maxTokensPerThought)
    ? Math.max(8, Math.round(config.maxTokensPerThought))
    : 50;
  const tokenBatchAngle = Number.isFinite(config?.tokenBatchAngle)
    ? Math.min(90, Math.max(1, Number(config.tokenBatchAngle)))
    : 12;
  return {
    thinkingStyle,
    iterations,
    rotationSpeed,
    affinityThreshold,
    maxPromptWords,
    maxIterations,
    maxTokensPerThought,
    tokenBatchAngle,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function expandVisibleGraph(prompt: string): HLSFGraph {
  return hlsfExpandFromPrompt(prompt);
}

function expandHiddenGraph(visibleGraph: HLSFGraph): HLSFGraph {
  return hlsfHiddenExpand(visibleGraph);
}

function hlsfExpandFromPrompt(prompt: string): HLSFGraph {
  const tokens = tokenizeWords(prompt);
  const frequency = new Map<string, { count: number; firstIndex: number }>();

  tokens.forEach((token, index) => {
    const key = token.t.toLowerCase();
    if (!key) return;
    const entry = frequency.get(key);
    if (!entry) {
      frequency.set(key, { count: 1, firstIndex: index });
    } else {
      entry.count += 1;
    }
  });

  const nodes: HlsfNode[] = Array.from(frequency.entries()).map(([label, meta], index) => ({
    id: label,
    label,
    weight: meta.count,
    layer: meta.firstIndex % 3,
    cluster: index % 5,
  }));

  const edges: HlsfEdge[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const from = tokens[i];
    const to = tokens[i + 1];
    if (!from?.t || !to?.t) continue;
    const source = from.t.toLowerCase();
    const target = to.t.toLowerCase();
    const weight = 0.5 + Math.abs(computeCosineSimilarity(from.t, to.t));
    edges.push({
      id: `${source}-${target}-${i}`,
      source,
      target,
      weight,
    });
  }

  return { nodes, edges, metadata: { source: 'visible', promptLength: prompt.length } };
}

function hlsfHiddenExpand(visibleGraph: HLSFGraph): HLSFGraph {
  const hiddenNodes: HlsfNode[] = visibleGraph.nodes.map(node => ({ ...node }));
  const hiddenEdges: HlsfEdge[] = visibleGraph.edges.map(edge => ({ ...edge }));

  const clusterCount = Math.max(1, Math.round(Math.sqrt(Math.max(1, hiddenNodes.length))));
  for (let i = 0; i < clusterCount; i += 1) {
    const node: HlsfNode = {
      id: `latent-${i}`,
      label: `Latent Field ${i + 1}`,
      weight: 1 + i,
      layer: 3 + (i % 3),
      cluster: i,
    };
    hiddenNodes.push(node);
  }

  for (const node of hiddenNodes) {
    if (!node.id.startsWith('latent-')) continue;
    const attach = visibleGraph.nodes.filter(n => n.cluster === node.cluster % 5).slice(0, 3);
    attach.forEach(target => {
      hiddenEdges.push({
        id: `${node.id}->${target.id}`,
        source: node.id,
        target: target.id,
        weight: 0.4 + target.weight / Math.max(1, visibleGraph.nodes.length),
      });
    });
  }

  const graph: HLSFGraph = {
    nodes: hiddenNodes,
    edges: hiddenEdges,
    metadata: { source: 'hidden', derivedFrom: visibleGraph.nodes.length },
  };

  graph.intersections = buildIntersectionSchedule(graph);
  return graph;
}

function summarizeGraph(graph: HLSFGraph): GraphSummary {
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    coherenceScore: Number(computeCoherence(graph).toFixed(2)),
    clusters: estimateClusterCount(graph),
  };
}

function computeCoherence(graph: HLSFGraph): number {
  if (!graph.nodes.length) return 0;
  const density = graph.edges.length / Math.max(1, graph.nodes.length * 2);
  const avgWeight = graph.edges.reduce((sum, edge) => sum + (edge.weight ?? 0), 0) /
    Math.max(1, graph.edges.length);
  return clamp01(density * 0.6 + clamp01(avgWeight) * 0.4);
}

function estimateClusterCount(graph: HLSFGraph): number {
  if (!graph.nodes.length) return 0;
  return Math.max(1, Math.round(Math.sqrt(graph.nodes.length)));
}

function buildThoughtSummary(
  runId: string,
  hiddenGraph: HLSFGraph,
  input: string,
): ThoughtSummary {
  const intersectionTokens = extractIntersectionTokens(hiddenGraph);
  return {
    id: runId,
    input,
    intersectionTokens,
    metrics: {
      tokenCount: hiddenGraph.nodes.length,
      edgeCount: hiddenGraph.edges.length,
      integrationScore: Number(computeCoherence(hiddenGraph).toFixed(2)),
    },
  };
}

function extractIntersectionTokens(graph: HLSFGraph, limit = 10): string[] {
  if (!graph.nodes.length) return [];
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const maxDegree = Math.max(1, ...degree.values(), 0);
  const maxWeight = Math.max(1, ...graph.nodes.map(node => node.weight ?? 0), 0);
  const scored = graph.nodes.map(node => {
    const nodeDegree = degree.get(node.id) ?? 0;
    const normalizedDegree = maxDegree ? nodeDegree / maxDegree : 0;
    const normalizedWeight = maxWeight ? (node.weight ?? 0) / maxWeight : 0;
    const score = normalizedDegree * 0.6 + normalizedWeight * 0.4;
    return {
      token: node.label || node.id,
      degree: nodeDegree,
      weight: node.weight ?? 0,
      score,
    };
  });

  const avgDegree = scored.reduce((sum, entry) => sum + entry.degree, 0) /
    Math.max(1, scored.length);
  const avgScore = scored.reduce((sum, entry) => sum + entry.score, 0) /
    Math.max(1, scored.length);
  const minDegree = Math.max(2, Math.round(avgDegree));
  const threshold = avgScore > 0 ? avgScore : 0.1;

  const prioritized = scored
    .filter(entry => entry.degree >= minDegree || entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.token)
    .filter(token => Boolean(token))
    .filter(token => !isStructuralToken(token));

  const unique = Array.from(new Set(prioritized));
  if (unique.length >= limit) {
    return unique.slice(0, limit);
  }

  for (const entry of scored.sort((a, b) => b.score - a.score)) {
    if (unique.length >= limit) break;
    if (entry.token && !unique.includes(entry.token)) {
      unique.push(entry.token);
    }
  }

  return unique.slice(0, limit);
}

async function runEmergentRotation(
  hiddenGraph: HLSFGraph,
  config: CognitionConfig,
  userPrompt: string,
): Promise<RotationResult> {
  pendingArticulation = null;
  articulationTriggered = false;
  const perIterationTokens: string[][] = [];
  const perIterationText: string[] = [];

  activeHiddenGraph = hiddenGraph;
  latestSpectralFeatures = new Map();
  axisNarrativeHistory.clear();

  const promptEmbedding = embedTextToVector(userPrompt, 24);
  onNewUserQuestion(userPrompt, promptEmbedding, Date.now());

  syncEngineGraphFromHiddenGraph(hiddenGraph, latestSpectralFeatures, 0);
  updateWindowGraphSpectra(hiddenGraph, latestSpectralFeatures);
  updateThoughtLogStatus('Starting emergent rotation…');

  for (let i = 0; i < config.iterations; i += 1) {
    activeIterationIndex = i;
    const { tokens, text, spectralFeatures } = await runSingleRotationIteration(
      hiddenGraph,
      config,
      i,
    );
    latestSpectralFeatures = spectralFeatures;
    syncEngineGraphFromHiddenGraph(hiddenGraph, spectralFeatures, i);
    updateWindowGraphSpectra(hiddenGraph, spectralFeatures);
    await engineTick(Date.now());
    perIterationTokens.push(tokens);
    perIterationText.push(text);

    if (pendingArticulation) {
      break;
    }
  }

  updateThoughtLogStatus('Rotation complete.');

  const emergentTrace = buildEmergentTrace(hiddenGraph, perIterationTokens);

  return { perIterationTokens, perIterationText, emergentTrace };
}

function buildEmergentTrace(
  graph: HLSFGraph,
  perIterationTokens: string[][],
): Record<string, string[]> {
  const axisTokens = new Map<string, string[]>();
  perIterationTokens.forEach((tokens, index) => {
    const axis = AXIS_SEQUENCE[index % AXIS_SEQUENCE.length];
    const ranked = rankTokensByGraph(graph, tokens, 6);
    const merged = Array.from(new Set([...(axisTokens.get(axis) ?? []), ...ranked]))
      .filter(token => !isStructuralToken(token))
      .slice(0, 6);
    axisTokens.set(axis, merged);
  });
  return Object.fromEntries(axisTokens);
}

function runSingleRotationIteration(
  hiddenGraph: HLSFGraph,
  config: CognitionConfig,
  iterationIndex: number,
): Promise<{ tokens: string[]; text: string; spectralFeatures: Map<string, SpectralFeatures> }> {
  const speed = Math.abs(config.rotationSpeed) < 1e-3 ? 0.3 : config.rotationSpeed;
  const degreesPerSecond = Math.abs(speed) * (180 / Math.PI);
  const degreesPerFrame = Math.max(0.5, degreesPerSecond / 60);
  const tokenFlushInterval = Math.min(90, Math.max(1, config.tokenBatchAngle ?? 12));
  const maxTokensPerThought = Math.max(8, config.maxTokensPerThought ?? 50);
  const spectralHistory = ensureSpectralHistory(hiddenGraph);
  const nodeLabelLookup = new Map(hiddenGraph.nodes.map(node => [node.id, node.label ?? node.id]));

  return new Promise(resolve => {
    const bufferTokens: string[] = [];
    const pendingTokenSet = new Set<string>();
    let lastFlushAngle = 0;

    const triggerThoughtDetection = () => {
      const spectralFeatures = computeGraphSpectralFeatures(hiddenGraph, spectralHistory);
      latestSpectralFeatures = spectralFeatures;
      syncEngineGraphFromHiddenGraph(hiddenGraph, spectralFeatures, iterationIndex);
      updateWindowGraphSpectra(hiddenGraph, spectralFeatures);
      void engineTick(Date.now());
      return spectralFeatures;
    };

    const flushPendingTokens = (currentAngle: number) => {
      if (!pendingTokenSet.size) return;
      streamTokensToThoughtLog(
        Array.from(pendingTokenSet),
        config.thinkingStyle,
        iterationIndex,
      );
      pendingTokenSet.clear();
      lastFlushAngle = currentAngle;
      triggerThoughtDetection();
    };

    const recordSpectralSample = (nodeId: string, affinity: number) => {
      if (!nodeId) return;
      const history = spectralHistory.get(nodeId) ?? [];
      const next = [...history.slice(-(FFT_WINDOW - 1)), Math.max(0, affinity)];
      spectralHistory.set(nodeId, next);
    };

    const collectTokens = (tokens: string[], affinity?: number, nodeIds?: string[]) => {
      if (!tokens.length || bufferTokens.length >= maxTokensPerThought) return;
      if (nodeIds?.length) {
        nodeIds.forEach(id => recordSpectralSample(id, affinity ?? 0));
      }
      for (const token of tokens) {
        if (!token) continue;
        const normalizedToken = token.trim();
        const isStructuralNode = nodeIds?.some(id => isStructuralToken(nodeLabelLookup.get(id) ?? ''));
        if (
          !normalizedToken ||
          isStructuralNode ||
          isStructuralToken(normalizedToken)
        ) {
          continue;
        }
        if (bufferTokens.length >= maxTokensPerThought) break;
        bufferTokens.push(token);
        pendingTokenSet.add(token);
      }
    };

    const schedule = hiddenGraph.intersections ?? buildIntersectionSchedule(hiddenGraph);
    const sortedEvents = schedule.slice().sort((a, b) => a.angle - b.angle);

    const processEvent = (event: IntersectionEvent) => {
      const flushNeeded =
        pendingTokenSet.size &&
        (event.angle - lastFlushAngle >= tokenFlushInterval ||
          bufferTokens.length >= maxTokensPerThought);
      if (flushNeeded) {
        flushPendingTokens(event.angle);
      }
      collectTokens(event.tokens, event.affinity, [event.a, event.b]);
    };

    const fastTrackRotation = () => {
      for (const event of sortedEvents) {
        if (event.affinity >= config.affinityThreshold) {
          processEvent(event);
        } else if (
          pendingTokenSet.size &&
          event.angle - lastFlushAngle >= tokenFlushInterval
        ) {
          flushPendingTokens(event.angle);
        }
      }

      flushPendingTokens(360);
      stopRotationAnimation(hiddenGraph, iterationIndex);
      const text = buildIterationNarrative(hiddenGraph, bufferTokens, iterationIndex);
      commitThoughtLineToUI(text, iterationIndex);
      const spectralFeatures = triggerThoughtDetection();
      resolve({ tokens: bufferTokens.slice(), text, spectralFeatures });
    };

    const step = () => {
      // Preserve animation pacing when a browser is present, but fall back to
      // the faster deterministic path when requestAnimationFrame is missing.
      if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        fastTrackRotation();
        return;
      }

      let angle = 0;
      const iterate = () => {
        if (pendingArticulation) {
          flushPendingTokens(angle);
          stopRotationAnimation(hiddenGraph, iterationIndex);
          const text = buildIterationNarrative(hiddenGraph, bufferTokens, iterationIndex);
          commitThoughtLineToUI(text, iterationIndex);
          const spectralFeatures = triggerThoughtDetection();
          resolve({ tokens: bufferTokens.slice(), text, spectralFeatures });
          return;
        }

        angle += degreesPerFrame;

        if (angle >= 360) {
          flushPendingTokens(360);
          stopRotationAnimation(hiddenGraph, iterationIndex);
          const text = buildIterationNarrative(hiddenGraph, bufferTokens, iterationIndex);
          commitThoughtLineToUI(text, iterationIndex);
          const spectralFeatures = triggerThoughtDetection();
          resolve({ tokens: bufferTokens.slice(), text, spectralFeatures });
          return;
        }

        const intersections = getIntersectionsAtAngle(hiddenGraph, angle);
        for (const inter of intersections) {
          if (inter.affinity >= config.affinityThreshold) {
            processEvent(inter);
          }
        }

        if (
          pendingTokenSet.size &&
          (angle - lastFlushAngle >= tokenFlushInterval || bufferTokens.length >= maxTokensPerThought)
        ) {
          flushPendingTokens(angle);
        }

        scheduleAnimationFrame(iterate);
      };

      scheduleAnimationFrame(iterate);
    };

    setActiveThoughtIteration(iterationIndex);
    startRotationAnimation(hiddenGraph, iterationIndex);
    step();
  });
}

function ensureSpectralHistory(graph: HLSFGraph): Map<string, number[]> {
  const metadata = (graph.metadata = graph.metadata || {});
  const store = (metadata as any).spectralHistory as Map<string, number[]> | undefined;
  if (store instanceof Map) {
    return store;
  }
  const created = new Map<string, number[]>();
  (metadata as any).spectralHistory = created;
  return created;
}

function computeGraphSpectralFeatures(
  graph: HLSFGraph,
  history: Map<string, number[]>,
): Map<string, SpectralFeatures> {
  const spectral = new Map<string, SpectralFeatures>();
  for (const node of graph.nodes) {
    const series = history.get(node.id) ?? [];
    spectral.set(node.id, computeSpectralFeaturesFromSeries(series));
  }
  graph.metadata = Object.assign({}, graph.metadata, {
    spectralFeatures: Object.fromEntries(spectral),
  });
  return spectral;
}

function updateWindowGraphSpectra(
  graph: HLSFGraph,
  spectral: Map<string, SpectralFeatures>,
): void {
  graph.metadata = Object.assign({}, graph.metadata, {
    spectralFeatures: Object.fromEntries(spectral),
  });
  if (typeof window === 'undefined') return;
  const root = (window as any).HLSF || ((window as any).HLSF = {});
  const current = root.currentGraph && root.currentGraph === graph
    ? root.currentGraph
    : graph;
  current.spectralFeatures = Object.fromEntries(spectral);
  root.currentGraph = current;
}

function syncEngineGraphFromHiddenGraph(
  graph: HLSFGraph,
  spectral: Map<string, SpectralFeatures>,
  iterationIndex: number,
): void {
  const embeddings = getEmbeddingStore(graph);
  const engineNodes: EngineNode[] = graph.nodes.map(node => {
    const embedding = embeddings.get(node.id) ?? embedTextToVector(node.label, 24);
    embeddings.set(node.id, embedding);
    return {
      id: node.id,
      label: node.label,
      embedding,
      position: deriveNodePosition(node.id, iterationIndex),
      velocity: [0, 0],
    };
  });

  const engineEdges: EngineEdge[] = graph.edges.map(edge => ({
    src: edge.source,
    dst: edge.target,
    weight: clamp01(edge.weight),
    role: deriveEdgeRole(edge),
    lastUpdated: Date.now(),
  }));

  updateEngineGraph(engineNodes, engineEdges, spectral);
}

function deriveEdgeRole(edge: HlsfEdge): EdgeRole {
  const idx = hash(edge.id || `${edge.source}-${edge.target}`) % EDGE_ROLES.length;
  return EDGE_ROLES[Math.abs(idx)] ?? 'meta';
}

function deriveNodePosition(nodeId: string, iterationIndex: number): [number, number] {
  const baseAngle = (hash(nodeId) % 360) * (Math.PI / 180);
  const angle = baseAngle + iterationIndex * 0.35;
  const radius = 0.6 + (hash(`${nodeId}-r`) % 40) / 100;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

function embedTextToVector(text: string, dims = 16): number[] {
  const vec = new Array(dims).fill(0);
  const normalized = text || '';
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    vec[i % dims] += Math.sin(code) + Math.cos(code / 2);
  }
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / magnitude);
}

function getEmbeddingStore(graph: HLSFGraph): Map<string, number[]> {
  const metadata = (graph.metadata = graph.metadata || {});
  const store = (metadata as any).embeddings as Map<string, number[]> | undefined;
  if (store instanceof Map) return store;
  const created = new Map<string, number[]>();
  (metadata as any).embeddings = created;
  return created;
}

function applyAdjacencyDeltaToHiddenGraph(delta: AdjacencyDelta): void {
  if (!activeHiddenGraph) return;
  const graph = activeHiddenGraph;
  const embeddings = getEmbeddingStore(graph);
  if (delta?.nodes) {
    delta.nodes.forEach((node, index) => {
      if (graph.nodes.find(n => n.id === node.id)) return;
      graph.nodes.push({
        id: node.id,
        label: node.label || `Δ${index}`,
        weight: 1,
        layer: (graph.nodes.length + index) % 4,
        cluster: graph.nodes.length % 5,
      });
      embeddings.set(node.id, node.hintEmbedding ?? embedTextToVector(node.label ?? node.id, 24));
      if (!latestSpectralFeatures.has(node.id)) {
        latestSpectralFeatures.set(node.id, computeSpectralFeaturesFromSeries([]));
      }
    });
  }

  if (delta?.edges) {
    delta.edges.forEach((edge, idx) => {
      const id = `${edge.src}-${edge.dst}-${Date.now()}-${idx}`;
      graph.edges.push({
        id,
        source: edge.src,
        target: edge.dst,
        weight: edge.weight ?? 0.4,
      });
    });
  }

  graph.intersections = buildIntersectionSchedule(graph);
  syncEngineGraphFromHiddenGraph(graph, latestSpectralFeatures, activeIterationIndex);
  updateWindowGraphSpectra(graph, latestSpectralFeatures);
}

function handleThoughtEventTokens(thought: ThoughtEvent): void {
  const tokens = thought?.cluster?.nodeIds
    ?.map(id => activeHiddenGraph?.nodes.find(node => node.id === id)?.label || id)
    .filter(Boolean)
    .slice(0, activeRotationConfig?.maxTokensPerThought ?? 12);
  if (!tokens?.length) return;
  streamTokensToThoughtLog(tokens, activeRotationConfig?.thinkingStyle ?? 'analytic', activeIterationIndex);
}

function handleArticulationResponse(event: ArticulationEvent): void {
  pendingArticulation = event;
  articulationTriggered = true;
  updateThoughtLogStatus('High-relevance thoughts captured. Preparing articulation…');
}

function scheduleAnimationFrame(cb: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(cb);
    return;
  }
  setTimeout(cb, 16);
}

function emitRotationPreview(
  active: boolean,
  graph: HLSFGraph | null,
  iterationIndex: number,
): void {
  if (typeof document === 'undefined') return;
  const event = new CustomEvent<RotationPreviewEventDetail>(HLSF_ROTATION_EVENT, {
    detail: { active, graph, iteration: iterationIndex },
  });
  document.dispatchEvent(event);
}

function startRotationAnimation(hiddenGraph: HLSFGraph, iterationIndex: number): void {
  if (typeof window === 'undefined') return;
  const root = (window as any).HLSF || ((window as any).HLSF = {});
  root.currentGraph = hiddenGraph;
  root.state = root.state || {};
  root.state.emergent = Object.assign({}, root.state.emergent, {
    on: true,
    speed: activeRotationConfig?.rotationSpeed ?? 0.3,
  });
  updateThoughtLogStatus(`Rotation ${iterationIndex + 1}/${activeRotationConfig?.iterations ?? 1}`);
  emitRotationPreview(true, hiddenGraph, iterationIndex);
}

function stopRotationAnimation(hiddenGraph: HLSFGraph, iterationIndex: number): void {
  if (typeof window === 'undefined') return;
  const root = (window as any).HLSF;
  if (!root?.state?.emergent) return;
  root.state.emergent.on = false;
  updateThoughtLogStatus(
    `Rotation ${iterationIndex + 1}/${activeRotationConfig?.iterations ?? 1} committed`,
  );
  emitRotationPreview(false, hiddenGraph, iterationIndex);
}

function getIntersectionsAtAngle(hiddenGraph: HLSFGraph, angle: number): IntersectionEvent[] {
  const schedule = hiddenGraph.intersections ?? buildIntersectionSchedule(hiddenGraph);
  if (!schedule.length) return [];
  const normalized = ((angle % 360) + 360) % 360;
  const windowSize = 5;
  return schedule.filter(event => {
    const delta = Math.abs(event.angle - normalized);
    return delta <= windowSize || 360 - delta <= windowSize;
  });
}

function buildIntersectionSchedule(graph: HLSFGraph): IntersectionEvent[] {
  if (graph.intersections?.length) {
    return graph.intersections;
  }
  const events: IntersectionEvent[] = [];
  const tokensByNode = new Map(graph.nodes.map(node => [node.id, node.label]));
  graph.edges.forEach((edge, index) => {
    const angle = (hash(edge.id) % 360 + index * 3) % 360;
    const affinity = clamp01(edge.weight);
    const aToken = tokensByNode.get(edge.source) ?? edge.source;
    const bToken = tokensByNode.get(edge.target) ?? edge.target;
    events.push({
      a: edge.source,
      b: edge.target,
      angle,
      affinity,
      tokens: [aToken, bToken],
    });
  });
  events.sort((a, b) => a.angle - b.angle);
  graph.intersections = events;
  return events;
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function streamTokensToThoughtLog(
  tokens: string[],
  style: ThinkingStyle,
  iterationIndex: number,
): void {
  if (!tokens.length || typeof document === 'undefined') return;
  const entry = ensureThoughtLogIterationEntry(iterationIndex);
  if (!entry) return;
  const line = tokens.join(' ');
  const queued = tokenStreamQueues.get(iterationIndex) ?? Promise.resolve();
  const task = queued
    .catch(() => undefined)
    .then(
      () =>
        new Promise<void>(resolve => {
          scheduleAnimationFrame(() => {
            const block = document.createElement('div');
            block.className = `thought-token-line thought-token-line--${style}`;
            block.textContent = line;
            entry.tokensEl.appendChild(block);
            resolve();
          });
        }),
    );
  tokenStreamQueues.set(iterationIndex, task);
}

export function commitThoughtLineToUI(text: string, iterationIndex = activeIterationIndex): void {
  const entry = ensureThoughtLogIterationEntry(iterationIndex);
  if (entry) {
    entry.textEl.textContent = text || '…';
    return;
  }
  dispatchThoughtCommitEvent(iterationIndex, text);
}

function prepareThoughtLogUI(iterations: number): void {
  if (typeof document === 'undefined') {
    iterationDom.clear();
    tokenStreamQueues.clear();
    return;
  }
  const root = getThoughtIterationRoot();
  if (!root) {
    iterationDom.clear();
    tokenStreamQueues.clear();
    return;
  }
  ensureThoughtLogPanelVisible(root);
  root.innerHTML = '';
  iterationDom.clear();
  tokenStreamQueues.clear();
  const count = Math.max(1, iterations);
  for (let i = 0; i < count; i += 1) {
    createThoughtIterationDom(root, i);
  }
}

function setActiveThoughtIteration(index: number): void {
  activeIterationIndex = index;
  if (typeof document === 'undefined') return;
  ensureThoughtLogIterationEntry(index);
  for (const [idx, entry] of iterationDom.entries()) {
    if (!entry?.root) continue;
    entry.root.classList.toggle('is-active', idx === index);
  }
}

function updateThoughtLogStatus(message: string): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('thought-log-status');
  if (!el) return;
  el.textContent = message;
}

const AXIS_SEQUENCE = ['horizontal', 'longitudinal', 'sagittal'];
const AXIS_DESCRIPTORS = ['shear', 'torsion', 'resonance'];
const axisNarrativeHistory = new Map<string, { signature: string; startIteration: number; summary: string }>();

function normalizeTokenLabel(token: string): string {
  return token?.trim().toLowerCase() ?? '';
}

function isStructuralToken(token: string): boolean {
  const normalized = normalizeTokenLabel(token);
  if (!normalized) return true;
  if (normalized.startsWith('latent')) return true;
  const structuralPatterns = [
    'axis',
    'axes',
    'rotation',
    'rotations',
    'rotate',
    'shear',
    'torsion',
    'resonance',
    'keep in order',
  ];
  return structuralPatterns.some(pattern => normalized.includes(pattern));
}

function filterMeaningfulTokens(tokens: string[]): string[] {
  return tokens
    .map(token => token?.trim())
    .filter((token): token is string => Boolean(token))
    .filter(token => !isStructuralToken(token));
}

function rankTokensByGraph(graph: HLSFGraph, tokens: string[], limit: number): string[] {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const maxDegree = Math.max(1, ...degree.values(), 0);
  const maxWeight = Math.max(1, ...graph.nodes.map(node => node.weight ?? 0), 0);
  const nodeByLabel = new Map<string, HlsfNode>(
    graph.nodes.map(node => [normalizeTokenLabel(node.label || node.id), node]),
  );

  const uniqueTokens = Array.from(new Set(filterMeaningfulTokens(tokens)));

  const scored = uniqueTokens.map(token => {
    const normalized = normalizeTokenLabel(token);
    const node = nodeByLabel.get(normalized);
    const degreeScore = node ? (degree.get(node.id) ?? 0) / maxDegree : 0;
    const weightScore = node ? (node.weight ?? 0) / maxWeight : 0;
    const score = degreeScore * 0.6 + weightScore * 0.4;
    return { token, score, degree: degree.get(node?.id ?? '') ?? 0, weight: node?.weight ?? 0 };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map(entry => entry.token);
}

function formatTokenList(tokens: string[]): string {
  if (!tokens.length) return '';
  if (tokens.length === 1) return tokens[0];
  if (tokens.length === 2) return `${tokens[0]} and ${tokens[1]}`;
  return `${tokens.slice(0, -1).join(', ')}, and ${tokens[tokens.length - 1]}`;
}

function buildIterationNarrative(
  graph: HLSFGraph,
  collectedTokens: string[],
  iterationIndex: number,
): string {
  const axisName = AXIS_SEQUENCE[iterationIndex % AXIS_SEQUENCE.length];
  const descriptor = AXIS_DESCRIPTORS[iterationIndex % AXIS_DESCRIPTORS.length];
  const baselineTokens = collectedTokens.length
    ? filterMeaningfulTokens(collectedTokens)
    : extractIntersectionTokens(graph, 8);
  const supplemental = selectAxisTokensForIteration(
    graph,
    iterationIndex,
    Math.max(10, baselineTokens.length * 2),
  );
  const rankedTokens = rankTokensByGraph(
    graph,
    [...baselineTokens, ...supplemental],
    Math.max(6, baselineTokens.length || 6),
  );
  const salient = rankedTokens.slice(0, Math.max(3, Math.min(6, rankedTokens.length)));
  const signature = salient
    .map(token => normalizeTokenLabel(token))
    .sort()
    .join('|');
  const previous = axisNarrativeHistory.get(axisName);

  const baseSummary = salient.length
    ? `${capitalize(axisName)} axis ${descriptor}: intersections emphasize ${formatTokenList(salient)}; keep the response grounded in that thread.`
    : `${capitalize(axisName)} axis ${descriptor}: no salient intersections detected for this pass.`;

  if (previous && previous.signature === signature) {
    const start = previous.startIteration + 1;
    const range = start === iterationIndex + 1 ? `${start}` : `${start}–${iterationIndex + 1}`;
    const merged = `${capitalize(axisName)} axis ${descriptor}: Rotations ${range} produced identical intersections; ${
      salient.length ? `continuing emphasis on ${formatTokenList(salient)}.` : 'no new signals detected.'
    }`;
    axisNarrativeHistory.set(axisName, { signature, startIteration: previous.startIteration, summary: merged });
    return merged;
  }

  axisNarrativeHistory.set(axisName, { signature, startIteration: iterationIndex, summary: baseSummary });
  return baseSummary;
}

function selectAxisTokensForIteration(
  graph: HLSFGraph,
  iterationIndex: number,
  limit: number,
): string[] {
  const prioritized = extractIntersectionTokens(graph, Math.max(limit * 2, 12));
  if (!prioritized.length) return [];
  const stride = Math.max(1, Math.floor(prioritized.length / AXIS_SEQUENCE.length));
  const start = (iterationIndex * stride) % prioritized.length;
  const tokens: string[] = [];
  for (let i = 0; i < Math.min(limit, prioritized.length); i += 1) {
    const token = prioritized[(start + i) % prioritized.length];
    if (token) tokens.push(token);
  }
  return tokens;
}

function capitalize(text: string): string {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function dispatchThoughtCommitEvent(iterationIndex: number, text: string): void {
  if (typeof CustomEvent === 'undefined') return;
  if (typeof document !== 'undefined') {
    const event = new CustomEvent<ThoughtCommitEventDetail>(HLSF_THOUGHT_COMMIT_EVENT, {
      detail: { iteration: iterationIndex, text },
    });
    document.dispatchEvent(event);
    return;
  }
  const target = (globalThis as unknown as EventTarget | undefined) ?? undefined;
  if (!target || typeof (target as any).dispatchEvent !== 'function') return;
  const event = new CustomEvent<ThoughtCommitEventDetail>(HLSF_THOUGHT_COMMIT_EVENT, {
    detail: { iteration: iterationIndex, text },
  });
  (target as EventTarget).dispatchEvent(event);
}

const runtimeEnv = (import.meta as any)?.env ?? {};
const llmStubMode = String(runtimeEnv.VITE_ENABLE_LLM_STUB ?? 'off').toLowerCase();

function isStaticFileProtocol(): boolean {
  return typeof window !== 'undefined' && window.location?.protocol === 'file:';
}

function tidyFallbackText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const capitalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function tidyInterpretationText(text: string | undefined | null): string {
  const trimmed = (text ?? '').toString().trim();
  if (!trimmed) return '';
  const lastPeriod = trimmed.lastIndexOf('.');
  if (lastPeriod > 0) {
    return tidyFallbackText(trimmed.slice(0, lastPeriod + 1));
  }
  return tidyFallbackText(trimmed);
}

function computeFallbackArticulation(thought: ThoughtNode): {
  text: string;
  reason: string;
} {
  const rawText = tidyFallbackText(thought.rawText ?? '');
  const interpretation = tidyInterpretationText(thought.interpretationText);
  const interpretationWordCount = interpretation ? interpretation.split(/\s+/).length : 0;
  const rotationNarrative = collapseRotationNarrative(
    thought.rotationSummary ? [thought.rotationSummary] : [],
    100,
  );
  const rotationSummary = rotationNarrative ? tidyFallbackText(rotationNarrative) : '';

  if (interpretation && interpretationWordCount >= 8) {
    return { text: interpretation, reason: 'interpretation-text' };
  }

  if (rotationSummary) {
    return { text: rotationSummary, reason: 'rotation-narrative' };
  }

  if (rawText) {
    return { text: rawText, reason: 'raw-text' };
  }

  if (interpretation) {
    return { text: interpretation, reason: 'interpretation-text' };
  }

  const adjacencyTokens = Array.isArray(thought.adjacencyTokens)
    ? thought.adjacencyTokens.filter(Boolean)
    : [];
  if (adjacencyTokens.length) {
    const uniqueTokens = Array.from(new Set(adjacencyTokens)).slice(0, 24);
    const sentence = uniqueTokens.join(', ');
    const s = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    const finalized = s.endsWith('.') ? s : `${s}.`;
    return {
      text: `Key prompt tokens (LLM offline): ${finalized}`,
      reason: 'adjacency-tokens',
    };
  }

  return {
    text: 'HLSF cognition completed, but no articulated text is available.',
    reason: 'empty-fallback',
  };
}

function formatLlmError(llm: LLMResult): string {
  const parts = [llm.error || 'LLM request failed'];
  if (llm.status) parts.push(`HTTP ${llm.status}`);
  if (llm.endpoint) parts.push(`Endpoint: ${llm.endpoint}`);
  return parts.filter(Boolean).join(' · ');
}

export function isConnectionRefused(error: unknown): boolean {
  const codes = new Set<string>([
    (error as any)?.code,
    (error as any)?.cause?.code,
    ...(Array.isArray((error as any)?.errors)
      ? (error as any).errors.flatMap((err: any) => [err?.code, err?.cause?.code])
      : []),
  ].filter(Boolean));

  const combinedMessage = [
    (error as Error)?.message,
    (error as any)?.cause?.message,
    Array.isArray((error as any)?.errors)
      ? (error as any).errors.map((err: any) => err?.message || String(err ?? '')).join(' ')
      : (error as any)?.errors,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    codes.has('ECONNREFUSED') ||
    /ECONNREFUSED/i.test(combinedMessage) ||
    ((error as Error)?.name === 'AggregateError' && /ECONNREFUSED/i.test(combinedMessage))
  );
}

export async function callLLM(
  prompt: string,
  thoughts: string[],
  config: CognitionConfig,
  mode: CognitionMode,
  history: CognitionHistoryEntry[],
  options: { interpretationText?: string; rawPrompt?: string; adjacencyTokens?: string[]; offline?: boolean } = {},
): Promise<LLMResult> {
  const systemInstruction = [
    'You are synthesizing an answer from a localized semantic field graph.',
    'Use the provided HUB, NEIGHBORS, and ROTATION NOTES as context.',
    'Do NOT output hidden reasoning.',
    'Output two labeled sections: (A) Emergent Trace: 4–8 bullet points summarizing which context you used (no private deliberation).',
    '(B) Structured Response: a coherent answer in 30–300 words.',
  ].join(' ');

  const rotationSummary = collapseRotationNarrative(thoughts, 120);
  const { interpretationText, rawPrompt, adjacencyTokens = [] } = options;
  const contextBlock = [
    '===CONVERGED TRACE CONTEXT===',
    `Hub: ${rawPrompt ?? prompt}`,
    `Top neighbors: ${adjacencyTokens.slice(0, 12).join(', ') || 'n/a'}`,
    `Active contexts: ${thoughts.slice(0, 6).join(' | ') || 'n/a'}`,
    `Rotation notes: ${rotationSummary || 'n/a'}`,
    `Depth/branches/nodes summary: iterations=${config.iterations}; history=${history.length}; tokens=${adjacencyTokens.length}`,
    '===END CONTEXT===',
  ].join('\n');

  const userContent = [prompt, contextBlock].join('\n\n');

  const messages = [
    { role: 'system', content: systemInstruction },
    { role: 'system', content: thinkingStyleToSystemMessage(config.thinkingStyle) },
    { role: 'user', content: userContent },
  ];

  const fallbackThought: ThoughtNode = {
    interpretationText,
    rawText: rawPrompt ?? prompt,
    adjacencyTokens,
    rotationSummary,
  };
  const fallback = computeFallbackArticulation(fallbackThought);
  const stubEnabled = llmStubMode === 'on' || options.offline === true;

  if (isStaticFileProtocol() && resolveLlmEndpoint().startsWith('/')) {
    const message =
      'LLM endpoint must be absolute for file:// loads. Update VITE_LLM_ENDPOINT to a reachable backend.';
    return {
      model: 'local-llm',
      temperature: 0.7,
      response: fallback.text,
      error: message,
      isFallback: true,
      endpoint: resolveLlmEndpoint(),
      status: 0,
      fallbackText: fallback.text,
      fallbackReason: fallback.reason,
    };
  }

  if (stubEnabled) {
    return {
      model: 'offline-llm-stub',
      temperature: 0.7,
      response: fallback.text,
      isFallback: true,
      endpoint: resolveLlmEndpoint(),
      status: 200,
      fallbackText: fallback.text,
      fallbackReason: fallback.reason,
    };
  }

  try {
    const llmResponse = await dispatchLlmRequest({
      prompt,
      messages,
      interpretationText: interpretationText || fallback.text,
      rawText: rawPrompt ?? prompt,
      contextBlock,
    });

    const emergentTrace = Array.isArray(llmResponse.emergent_trace)
      ? llmResponse.emergent_trace
      : llmResponse.emergent_trace
        ? [String(llmResponse.emergent_trace)]
        : [];
    const structuredResponse = llmResponse.structured_response ?? fallback.text;

    return {
      model: 'remote-llm',
      temperature: 0.2,
      response: structuredResponse,
      endpoint: llmResponse.endpoint,
      status: llmResponse.status,
      usage: llmResponse.provider?.usage as any,
      emergentTrace,
      lengthStatus: llmResponse.lengthStatus,
    };
  } catch (error: any) {
    const endpoint = error?.endpoint || resolveLlmEndpoint();
    const status = (error as any)?.status;
    const snippet = (error as any)?.bodySnippet as string | undefined;
    const message = status ? `LLM backend failed (HTTP ${status})` : 'LLM backend failed';
    return {
      model: 'remote-llm',
      temperature: 0.2,
      response: '',
      error: snippet ? `${message}: ${snippet}` : message,
      isFallback: false,
      endpoint,
      status,
      rawError: snippet,
      fallbackReason: 'llm-error',
    };
  }
}

export function thinkingStyleToSystemMessage(style: ThinkingStyle): string {
  switch (style) {
    case 'concise':
      return 'You respond briefly and clearly, focusing on essentials.';
    case 'analytic':
      return 'You respond with structured, logical analysis.';
    case 'dreamlike':
      return 'You respond with associative, metaphorical, but still coherent language.';
    case 'dense':
      return 'You respond with detailed, information-dense language.';
    default:
      return 'You respond clearly and helpfully.';
  }
}

async function persistRun(run: CognitionRun): Promise<void> {
  if (typeof window !== 'undefined' && window?.localStorage) {
    try {
      const key = 'hlsf_runs';
      const existing = window.localStorage.getItem(key);
      const runs: CognitionRun[] = existing ? JSON.parse(existing) : [];
      runs.push(run);
      window.localStorage.setItem(key, JSON.stringify(runs));
    } catch (error) {
      console.warn('Failed to persist cognition run to localStorage:', error);
    }
    return;
  }

  try {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises');
    await fs.appendFile('hlsf_runs.ndjson', `${JSON.stringify(run)}\n`, 'utf8');
  } catch (error) {
    console.warn('Failed to persist cognition run to file:', error);
  }
}

async function persistCycleResult(result: CognitionCycleResult): Promise<void> {
  if (typeof window !== 'undefined' && window?.localStorage) {
    try {
      const key = 'hlsf_cycle_runs';
      const existing = window.localStorage.getItem(key);
      const cycles: CognitionCycleResult[] = existing ? JSON.parse(existing) : [];
      cycles.push(result);
      window.localStorage.setItem(key, JSON.stringify(cycles));
    } catch (error) {
      console.warn('Failed to persist cognition cycle to localStorage:', error);
    }
    return;
  }

  try {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises');
    await fs.appendFile('hlsf_cycle_runs.ndjson', `${JSON.stringify(result)}\n`, 'utf8');
  } catch (error) {
    console.warn('Failed to persist cognition cycle to file:', error);
  }
}
