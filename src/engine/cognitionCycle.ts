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
  };
  llm: LLMResult;
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

  const llmResult = await callLLM(
    truncatedPrompt,
    perIterationText,
    config,
    mode,
    history,
  );

  const run: CognitionRun = {
    id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    thoughts: { perIterationTokens, perIterationText },
    llm: llmResult,
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

      if (shouldExitCycle(run.llm.response)) {
        termination = 'exit';
        break;
      }

      if (run.mode === 'visible') {
        const hiddenPrompt = composeHiddenPrompt(history);
        entry.hiddenPrompt = hiddenPrompt;
        currentPrompt = hiddenPrompt;
      } else {
        currentPrompt = truncateToWords(run.llm.response ?? '', sanitizedConfig.maxPromptWords);
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
    promptLines.push('Reference answer:', reference);
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
  return { thinkingStyle, iterations, rotationSpeed, affinityThreshold, maxPromptWords, maxIterations };
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

  return new Promise(resolve => {
    let angle = 0;
    const bufferTokens: string[] = [];

    const step = () => {
      angle += degreesPerFrame;

      if (angle >= 360) {
        stopRotationAnimation(iterationIndex);
        const text = materializeThought(bufferTokens, config.thinkingStyle);
        commitThoughtLineToUI(text);
        resolve({ tokens: bufferTokens.slice(), text });
        return;
      }

      const intersections = getIntersectionsAtAngle(hiddenGraph, angle);
      for (const inter of intersections) {
        if (inter.affinity >= config.affinityThreshold) {
          bufferTokens.push(...inter.tokens);
          streamTokensToThoughtLog(inter.tokens, config.thinkingStyle, iterationIndex);
        }
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
}

function stopRotationAnimation(iterationIndex: number): void {
  if (typeof window === 'undefined') return;
  const root = (window as any).HLSF;
  if (!root?.state?.emergent) return;
  root.state.emergent.on = false;
  updateThoughtLogStatus(
    `Rotation ${iterationIndex + 1}/${activeRotationConfig?.iterations ?? 1} committed`,
  );
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
  const entry = iterationDom.get(iterationIndex);
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

function commitThoughtLineToUI(text: string): void {
  const entry = iterationDom.get(activeIterationIndex);
  if (!entry) return;
  entry.textEl.textContent = text || '…';
}

function prepareThoughtLogUI(iterations: number): void {
  if (typeof document === 'undefined') {
    iterationDom.clear();
    tokenStreamQueues.clear();
    return;
  }
  const root = document.getElementById('thought-log');
  if (!root) {
    iterationDom.clear();
    tokenStreamQueues.clear();
    return;
  }
  root.innerHTML = '';
  iterationDom.clear();
  tokenStreamQueues.clear();
  const count = Math.max(1, iterations);
  for (let i = 0; i < count; i += 1) {
    const block = document.createElement('div');
    block.className = 'thought-iteration';
    block.dataset.iteration = String(i);

    const header = document.createElement('div');
    header.className = 'thought-iteration__header';
    header.textContent = `Rotation ${i + 1}`;

    const tokensEl = document.createElement('div');
    tokensEl.className = 'thought-iteration__tokens';

    const textEl = document.createElement('div');
    textEl.className = 'thought-iteration__text';
    textEl.textContent = 'Awaiting synthesis…';

    block.append(header, tokensEl, textEl);
    root.appendChild(block);
    iterationDom.set(i, { root: block, tokensEl, textEl });
  }
}

function setActiveThoughtIteration(index: number): void {
  activeIterationIndex = index;
  if (typeof document === 'undefined') return;
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
  const unique = Array.from(new Set(tokens.filter(Boolean)));
  switch (style) {
    case 'concise':
      return unique.join(' ');
    case 'analytic':
      return unique
        .map((token, index) => `${index + 1}. ${token}`)
        .join(' ');
    case 'dreamlike':
      return unique.join(' ~ ');
    case 'dense':
      return unique.join(' · ');
    default:
      return tokens.join(' ');
  }
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

export async function callLLM(
  prompt: string,
  thoughts: string[],
  config: CognitionConfig,
  mode: CognitionMode,
  history: CognitionHistoryEntry[],
): Promise<LLMResult> {
  const systemStyle = thinkingStyleToSystemMessage(config.thinkingStyle);
  const hiddenInstruction =
    mode === 'hidden'
      ? 'You are handling a /hidden reflection prompt. Describe your chain of thought by rotating through the horizontal, longitudinal, and sagittal axes of the HLSF. At each axis, report the intersection-based insights that emerge, but keep this reasoning private.'
      : null;
  const historyContext = formatHistoryContext(history);
  const userSegments = [
    mode === 'hidden'
      ? 'Hidden rotation reflection request (keep response aligned to the user-visible voice).'
      : 'Visible prompt to address for the user.',
    `Prompt:\n${prompt}`,
    historyContext ? `Conversation history:\n${historyContext}` : null,
    thoughts.length
      ? `Internal thought lines:\n${thoughts.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
      : null,
  ].filter((segment): segment is string => Boolean(segment));

  const messages = [
    { role: 'system', content: systemStyle },
    ...(hiddenInstruction ? [{ role: 'system', content: hiddenInstruction }] : []),
    { role: 'user', content: userSegments.join('\n\n') },
    {
      role: 'system',
      content:
        'Produce a single coherent answer for the user that integrates the internal thoughts. Do not mention /hidden prompts, the hidden process, or expose the internal trace.',
    },
  ];

  try {
    const response = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status})`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    return {
      model: data?.model ?? 'local-llm',
      temperature: data?.temperature ?? 0.7,
      response: content,
      usage: data?.usage,
    };
  } catch (error) {
    const fallback = thoughts.length ? thoughts.join(' ') : 'Unable to generate a response.';
    return {
      model: 'local-llm',
      temperature: 0.7,
      response: fallback,
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
