import './styles.css';
import { runBreathingHlsf, type BreathingConfig, type BreathingMode, type Graph } from './engine/breathingHlsfEngine';
import { anchorPronouns } from './engine/anchorPronouns';

const consoleBuffer: string[] = [];
const HEADER_LINES = 3;
const TAIL_LINES = 16;

const stopwords = new Set<string>([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'my',
  'i',
  'am',
  'is',
  'are',
  'you',
]);

const DEFAULT_CONFIG: BreathingConfig = {
  dimension: 6,
  depth: 3,
  o10Size: 9,
  ccBranches: 5,
  collapseRadius: 2,
  maxNodes: 1600,
  maxEdges: 3200,
  concurrency: 2,
  breathLimit: 5,
  rotationMillis: 200,
  stopwords,
};

let currentGraph: Graph = { nodes: new Map(), edges: [] };
let currentRunId = 0;

const elements = {
  consoleLines: document.getElementById('console-lines') as HTMLElement | null,
  promptInput: document.getElementById('prompt-input') as HTMLInputElement | null,
  runBtn: document.getElementById('run-btn') as HTMLButtonElement | null,
  modePrompt: document.getElementById('mode-prompt') as HTMLInputElement | null,
  modeSeed: document.getElementById('mode-seed') as HTMLInputElement | null,
  seedControls: document.getElementById('seed-controls') as HTMLElement | null,
  seedToken: document.getElementById('seed-token') as HTMLInputElement | null,
  seedDimension: document.getElementById('seed-dimension') as HTMLInputElement | null,
  seedDepth: document.getElementById('seed-depth') as HTMLInputElement | null,
  o10Size: document.getElementById('o10-size') as HTMLInputElement | null,
  ccBranches: document.getElementById('cc-branches') as HTMLInputElement | null,
  collapseRadius: document.getElementById('collapse-radius') as HTMLInputElement | null,
  seedRunBtn: document.getElementById('seed-run-btn') as HTMLButtonElement | null,
  visualizer: document.getElementById('hlsf-visualizer') as HTMLElement | null,
  thoughtTrace: document.getElementById('thought-trace-panel') as HTMLElement | null,
  voiceModelPanel: document.getElementById('voice-model-panel') as HTMLElement | null,
  voiceCloneStudio: document.getElementById('voice-clone-studio') as HTMLElement | null,
};

function pushConsole(line: string): void {
  consoleBuffer.push(line);
  renderConsole();
}

function renderConsole(): void {
  const target = elements.consoleLines;
  if (!target) return;
  const head = consoleBuffer.slice(0, HEADER_LINES);
  const tail = consoleBuffer.slice(-TAIL_LINES);
  const hasGap = consoleBuffer.length > HEADER_LINES + TAIL_LINES;
  const lines = hasGap ? [...head, '⋯', ...tail] : consoleBuffer;
  target.textContent = lines.join('\n');
}

function renderGraphSnapshot(graph: Graph, label = 'Graph update'): void {
  const target = elements.visualizer;
  if (!target) return;
  target.innerHTML = '';
  const meta = document.createElement('div');
  meta.className = 'viz-meta';
  meta.textContent = `${label}: Nodes ${graph.nodes.size} · Edges ${graph.edges.length}`;
  const list = document.createElement('ul');
  list.className = 'viz-list';
  Array.from(graph.nodes.values())
    .slice(0, 20)
    .forEach((node) => {
      const item = document.createElement('li');
      item.textContent = `${node.label}`;
      list.appendChild(item);
    });
  target.append(meta, list);
}

function renderThoughtTrace(thoughts: string[], status: string, seed: string): void {
  const container = elements.thoughtTrace;
  if (!container) return;
  container.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'trace-header';
  header.textContent = `Status: ${status} | Seed: ${seed}`;
  const list = document.createElement('ol');
  list.className = 'trace-list';
  thoughts.forEach((thought) => {
    const item = document.createElement('li');
    item.textContent = thought;
    list.appendChild(item);
  });
  container.append(header, list);
}

function renderVoicePanels(): void {
  if (elements.voiceModelPanel && !elements.voiceModelPanel.childElementCount) {
    const placeholder = document.createElement('div');
    placeholder.className = 'panel-card';
    placeholder.innerHTML = '<h3>Voice model interface</h3><p>Connect your voice model controls here.</p>';
    elements.voiceModelPanel.appendChild(placeholder);
  }
  if (elements.voiceCloneStudio && !elements.voiceCloneStudio.childElementCount) {
    const placeholder = document.createElement('div');
    placeholder.className = 'panel-card';
    placeholder.innerHTML = '<h3>Voice clone studio</h3><p>Clone and preview voices alongside the HLSF loop.</p>';
    elements.voiceCloneStudio.appendChild(placeholder);
  }
}

function readConfigFromControls(base: BreathingConfig): BreathingConfig {
  const dimension = Number(elements.seedDimension?.value || base.dimension);
  const depth = Number(elements.seedDepth?.value || base.depth);
  const o10Size = Number(elements.o10Size?.value || base.o10Size);
  const ccBranches = Number(elements.ccBranches?.value || base.ccBranches);
  const collapseRadius = Number(elements.collapseRadius?.value || base.collapseRadius);
  return {
    ...base,
    dimension: Number.isFinite(dimension) ? dimension : base.dimension,
    depth: Number.isFinite(depth) ? depth : base.depth,
    o10Size: Number.isFinite(o10Size) ? o10Size : base.o10Size,
    ccBranches: Number.isFinite(ccBranches) ? ccBranches : base.ccBranches,
    collapseRadius: Number.isFinite(collapseRadius) ? collapseRadius : base.collapseRadius,
  };
}

function chooseSeedTokenFromPrompt(prompt: string): string {
  const tokens = prompt.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const scored = tokens
    .map((token, idx) => {
      const normalized = token.trim();
      const lower = normalized.toLowerCase();
      const isProper = /^[A-Z][a-z0-9]+/.test(normalized);
      const weight = (isProper ? 3 : 1) + (tokens.length - idx) * 0.01;
      return { token: normalized, lower, weight };
    })
    .filter((entry) => !stopwords.has(entry.lower));
  if (!scored.length) return tokens[0] || 'seed';
  scored.sort((a, b) => b.weight - a.weight);
  return scored[0].token;
}

function buildAdjacencyCache() {
  const memory = new Map<string, { nodes: any[]; edges: any[] }>();
  return {
    get: (key: string) => memory.get(key),
    set: (key: string, value: { nodes: any[]; edges: any[] }) => memory.set(key, value),
  };
}

async function mockExpandAdjacency(token: string) {
  const cached = adjacencyCache.get(token);
  if (cached) return cached;
  const neighbors = Array.from({ length: 10 }, (_, idx) => `${token}-${idx + 1}`);
  const nodes = neighbors.map((label, idx) => ({ id: label, label, weight: 1 + (idx % 3) }));
  const edges = neighbors.map((label, idx) => ({ src: token, dst: label, weight: 0.5 + idx * 0.1 }));
  const delta = { nodes, edges };
  adjacencyCache.set(token, delta);
  return delta;
}

async function articulate(thoughts: string[], graph: Graph, origin: string): Promise<string> {
  const anchored = anchorPronouns(thoughts, [origin]);
  const preview = anchored.slice(-3).join(' | ');
  return `Breathing cycle complete. ${origin} anchored. Trace: ${preview || 'No trace captured.'}`;
}

const adjacencyCache = buildAdjacencyCache();

function applyDelta(delta: { nodes: any[]; edges: any[] }, layer: string): void {
  delta.nodes.forEach((node) => {
    if (!currentGraph.nodes.has(node.id)) {
      currentGraph.nodes.set(node.id, { ...node, label: node.label || node.id, layer });
    }
  });
  delta.edges.forEach((edge) => {
    currentGraph.edges.push({ ...edge, layer });
  });
}

function setGraph(graph: Graph): void {
  currentGraph = {
    nodes: new Map(graph.nodes),
    edges: [...graph.edges],
  };
}

function getGraph(): Graph {
  return {
    nodes: new Map(currentGraph.nodes),
    edges: [...currentGraph.edges],
  };
}

async function startBreathing(mode: BreathingMode): Promise<void> {
  const input = elements.promptInput?.value?.trim() || '';
  if (!input) {
    alert('Please enter a prompt or seed token.');
    return;
  }
  const seedFromControls = elements.seedToken?.value?.trim();
  const seed = mode === 'seed' ? seedFromControls || input : chooseSeedTokenFromPrompt(input);
  const config = readConfigFromControls(DEFAULT_CONFIG);
  const runId = ++currentRunId;
  currentGraph = { nodes: new Map([[seed, { id: seed, label: seed, weight: 1 }]]), edges: [] };
  renderThoughtTrace([], 'Thinking…', seed);
  renderGraphSnapshot(currentGraph, 'Initialized');
  pushConsole(`Starting breathing loop with seed "${seed}"`);

  const deps = {
    llm: {
      expandAdjacency: mockExpandAdjacency,
      articulate,
    },
    applyDelta,
    getGraph,
    setGraph,
    onThought: (thought: string) => {
      thoughtBuffer.push(thought);
      renderThoughtTrace(thoughtBuffer, 'Thinking…', seed);
    },
    onGraph: (graph: Graph) => renderGraphSnapshot(graph, 'Breathing update'),
    shouldAbort: () => runId !== currentRunId,
    cache: adjacencyCache,
  } as const;

  const thoughtBuffer: string[] = [];
  const result = await runBreathingHlsf(seed, config, deps);
  if (runId !== currentRunId) return;
  const anchoredThoughts = anchorPronouns(result.thoughts, [seed]);
  renderThoughtTrace(anchoredThoughts, 'Answer ready', seed);
  renderGraphSnapshot(result.finalGraph, 'Collapsed');
  const finalText = anchorPronouns([result.finalText], [seed])[0];
  pushConsole(finalText);
  if (elements.thoughtTrace) {
    const response = document.createElement('div');
    response.className = 'final-response';
    response.textContent = finalText;
    elements.thoughtTrace.appendChild(response);
  }
}

function setupListeners(): void {
  elements.runBtn?.addEventListener('click', () => {
    const mode: BreathingMode = elements.modeSeed?.checked ? 'seed' : 'prompt';
    startBreathing(mode);
  });
  elements.seedRunBtn?.addEventListener('click', () => {
    elements.runBtn?.click();
  });
  elements.promptInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      elements.runBtn?.click();
    }
  });
  elements.modeSeed?.addEventListener('change', () => {
    if (elements.modeSeed?.checked) {
      elements.seedControls?.style && (elements.seedControls.style.display = 'grid');
      if (elements.promptInput) elements.promptInput.placeholder = 'seed token (optional)';
    }
  });
  elements.modePrompt?.addEventListener('change', () => {
    if (elements.modePrompt?.checked) {
      elements.seedControls?.style && (elements.seedControls.style.display = 'none');
      if (elements.promptInput) elements.promptInput.placeholder = 'Enter prompt or seed token…';
    }
  });
}

function bootstrap(): void {
  renderConsole();
  renderVoicePanels();
  renderThoughtTrace([], 'Idle', '—');
  setupListeners();
}

bootstrap();
