import { tokenizeWords } from '../tokens/tokenize.js';
import { computeCosineSimilarity } from '../vector/similarity.js';

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
}

interface RotationResult {
  perIterationTokens: string[][];
  perIterationText: string[];
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

function getThoughtIterationRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('thought-iteration-log');
}

function ensureThoughtLogPanelVisible(root: HTMLElement): void {
  if (!root) return;
  root.setAttribute('aria-hidden', 'false');
  const panel = root.closest('.thought-log-panel');
  if (panel instanceof HTMLElement && !panel.classList.contains('is-debug-visible')) {
    panel.classList.add('is-debug-visible');
  }
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
  const { perIterationTokens, perIterationText } = await runEmergentRotation(
    hiddenGraph,
    config,
  );
  const interpretationText = perIterationText[perIterationText.length - 1];
  const adjacencyTokens = perIterationTokens.flat().filter(token => Boolean(token));

  const llmResult = await callLLM(
    truncatedPrompt,
    perIterationText,
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
    thoughts: { perIterationTokens, perIterationText, interpretationText, adjacencyTokens },
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

      if (run.mode === 'visible') {
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

function detectCognitionMode(prompt: string): CognitionMode {
  const normalized = prompt?.trim().toLowerCase() ?? '';
  return normalized.startsWith('/hidden') ? 'hidden' : 'visible';
}

function normalizePromptForMode(prompt: string, mode: CognitionMode): string {
  if (mode !== 'hidden') {
    return prompt;
  }
  return prompt.replace(/^\s*\/hidden\s*/i, '').trim();
}

export function composeHiddenPrompt(history: CognitionHistoryEntry[]): string {
  const lastVisible = [...history]
    .reverse()
    .find(entry => entry.mode === 'visible');
  const fallback = history.length ? history[history.length - 1]?.response?.trim() : '';
  const reference = lastVisible?.response?.trim() || fallback;
  const promptLines = [
    '/hidden Reflect on the previous visible answer using HLSF rotations.',
    'Rotate sequentially through the horizontal, longitudinal, and sagittal axes.',
    'Describe the intersections discovered at each axis crossing and summarize the emergent insights.',
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
    .filter(token => Boolean(token));

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
): Promise<RotationResult> {
  const perIterationTokens: string[][] = [];
  const perIterationText: string[] = [];

  updateThoughtLogStatus('Starting emergent rotation…');

  for (let i = 0; i < config.iterations; i += 1) {
    activeIterationIndex = i;
    const { tokens, text } = await runSingleRotationIteration(hiddenGraph, config, i);
    perIterationTokens.push(tokens);
    perIterationText.push(text);
  }

  updateThoughtLogStatus('Rotation complete.');

  return { perIterationTokens, perIterationText };
}

function runSingleRotationIteration(
  hiddenGraph: HLSFGraph,
  config: CognitionConfig,
  iterationIndex: number,
): Promise<{ tokens: string[]; text: string }> {
  const speed = Math.abs(config.rotationSpeed) < 1e-3 ? 0.3 : config.rotationSpeed;
  const degreesPerSecond = Math.abs(speed) * (180 / Math.PI);
  const degreesPerFrame = Math.max(0.5, degreesPerSecond / 60);
  const tokenFlushInterval = Math.min(90, Math.max(1, config.tokenBatchAngle ?? 12));
  const maxTokensPerThought = Math.max(8, config.maxTokensPerThought ?? 50);

  return new Promise(resolve => {
    let angle = 0;
    const bufferTokens: string[] = [];
    const pendingTokenSet = new Set<string>();
    let lastFlushAngle = 0;

    const flushPendingTokens = () => {
      if (!pendingTokenSet.size) return;
      streamTokensToThoughtLog(
        Array.from(pendingTokenSet),
        config.thinkingStyle,
        iterationIndex,
      );
      pendingTokenSet.clear();
    };

    const collectTokens = (tokens: string[]) => {
      if (!tokens.length || bufferTokens.length >= maxTokensPerThought) return;
      for (const token of tokens) {
        if (!token) continue;
        if (bufferTokens.length >= maxTokensPerThought) break;
        bufferTokens.push(token);
        pendingTokenSet.add(token);
      }
    };

    const step = () => {
      angle += degreesPerFrame;

      if (angle >= 360) {
        flushPendingTokens();
        stopRotationAnimation(hiddenGraph, iterationIndex);
        const text = buildIterationNarrative(
          hiddenGraph,
          bufferTokens,
          iterationIndex,
          config.thinkingStyle,
        );
        commitThoughtLineToUI(text, iterationIndex);
        resolve({ tokens: bufferTokens.slice(), text });
        return;
      }

      const intersections = getIntersectionsAtAngle(hiddenGraph, angle);
      for (const inter of intersections) {
        if (inter.affinity >= config.affinityThreshold) {
          collectTokens(inter.tokens);
        }
      }

      if (
        pendingTokenSet.size &&
        (angle - lastFlushAngle >= tokenFlushInterval || bufferTokens.length >= maxTokensPerThought)
      ) {
        flushPendingTokens();
        lastFlushAngle = angle;
      }

      scheduleAnimationFrame(step);
    };

    setActiveThoughtIteration(iterationIndex);
    startRotationAnimation(hiddenGraph, iterationIndex);
    scheduleAnimationFrame(step);
  });
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

function materializeThought(tokens: string[], style: ThinkingStyle): string {
  if (!tokens.length) return '';
  const phrases: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const current = tokens[i]?.trim();
    const next = tokens[i + 1]?.trim();
    if (current && next) {
      phrases.push(`${current} → ${next}`);
    } else if (current) {
      phrases.push(current);
    }
  }
  const unique = Array.from(new Set((phrases.length ? phrases : tokens).filter(Boolean)));
  if (!unique.length) return '';
  switch (style) {
    case 'concise':
      return unique.join('; ');
    case 'analytic':
      return unique
        .map((token, index) => `${index + 1}. ${token}`)
        .join(' ');
    case 'dreamlike':
      return unique.join(' ~ ');
    case 'dense':
      return unique.join(' · ');
    default:
      return unique.join(' ');
  }
}

const AXIS_SEQUENCE = ['horizontal', 'longitudinal', 'sagittal'];
const AXIS_DESCRIPTORS = ['shear', 'torsion', 'resonance'];

function buildIterationNarrative(
  graph: HLSFGraph,
  collectedTokens: string[],
  iterationIndex: number,
  style: ThinkingStyle,
): string {
  const baselineTokens = collectedTokens.length
    ? collectedTokens.slice()
    : extractIntersectionTokens(graph, 6);
  const axisTokens = selectAxisTokensForIteration(
    graph,
    iterationIndex,
    Math.max(6, baselineTokens.length),
  );
  const combined = Array.from(new Set([...baselineTokens, ...axisTokens]))
    .filter(token => {
      if (!token) return false;
      const normalized = token.trim();
      return (
        normalized.length > 0 &&
        !/^latent[-\s]?/i.test(normalized) &&
        !/^latent\s+field/i.test(normalized)
      );
    });
  const axisName = AXIS_SEQUENCE[iterationIndex % AXIS_SEQUENCE.length];
  const descriptor = AXIS_DESCRIPTORS[iterationIndex % AXIS_DESCRIPTORS.length];
  const narrative = materializeThought(combined, style);
  if (!narrative) {
    return `${capitalize(axisName)} axis ${descriptor} completed.`;
  }
  return `${capitalize(axisName)} axis ${descriptor}: ${narrative}`;
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

function formatHistoryContext(history: CognitionHistoryEntry[]): string {
  if (!history.length) return '';
  const recent = history.slice(-6);
  return recent
    .map(entry => {
      const label = entry.mode === 'hidden' ? 'Hidden' : 'Visible';
      const parts = [
        `${label} #${entry.iteration + 1} prompt: ${entry.prompt}`,
        entry.hiddenPrompt ? `Hidden prompt issued: ${entry.hiddenPrompt}` : null,
        `Response: ${entry.response || '(empty)'}`,
      ].filter((part): part is string => Boolean(part));
      return parts.join('\n');
    })
    .join('\n---\n');
}

function buildEmergentThoughtDirective(): string {
  return [
    'Adopt the HLSF Emergent Thought Process for every response.',
    '1. Prompt decomposition – extract the key nouns, verbs, and relations. List any ambiguous terms that need assumptions.',
    '2. Conceptual clustering – group related concepts, name each cluster, and note why the grouping matters.',
    '3. High-Level Semantic Field (HLSF) mapping – describe the nodes (clusters) and explicit links between them to form the reasoning skeleton.',
    '4. Interconnection reflection – explain how shifts in one cluster influence others and highlight cascading effects.',
    '5. Iterative refinement – revisit the HLSF to add/remove nodes or links for clarity; capture adjustments explicitly.',
    '6. Emergent thought trace – document concise reflections for each step without exposing raw chain-of-thought.',
    '7. Structured response – answer using the HLSF order, state assumptions, integrate critique/context, and close with actionable next steps.',
    'Label the output sections (e.g., "Emergent Thought Trace", "Structured Response") so the user can follow the process.',
  ].join('\n');
}

const runtimeEnv = (import.meta as any)?.env ?? {};
const DEFAULT_LLM_ENDPOINT = '/api/llm';

function resolveLlmEndpoint(): string {
  const fromEnv = typeof runtimeEnv.VITE_LLM_ENDPOINT === 'string'
    ? runtimeEnv.VITE_LLM_ENDPOINT.trim()
    : '';
  if (fromEnv) return fromEnv;

  if (typeof window !== 'undefined') {
    const fromWindow = (window as any).__HLSF_LLM_ENDPOINT__;
    if (typeof fromWindow === 'string' && fromWindow.trim()) {
      return fromWindow.trim();
    }
  }

  return DEFAULT_LLM_ENDPOINT;
}

function normalizeLlmUrl(endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(endpoint, window.location.origin).toString();
  }
  return new URL(endpoint, 'http://localhost').toString();
}

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

  if (rawText) {
    if (interpretation && interpretationWordCount >= 8) {
      return { text: interpretation, reason: 'interpretation-text' };
    }
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

function getLocalHlsfFallback(): string | null {
  if (typeof window === 'undefined') return null;
  const voice = (window as any).CognitionEngine?.voice;
  const latest = typeof voice?.getLatestLocalOutputs === 'function'
    ? voice.getLatestLocalOutputs()
    : voice?.latestLocalOutputs;
  const candidates = [latest?.localResponse, latest?.localThought, latest?.prompt]
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  return candidates[0] || null;
}

function formatLlmError(llm: LLMResult): string {
  const parts = [llm.error || 'LLM request failed'];
  if (llm.status) parts.push(`HTTP ${llm.status}`);
  if (llm.endpoint) parts.push(`Endpoint: ${llm.endpoint}`);
  return parts.filter(Boolean).join(' · ');
}

export async function callLLM(
  prompt: string,
  thoughts: string[],
  config: CognitionConfig,
  mode: CognitionMode,
  history: CognitionHistoryEntry[],
  options: { interpretationText?: string; rawPrompt?: string; adjacencyTokens?: string[] } = {},
): Promise<LLMResult> {
  const systemStyle = thinkingStyleToSystemMessage(config.thinkingStyle);
  const emergentDirective = buildEmergentThoughtDirective();
  const hiddenInstruction =
    mode === 'hidden'
      ? 'You are handling a /hidden reflection prompt. Describe your chain of thought by rotating through the horizontal, longitudinal, and sagittal axes of the HLSF. At each axis, report the intersection-based insights that emerge, but keep this reasoning private.'
      : null;
  const historyContext = formatHistoryContext(history);
  const thoughtsBlock = thoughts.map(thought => `- ${thought}`).join('\n');
  const userSegments = [
    mode === 'hidden'
      ? 'Hidden rotation reflection request (keep response aligned to the user-visible voice).'
      : 'Visible prompt to address for the user.',
    `Prompt:\n${prompt}`,
    historyContext ? `Conversation history:\n${historyContext}` : null,
    thoughts.length
      ? `Internal thought summaries (context only, do not repeat verbatim):\n\`\`\`\n${thoughtsBlock}\n\`\`\``
      : null,
  ].filter((segment): segment is string => Boolean(segment));

  const messages = [
    { role: 'system', content: [systemStyle, emergentDirective].filter(Boolean).join('\n\n') },
    ...(hiddenInstruction ? [{ role: 'system', content: hiddenInstruction }] : []),
    { role: 'user', content: userSegments.join('\n\n') },
    {
      role: 'system',
      content:
        'Produce a single coherent answer for the user that integrates the internal thoughts without echoing the bullet list verbatim. Do not mention /hidden prompts, the hidden process, or expose the internal trace.',
    },
  ];

  const endpoint = resolveLlmEndpoint();
  const requestUrl = normalizeLlmUrl(endpoint);
  const { interpretationText, rawPrompt, adjacencyTokens } = options;
  const fallback = (() => {
    const local = getLocalHlsfFallback();
    if (local) {
      const text = tidyFallbackText(local);
      return text ? { text, reason: 'local-output-suite' as const } : null;
    }
    const thought: ThoughtNode = {
      interpretationText,
      rawText: rawPrompt ?? prompt,
      adjacencyTokens,
    };
    const computed = computeFallbackArticulation(thought);
    return { text: computed.text, reason: computed.reason };
  })();

  if (isStaticFileProtocol() && endpoint.startsWith('/')) {
    const message =
      'LLM backend is not configured for file:// loads. Configure VITE_LLM_ENDPOINT or run the dev server so /api/llm is available.';
    updateThoughtLogStatus(message);
    return {
      model: 'local-llm',
      temperature: 0.7,
      response: fallback?.text ?? '',
      error: message,
      isFallback: true,
      endpoint: requestUrl,
      status: 0,
      fallbackText: fallback?.text,
      fallbackReason: fallback?.reason,
    };
  }

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        interpretationText: interpretationText || fallback?.text,
        rawText: rawPrompt ?? prompt,
      }),
    });
    if (!response.ok) {
      let errorText = '';
      try {
        const json = await response.json();
        errorText = json?.details || json?.error || JSON.stringify(json);
      } catch {
        errorText = await response.text().catch(() => '');
      }
      const errorMessage = `LLM request failed (${response.status})`;
      const detailedMessage = errorText ? `${errorMessage}: ${errorText}` : errorMessage;
      const err = new Error(detailedMessage);
      (err as any).status = response.status;
      (err as any).body = errorText;
      throw err;
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    return {
      model: data?.model ?? 'local-llm',
      temperature: data?.temperature ?? 0.7,
      response: content,
      usage: data?.usage,
      endpoint: requestUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as any)?.status as number | undefined;
    const rawError = (error as any)?.body as string | undefined;
    console.error('LLM request failed', {
      endpoint: requestUrl,
      status,
      rawError,
      error,
    });
    updateThoughtLogStatus(
      status
        ? `LLM request failed (${status}). Check LLM endpoint or network.`
        : 'LLM request failed. Halting rotation.',
    );
    const fallbackResponse = fallback;
    return {
      model: 'local-llm',
      temperature: 0.7,
      response: fallbackResponse?.text ?? '',
      error: message,
      isFallback: true,
      endpoint: requestUrl,
      status,
      rawError,
      fallbackText: fallbackResponse?.text,
      fallbackReason: fallbackResponse?.reason,
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
