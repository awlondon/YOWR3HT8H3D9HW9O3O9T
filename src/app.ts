import { SETTINGS, PERFORMANCE_PROFILES, resolvePerformanceProfile } from './settings';
import { PipelineWorkerClient } from './engine/pipelineWorkerClient';
import { globalCommandRegistry } from './controllers/commandRegistry';
import {
  SessionManager,
  type LocalHlsfAdjacencySummary,
  type LocalHlsfAdjacencyTokenSummary,
  type LocalHlsfMemoryState,
  type LocalHlsfPromptRecord,
} from './controllers/sessionManager';
import { updateHlsfLimitSummary, formatHlsfLimitValue } from './controllers/uiUpdater';
import { knowledgeStore } from './engine/knowledgeStore';
import { normalizeRecord } from './engine/normalize';
import { VectorSemanticStore } from './engine/vectorSemantics';
import { AutonomousAgent } from './agent/autonomousAgent';
import { createRemoteDbFileWriter, type RemoteDbDirectoryStats } from './engine/remoteDbWriter';
import { tokenizeWithSymbols } from './tokens/tokenize';
import { buildSessionExport } from './export/session';
import { computeModelParameters, MODEL_PARAM_DEFAULTS, resolveModelParamConfig } from './export/modelParams';
import { initializeVoiceClonePanel, resetVoiceCloneStore, signalVoiceCloneTokensChanged } from './voice/voiceClone';
import { initializeVoiceModelDock } from './voice/voiceModel';
import { initializeUserAvatarStore } from './userAvatar';
import { initializeSaasPlatform, registerSaasCommands } from './saas/platform';
import { demoGoogleSignIn } from './auth/google';
import { base64Preview, decryptString, encryptString, generateSymmetricKey } from './saas/encryption';
import { initializeLoginForm } from './onboarding/loginFlow';
import { recordCommandUsage } from './analytics/commandUsage';

declare global {
  interface Window {
    CognitionEngine?: Record<string, unknown>;
    animateComposite?: (graph: unknown, glyphOnly?: boolean) => unknown;
  }
}
// ============================================
// CONFIGURATION
// ============================================
interface PricingModel {
  inputPerMillion: number;
  outputPerMillion: number;
}

interface EngineConfig {
  MAX_TOKENS_PER_PROMPT: number;
  MAX_TOKENS_PER_RESPONSE: number;
  INPUT_WORD_LIMIT: number;
  DOCUMENT_WORD_LIMIT: number;
  PROMPT_LOG_LIMIT: number;
  ORIGINAL_OUTPUT_WORD_LIMIT: number;
  LOCAL_OUTPUT_WORD_LIMIT: number;
  LOCAL_RESPONSE_WORD_LIMIT: number;
  MAX_CONCURRENCY: number;
  MAX_RETRY_ATTEMPTS: number;
  RETRY_BASE_DELAY_MS: number;
  DOCUMENT_CHUNK_SIZE: number;
  CACHE_SEED_LIMIT: number;
  DEFAULT_MODEL: string;
  MODEL_PRICING: Record<string, PricingModel>;
  ESTIMATED_COMPLETION_RATIO: number;
  ADJACENCY_TOKEN_ESTIMATES: { prompt: number; completion: number };
  ADJACENCY_RECURSION_DEPTH: number;
  ADJACENCY_EDGES_PER_LEVEL: number;
  ADJACENCY_SPAWN_LIMIT: number;
  ADJACENCY_RELATIONSHIPS_PER_NODE: number;
  NETWORK_RETRY_BACKOFF_MS: number;
}

const CONFIG: EngineConfig = {
  MAX_TOKENS_PER_PROMPT: 500,
  MAX_TOKENS_PER_RESPONSE: 1500,
  INPUT_WORD_LIMIT: 100,
  DOCUMENT_WORD_LIMIT: 350,
  PROMPT_LOG_LIMIT: 250,
  ORIGINAL_OUTPUT_WORD_LIMIT: 200,
  LOCAL_OUTPUT_WORD_LIMIT: 100,
  LOCAL_RESPONSE_WORD_LIMIT: 20,
  MAX_CONCURRENCY: 5,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 500,
  DOCUMENT_CHUNK_SIZE: 8,
  CACHE_SEED_LIMIT: 8000,
  DEFAULT_MODEL: 'gpt-4o-mini',
  MODEL_PRICING: {
    default: { inputPerMillion: 0.15, outputPerMillion: 0.60 },
    'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  },
  ESTIMATED_COMPLETION_RATIO: 0.7,
  ADJACENCY_TOKEN_ESTIMATES: {
    prompt: 220,
    completion: 320,
  },
  ADJACENCY_RECURSION_DEPTH: 3,
  ADJACENCY_EDGES_PER_LEVEL: 4,
  ADJACENCY_SPAWN_LIMIT: 2,
  ADJACENCY_RELATIONSHIPS_PER_NODE: 8,
  NETWORK_RETRY_BACKOFF_MS: 5000,
};

const MAX_RECURSION_DEPTH = 8;
const MAX_LEVEL_UP_SEEDS = 64;

function resolveAutoBypassOnboarding(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const { location } = window;
  const globalOverride = (window as any).AUTO_BYPASS_ONBOARDING;

  if (typeof globalOverride === 'boolean') {
    return globalOverride;
  }

  if (typeof globalOverride === 'string') {
    const normalized = globalOverride.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  const hostname = typeof location?.hostname === 'string' ? location.hostname : '';
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

  const isDev = typeof import.meta !== 'undefined'
    && typeof (import.meta as any).env === 'object'
    && Boolean((import.meta as any).env?.DEV);

  return Boolean(isDev && isLocalhost);
}

// Automatically promote visitors to the main application without showing the landing/login flow.
const AUTO_BYPASS_ONBOARDING = resolveAutoBypassOnboarding();
const AUTO_BYPASS_MEMBERSHIP_DETAILS = {
  plan: 'admin',
  name: 'Local Operator',
  email: 'operator@local.dev',
  role: 'admin',
  authProvider: 'auto-bypass',
} as const;

const vectorSemanticStore = new VectorSemanticStore();
const pipelineClient = new PipelineWorkerClient({ embeddingStore: vectorSemanticStore });
const commandRegistry = globalCommandRegistry;

const HIDDEN_EDGE_MIN_WEIGHT = 0.05;
const HIDDEN_ADJACENCY_RELATION = 'hidden-adjacency';
const DEFAULT_HIDDEN_ATTENTION_PER_TOKEN = 6;
const DEFAULT_HIDDEN_ADJACENCY_DEPTH = 2;
const DEFAULT_HIDDEN_ADJACENCY_CAP = 128;
const RELATION_TYPE_CAP_MIN = 1;
const RELATION_TYPE_CAP_MAX = 50;
const RELATION_TYPE_CAP_DEFAULT = 50;
const EDGES_PER_TYPE_MIN = 1;
const EDGES_PER_TYPE_DEFAULT = 3;
const EDGES_PER_TYPE_MAX = 10;

const memoryStorageFallback = new Map<string, string>();
const TOKEN_CACHE_PREFIX = 'hlsf_token_';
const DB_INDEX_KEY = 'hlsf_token_index';
const DB_RAW_KEY = 'hlsf_db_snapshot';
const API_KEY_STORAGE_KEY = 'hlsf_api_key';
const GLYPH_LEDGER_STORAGE_KEY = 'hlsf_glyph_ledger';

const DEFAULT_NODE_SIZE = 1;
const NODE_SIZE_MIN = 0.5;
const NODE_SIZE_MAX = 2.5;
const DEFAULT_EDGE_WIDTH = 0.2;
const EDGE_WIDTH_MIN = 0.01;
const EDGE_WIDTH_MAX = 1;
const DEFAULT_ALPHA = 0.67;

const TokenToGlyph = new Map<string, string>();
const GlyphToToken = new Map<string, Set<string>>();
const relationColorCache = new Map<string, string>();

const GLYPH_LIBRARY: string[] = [
  '●', '○', '▲', '△', '▴', '▵', '▼', '▽', '◆', '◇', '■', '□', '▣', '▤', '▥', '▦', '▧', '▨', '▩', '★',
  '☆', '✦', '✧', '✩', '✪', '✫', '✬', '✭', '✮', '✯', '✰', '✱', '✲', '✳', '✴', '✵', '✶', '✷', '✸', '✹',
  '✺', '✻', '✼', '✽', '✾', '✿', '❀', '❁', '❂', '❃', '❄', '❅', '❆', '❇', '❈', '❉', '❊', '❋', '◐', '◑',
  '◒', '◓', '◔', '◕', '◖', '◗', '◰', '◱', '◲', '◳', '◴', '◵', '◶', '◷', '◸', '◹', '◺', '◻', '◼', '◽',
  '◾', '⬟', '⬠', '⬡', '⬢', '⬣', '⬤', '⬥', '⬦', '⬧', '⬨', '⬩', '⬰', '⬱', '⬲', '⬳', '⬴', '⬵', '⬶', '⬷',
  '⬸', '⬹', '⬺', '⬻', '⬼', '⬽', '⬾', '⬿', '⌘', '⌖', '⌗', '⌙', '⌚', '⌛', '⏣', '⎈', '⍟', '⎔', '◉', '◎',
  '☉', '☼', '☀', '☾', '☽', '⚘', '⚚', '⚛', '⚜', '⚝', '⚞', '⚟', '⚠', '⚡', '⚢', '⚣', '⚤', '⚥', '⚧', '⚨',
  '⚩', '⚪', '⚫', '⚬', '⚮', '⚯', '⚰', '⚱', '⚲', '⚳', '⚴', '⚵', '⚶', '⚷', '⚸', '⚹', '⚺', '⚻', '⚼', '⚽',
  '⚾', '⛀', '⛁', '⛂', '⛃', '⛋', '⛌', '⛍', '⛎', '⛏', '⛐', '⛑', '⛒', '⛓', '⛔', '⛕', '⛖', '⛗', '⛘', '⛙',
  '⛚', '⛛', '⛜', '⛝', '⛞', '⛟',
];
const GLYPH_SET: string[] = [...GLYPH_LIBRARY];
const GLYPH_SEP = ' ';
const NUM_FMT = (value: number): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0.000';
  }
  return numeric.toFixed(3);
};

const saasPlatform = initializeSaasPlatform();
const userAvatarStore = initializeUserAvatarStore();

let voiceDockController: ReturnType<typeof initializeVoiceModelDock> = null;
let remotedir = false;

function isValidApiKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 24) return false;

  const knownPrefixes = ['sk-', 'rk-', 'sess-', 'ft-', 'oa-', 'gpt-'];
  if (knownPrefixes.some(prefix => trimmed.startsWith(prefix))) {
    return /^[A-Za-z0-9_-]+$/.test(trimmed);
  }

  return /^[A-Za-z0-9_-]{24,}$/.test(trimmed);
}

function parseStoredValue(raw: string | null, fallback: unknown): unknown {
  if (raw == null) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (trimmed === 'undefined') return undefined;
  if (trimmed === 'null') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function safeStorageGet(key: string, fallback: unknown = null): unknown {
  if (!key) return fallback;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        memoryStorageFallback.set(key, raw);
        return parseStoredValue(raw, fallback);
      }
    }
  } catch {
    // ignore access errors and fall back to in-memory cache
  }

  if (memoryStorageFallback.has(key)) {
    return parseStoredValue(memoryStorageFallback.get(key) ?? null, fallback);
  }

  return fallback;
}

function safeStorageSet(key: string, value: string | null): boolean {
  if (!key) return false;
  let persisted = false;
  try {
    if (typeof localStorage !== 'undefined') {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
      persisted = true;
    }
  } catch {
    persisted = false;
  }

  if (value === null) {
    memoryStorageFallback.delete(key);
  } else {
    memoryStorageFallback.set(key, value);
  }

  return persisted;
}

function safeStorageRemove(key: string): boolean {
  if (!key) return false;
  let removed = false;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
      removed = true;
    }
  } catch {
    removed = false;
  }

  memoryStorageFallback.delete(key);
  return removed;
}

function safeStorageKeys(prefix = ''): string[] {
  const keys = new Set<string>();
  const normalizedPrefix = typeof prefix === 'string' ? prefix : '';

  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (!normalizedPrefix || key.startsWith(normalizedPrefix)) {
          keys.add(key);
        }
      }
    }
  } catch {
    // ignore storage access errors
  }

  for (const key of memoryStorageFallback.keys()) {
    if (!normalizedPrefix || key.startsWith(normalizedPrefix)) {
      keys.add(key);
    }
  }

  return Array.from(keys);
}

function getDb(): any | null {
  if (typeof window === 'undefined') return null;
  const root = ((window as any).HLSF = (window as any).HLSF || {});
  if (root.dbCache && typeof root.dbCache === 'object') {
    return root.dbCache;
  }

  const persisted = safeStorageGet(DB_RAW_KEY, null);
  if (!persisted) return null;

  if (typeof persisted === 'string') {
    try {
      root.dbCache = JSON.parse(persisted);
      return root.dbCache;
    } catch {
      return null;
    }
  }

  if (typeof persisted === 'object') {
    root.dbCache = persisted;
    return root.dbCache;
  }

  return null;
}

function sanitize(value: string): string {
  const raw = value == null ? '' : String(value);
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setRemotedirFlag(connected: boolean): void {
  const flag = Boolean(connected);
  remotedir = flag;
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('remotedir-connected', flag);
    document.body.setAttribute('data-remotedir', flag ? 'connected' : 'disconnected');
  }
  if (typeof window !== 'undefined') {
    const root = (window as any).CognitionEngine || ((window as any).CognitionEngine = {});
    root.remoteDirectoryConnected = flag;
  }
}

interface AppElements {
  log: HTMLElement | null;
  cachedTokens: HTMLElement | null;
  cacheHitRate: HTMLElement | null;
  sessionCost: HTMLElement | null;
  sendBtn: HTMLElement | null;
  cancelBtn: HTMLElement | null;
  input: HTMLInputElement | null;
  apiModal: HTMLElement | null;
  apiKeyInput: HTMLInputElement | null;
  apiConfirmBtn: HTMLElement | null;
  apiCancelBtn: HTMLElement | null;
  avatarBundleInput: HTMLInputElement | null;
  readFileInput: HTMLInputElement | null;
}

const elements: AppElements = {
  log: null,
  cachedTokens: null,
  cacheHitRate: null,
  sessionCost: null,
  sendBtn: null,
  cancelBtn: null,
  input: null,
  apiModal: null,
  apiKeyInput: null,
  apiConfirmBtn: null,
  apiCancelBtn: null,
  avatarBundleInput: null,
  readFileInput: null,
};

function hydrateAppElements(root: Document | null = typeof document !== 'undefined' ? document : null): void {
  if (!root) return;
  elements.log = root.getElementById('log');
  elements.cachedTokens = root.getElementById('cached-tokens');
  elements.cacheHitRate = root.getElementById('cache-hit-rate');
  elements.sessionCost = root.getElementById('session-cost');
  elements.sendBtn = root.getElementById('send-btn');
  elements.cancelBtn = root.getElementById('cancel-btn');
  elements.input = root.getElementById('command-input') as HTMLInputElement | null;
  elements.apiModal = root.getElementById('api-modal');
  elements.apiKeyInput = root.getElementById('api-key-input') as HTMLInputElement | null;
  elements.apiConfirmBtn = root.getElementById('api-confirm');
  elements.apiCancelBtn = root.getElementById('api-cancel');
  elements.avatarBundleInput = root.getElementById('avatar-bundle-input') as HTMLInputElement | null;
  elements.readFileInput = root.getElementById('read-file') as HTMLInputElement | null;
}

if (typeof document !== 'undefined') {
  hydrateAppElements(document);
}

let sendButtonBound = false;
let cancelButtonBound = false;
let inputFieldBound = false;
let apiConfirmBound = false;
let apiCancelBound = false;
let apiKeyInputBound = false;
let logClickBound = false;

function bindCoreUiEvents(): void {
  const sendButton = elements.sendBtn instanceof HTMLButtonElement ? elements.sendBtn : null;
  const cancelButton = elements.cancelBtn instanceof HTMLButtonElement ? elements.cancelBtn : null;
  const inputField = elements.input instanceof HTMLInputElement ? elements.input : null;
  const apiConfirmBtn = elements.apiConfirmBtn instanceof HTMLButtonElement ? elements.apiConfirmBtn : null;
  const apiCancelBtn = elements.apiCancelBtn instanceof HTMLButtonElement ? elements.apiCancelBtn : null;
  const apiKeyInput = elements.apiKeyInput instanceof HTMLInputElement ? elements.apiKeyInput : null;
  const logElement = elements.log instanceof HTMLElement ? elements.log : null;

  if (sendButton && inputField && !sendButtonBound) {
    sendButton.addEventListener('click', () => {
      const rawValue = inputField.value;
      if (!rawValue || !rawValue.trim()) return;

      void submitPromptThroughEngine(rawValue, { source: 'input-field' })
        .then(result => {
          if (result.kind === 'command') {
            inputField.value = '';
          }
        })
        .catch(error => {
          console.error('Prompt submission failed:', error);
        });
    });
    sendButtonBound = true;
  }

  if (cancelButton && !cancelButtonBound) {
    cancelButton.addEventListener('click', () => {
      if (currentAbortController) {
        currentAbortController.abort();
        logWarning('Cancelling...');
      }
    });
    cancelButtonBound = true;
  }

  if (inputField && !inputFieldBound) {
    inputField.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendButton?.click();
      }
    });

    inputField.addEventListener('input', () => {
      handleLiveInputChange(inputField.value);
    });

    inputFieldBound = true;
  }

  if (apiConfirmBtn && !apiConfirmBound) {
    apiConfirmBtn.addEventListener('click', () => {
      applyApiKeyFromModal();
    });
    apiConfirmBound = true;
  }

  if (apiCancelBtn && !apiCancelBound) {
    apiCancelBtn.addEventListener('click', () => {
      const modal = elements.apiModal;
      if (modal instanceof HTMLElement) {
        modal.classList.add('hidden');
      }
      state.apiKey = '';
      state.networkOffline = true;
      state.networkErrorNotified = true;
      state.lastNetworkErrorTime = Date.now();
      safeStorageRemove(API_KEY_STORAGE_KEY);
      logWarning('Offline mode - limited functionality');
    });
    apiCancelBound = true;
  }

  if (apiKeyInput && !apiKeyInputBound) {
    apiKeyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyApiKeyFromModal();
      }
    });
    apiKeyInputBound = true;
  }

  if (logElement && !logClickBound) {
    logElement.addEventListener('click', handlePromptReviewClick);
    logClickBound = true;
  }
}

const sessionManager = new SessionManager({
  resolveLocalMemoryEdgeWeightFloor,
  limitAdjacencyEntryEdges,
  pruneRelationshipEdgesByWeight,
  windowRef: typeof window !== 'undefined' ? window : undefined,
});

let autonomousAgent: AutonomousAgent | null = null;

function ensureLocalHlsfMemory(): LocalHlsfMemoryState | null {
  return sessionManager.ensureLocalMemory();
}

function recordLocalPromptMemory(
  id: string,
  promptText: string,
  tokens: string[],
  adjacencyTargets: Array<{ token?: string; normalized?: string }> = [],
): LocalHlsfPromptRecord | null {
  return sessionManager.recordLocalPromptMemory(id, promptText, tokens, adjacencyTargets);
}

function summarizeAdjacencyMapForLocal(
  adjacencyMap: Map<string, any>,
  options: { limit?: number; edgesPerToken?: number } = {},
): LocalHlsfAdjacencyTokenSummary[] {
  return sessionManager.summarizeAdjacencyMap(adjacencyMap, options);
}

function recordLocalAdjacencySummary(
  id: string,
  adjacencyMap: Map<string, any>,
  label = 'prompt-adjacency',
  options: { limit?: number; edgesPerToken?: number } = {},
): LocalHlsfAdjacencySummary | null {
  return sessionManager.recordAdjacencySummary(id, adjacencyMap, label, options);
}

async function hydrateTokensFromKnowledgeStore(tokens: Array<{ token?: string } | string>): Promise<void> {
  if (!Array.isArray(tokens) || !tokens.length) return;
  const candidates = new Set<string>();
  for (const entry of tokens) {
    const raw = typeof entry === 'string' ? entry : String(entry?.token ?? '').trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (!lower || isTokenCached(lower)) continue;
    candidates.add(lower);
  }
  if (!candidates.size) return;
  try {
    const records = await knowledgeStore.bulkGet(Array.from(candidates));
    for (const record of records.values()) {
      stageDbRecordForCache(record);
    }
  } catch (error) {
    console.warn('Knowledge store hydration failed:', error);
  }
}

function clampRelationTypeCap(value: unknown): number {
  if (value === Infinity || value === 'Infinity') {
    return Infinity;
  }

  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) {
    const runtimeMax = (() => {
      if (typeof window === 'undefined') return RELATION_TYPE_CAP_DEFAULT;
      const candidate = Number((window as any)?.HLSF?.config?.maxRelationTypes);
      if (Number.isFinite(candidate) && candidate >= RELATION_TYPE_CAP_MIN) {
        return Math.max(RELATION_TYPE_CAP_MIN, Math.min(candidate, RELATION_TYPE_CAP_MAX));
      }
      return RELATION_TYPE_CAP_DEFAULT;
    })();
    return Math.max(RELATION_TYPE_CAP_MIN, Math.min(runtimeMax, RELATION_TYPE_CAP_MAX));
  }

  return Math.max(
    RELATION_TYPE_CAP_MIN,
    Math.min(RELATION_TYPE_CAP_MAX, numeric),
  );
}

function clampEdgesPerType(value: unknown): number {
  if (value === Infinity || value === 'Infinity') {
    return Infinity;
  }

  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) {
    const fallbackMax = Math.max(
      EDGES_PER_TYPE_DEFAULT,
      Number.isFinite(CONFIG.ADJACENCY_EDGES_PER_LEVEL)
        ? Number(CONFIG.ADJACENCY_EDGES_PER_LEVEL)
        : EDGES_PER_TYPE_DEFAULT,
    );
    return Math.max(EDGES_PER_TYPE_MIN, Math.min(fallbackMax, EDGES_PER_TYPE_MAX));
  }

  return Math.max(
    EDGES_PER_TYPE_MIN,
    Math.min(EDGES_PER_TYPE_MAX, numeric),
  );
}

function clampRecursionDepth(value: unknown): number {
  if (value === Infinity || value === 'Infinity') {
    return MAX_RECURSION_DEPTH;
  }
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) {
    const fallback = Math.floor(Number(CONFIG.ADJACENCY_RECURSION_DEPTH));
    if (!Number.isFinite(fallback)) {
      return 0;
    }
    return Math.min(MAX_RECURSION_DEPTH, Math.max(0, fallback));
  }
  return Math.min(MAX_RECURSION_DEPTH, Math.max(0, numeric));
}

function applyRecursionDepthSetting(nextDepth: unknown): number {
  const clamped = clampRecursionDepth(nextDepth);
  if (typeof window !== 'undefined') {
    (window as any).HLSF = (window as any).HLSF || {};
    const config = ((window as any).HLSF.config = (window as any).HLSF.config || {});
    config.adjacencyRecursionDepth = clamped;
  }
  CONFIG.ADJACENCY_RECURSION_DEPTH = clamped;
  return clamped;
}

function getRecursionDepthSetting(): number {
  if (typeof window !== 'undefined' && window && (window as any).HLSF) {
    const config = (window as any).HLSF.config;
    if (config && Object.prototype.hasOwnProperty.call(config, 'adjacencyRecursionDepth')) {
      return clampRecursionDepth(config.adjacencyRecursionDepth);
    }
  }
  return clampRecursionDepth(CONFIG.ADJACENCY_RECURSION_DEPTH);
}

function activeSettings() {
  if (typeof window !== 'undefined' && window && (window as any).SETTINGS) {
    return (window as any).SETTINGS;
  }
  return SETTINGS;
}

function deriveRelationshipBudgetFallback(): number {
  const settings = activeSettings() || {};

  const fromSettings = (settings as Record<string, unknown>).maxRelationships;
  if (typeof fromSettings === 'number' && Number.isFinite(fromSettings)) {
    return Math.max(0, Math.floor(fromSettings));
  }
  if (typeof fromSettings === 'string') {
    const normalized = fromSettings.trim();
    if (normalized) {
      const numeric = Number(normalized.replace(/[_,\s]/g, ''));
      if (Number.isFinite(numeric)) {
        return Math.max(0, Math.floor(numeric));
      }
    }
  }

  const edgeCap = Number((settings as Record<string, unknown>).maxEdges);
  if (Number.isFinite(edgeCap) && edgeCap > 0) {
    return Math.max(0, Math.floor(edgeCap));
  }

  const nodeCap = Number((settings as Record<string, unknown>).maxNodes);
  if (Number.isFinite(nodeCap) && nodeCap > 0) {
    return Math.max(0, Math.floor(nodeCap * 2));
  }

  const defaultBudget = Number.isFinite(CONFIG.ADJACENCY_RELATIONSHIPS_PER_NODE)
    ? Math.max(0, Math.floor(CONFIG.ADJACENCY_RELATIONSHIPS_PER_NODE) * 2)
    : 0;
  return defaultBudget || 0;
}

function resolveHlsfRelationshipBudget(input: unknown): number {
  if (input === null || typeof input === 'undefined') {
    return deriveRelationshipBudgetFallback();
  }

  if (input === Infinity) {
    return Infinity;
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      return deriveRelationshipBudgetFallback();
    }
    return Math.max(0, Math.floor(input));
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return deriveRelationshipBudgetFallback();
    }
    const normalized = trimmed.toLowerCase();
    if (['infinity', 'inf', '∞', 'all', 'unbounded', 'unlimited'].includes(normalized)) {
      return Infinity;
    }
    if (['auto', 'default', 'dynamic', 'adaptive', 'recommended'].includes(normalized)) {
      return deriveRelationshipBudgetFallback();
    }

    const suffix = normalized.slice(-1);
    const multiplier = suffix === 'k'
      ? 1_000
      : suffix === 'm'
        ? 1_000_000
        : 1;
    const numericPortion = multiplier === 1 ? normalized : normalized.slice(0, -1);
    const numeric = Number(numericPortion.replace(/[_,\s]/g, ''));
    if (Number.isFinite(numeric)) {
      return Math.max(0, Math.floor(numeric * multiplier));
    }
  }

  return deriveRelationshipBudgetFallback();
}

function applyPerformanceCaps(settingsOverride = null) {
  const source = settingsOverride || activeSettings() || {};
  const branching = Math.max(2, Math.floor(Number(source.branchingFactor) || 2));
  const nodeCap = Math.max(1, Math.floor(Number(source.maxNodes) || 1600));
  const edgeCap = Math.max(branching * 2, Math.floor(Number(source.maxEdges) || 6400));
  const relationCap = Math.max(2, Math.floor(Number(source.maxRelationTypes) || 40));
  const rawRelationship = source.maxRelationships;
  const numericRelationship = Number(rawRelationship);
  const relationshipBudget = resolveHlsfRelationshipBudget(
    Number.isFinite(numericRelationship) ? numericRelationship : rawRelationship ?? null,
  );
  const pruneThreshold = Number.isFinite(Number(source.pruneWeightThreshold))
    ? Math.max(0, Number(source.pruneWeightThreshold))
    : 0.18;

  CONFIG.ADJACENCY_SPAWN_LIMIT = branching;
  CONFIG.ADJACENCY_RELATIONSHIPS_PER_NODE = relationCap;
  const derivedEdgesPerLevel = Math.max(
    branching,
    Math.floor(edgeCap / Math.max(1, nodeCap)),
  );
  CONFIG.ADJACENCY_EDGES_PER_LEVEL = derivedEdgesPerLevel;

  if (typeof window !== 'undefined') {
    window.HLSF = window.HLSF || {};
    const runtime = (window.HLSF.config = window.HLSF.config || {});
    runtime.liveTokenCap = nodeCap;
    runtime.maxNodeCount = nodeCap;
    runtime.maxEdgeCount = edgeCap;
    runtime.maxRelationshipCount = relationshipBudget;
    runtime.maxRelationTypes = relationCap;
    runtime.pruneWeightThreshold = pruneThreshold;
    runtime.liveEdgeWeightMin = pruneThreshold;
    runtime.localMemoryEdgeWeightMin = pruneThreshold;
    runtime.relationshipBudget = relationshipBudget;
    runtime.relationshipLimit = relationshipBudget;
  }

  if (typeof window !== 'undefined') {
    window.SETTINGS = Object.assign(window.SETTINGS || {}, source, {
      branchingFactor: branching,
      maxNodes: nodeCap,
      maxEdges: edgeCap,
      maxRelationships: rawRelationship ?? numericRelationship ?? relationshipBudget,
      maxRelationTypes: Math.max(50, relationCap),
      pruneWeightThreshold: pruneThreshold,
    });
  }

  updateHlsfLimitSummary({
    nodes: nodeCap,
    edges: edgeCap,
    relationships: relationshipBudget,
  });
}

applyPerformanceCaps();

function clampAlpha(value: unknown): number {
  const numeric = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_ALPHA;
  }
  return Math.max(0, Math.min(0.99, numeric));
}

function baseAlpha(): number {
  if (typeof window !== 'undefined') {
    window.HLSF = window.HLSF || {};
    const config = (window.HLSF.config = window.HLSF.config || {});
    if (Number.isFinite(config.alpha)) {
      const normalized = clampAlpha(config.alpha);
      if (normalized !== config.alpha) {
        config.alpha = normalized;
      }
      return normalized;
    }
    config.alpha = DEFAULT_ALPHA;
  }
  return DEFAULT_ALPHA;
}

function clampNodeSize(value: unknown): number {
  const numeric = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_NODE_SIZE;
  }
  return Math.max(NODE_SIZE_MIN, Math.min(NODE_SIZE_MAX, numeric));
}

function clampEdgeWidth(value: unknown): number {
  const numeric = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_EDGE_WIDTH;
  }
  return Math.max(EDGE_WIDTH_MIN, Math.min(EDGE_WIDTH_MAX, numeric));
}

type EdgeColorMode = 'theme' | 'weight' | 'relation';

function normalizeEdgeColorMode(value: unknown): EdgeColorMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'theme') return 'theme';
  if (normalized === 'weight' || normalized === 'attention') return 'weight';
  if (normalized === 'relation' || normalized === 'relations') return 'relation';
  return 'relation';
}

function shouldStartClusterZoom(event: MouseEvent): boolean {
  return event.shiftKey || event.altKey || event.metaKey;
}

function ensureClusterZoomOverlay(canvas: HTMLCanvasElement): HTMLDivElement | null {
  if (!canvas || typeof document === 'undefined') return null;
  const host = canvas.parentElement;
  if (!host) return null;
  let overlay = host.querySelector<HTMLDivElement>('.hlsf-cluster-zoom-box');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'hlsf-cluster-zoom-box';
    overlay.setAttribute('aria-hidden', 'true');
    host.appendChild(overlay);
  }
  return overlay;
}

function getCanvasRelativePosition(canvas: HTMLCanvasElement, event: MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.clientWidth || canvas.width || 1;
  const height = rect.height || canvas.clientHeight || canvas.height || 1;
  const rawX = event.clientX - rect.left;
  const rawY = event.clientY - rect.top;
  const clampedX = Math.max(0, Math.min(width, rawX));
  const clampedY = Math.max(0, Math.min(height, rawY));
  return { x: clampedX, y: clampedY };
}

function buildClusterSelectionRect(
  canvas: HTMLCanvasElement,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;
  const minX = Math.max(0, Math.min(width, Math.min(start.x, end.x)));
  const minY = Math.max(0, Math.min(height, Math.min(start.y, end.y)));
  const maxX = Math.max(0, Math.min(width, Math.max(start.x, end.x)));
  const maxY = Math.max(0, Math.min(height, Math.max(start.y, end.y)));
  const rectWidth = Math.max(1, maxX - minX);
  const rectHeight = Math.max(1, maxY - minY);
  return { x: minX, y: minY, width: rectWidth, height: rectHeight };
}

function screenToWorldFromCanvas(canvas: HTMLCanvasElement, point: { x: number; y: number }) {
  window.HLSF = window.HLSF || {};
  window.HLSF.view = window.HLSF.view || { x: 0, y: 0, scale: 1 };
  const view = window.HLSF.view;
  const scale = Number.isFinite(view.scale) ? view.scale : 1;
  const vx = Number.isFinite(view.x) ? view.x : 0;
  const vy = Number.isFinite(view.y) ? view.y : 0;
  return {
    x: (point.x - vx) / scale,
    y: (point.y - vy) / scale,
  };
}

type ClusterZoomMode = 'in' | 'out';

function applyClusterZoomSelection(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; width: number; height: number },
  mode: ClusterZoomMode = 'in',
) {
  if (!canvas || rect.width <= 0 || rect.height <= 0) return;
  const viewWidth = canvas.clientWidth || canvas.width || 1;
  const viewHeight = canvas.clientHeight || canvas.height || 1;
  const padding = 0.85;
  window.HLSF = window.HLSF || {};
  window.HLSF.view = window.HLSF.view || { x: 0, y: 0, scale: 1 };
  const currentView = window.HLSF.view;
  const currentScale = Number.isFinite(currentView.scale) ? currentView.scale : 1;
  const startWorld = screenToWorldFromCanvas(canvas, { x: rect.x, y: rect.y });
  const endWorld = screenToWorldFromCanvas(canvas, {
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  });
  const worldWidth = Math.max(1e-4, Math.abs(endWorld.x - startWorld.x));
  const worldHeight = Math.max(1e-4, Math.abs(endWorld.y - startWorld.y));
  const scaleByWidth = (viewWidth * padding) / worldWidth;
  const scaleByHeight = (viewHeight * padding) / worldHeight;
  const scaleCandidate = Math.min(scaleByWidth, scaleByHeight);
  const zoomRatio = scaleCandidate / Math.max(currentScale, 1e-4);
  const targetScale =
    mode === 'out'
      ? Math.min(48, Math.max(0.1, currentScale / Math.max(zoomRatio, 1e-4)))
      : Math.min(48, Math.max(0.1, scaleCandidate));
  const centerWorldX = startWorld.x + worldWidth / 2;
  const centerWorldY = startWorld.y + worldHeight / 2;
  const target = {
    scale: targetScale,
    x: viewWidth / 2 - centerWorldX * targetScale,
    y: viewHeight / 2 - centerWorldY * targetScale,
  };
  const travel = Math.hypot(rect.width, rect.height);
  const duration = Math.min(650, Math.max(220, travel * 1.2));
  animateViewport(target, duration);
}

function installClusterZoom(canvas: HTMLCanvasElement | null) {
  if (!canvas || canvas.dataset.clusterZoomBound === 'true') return;
  const overlay = ensureClusterZoomOverlay(canvas);
  if (!overlay) {
    canvas.dataset.clusterZoomBound = 'true';
    return;
  }

  const minSelectionSize = 64;
  let selecting = false;
  let startPoint = { x: 0, y: 0 };
  let currentRect: { x: number; y: number; width: number; height: number } | null = null;

  function resetOverlay() {
    overlay.style.left = '0px';
    overlay.style.top = '0px';
    overlay.style.width = '0px';
    overlay.style.height = '0px';
    overlay.setAttribute('aria-hidden', 'true');
    currentRect = null;
  }

  function updateOverlayRect(endPoint: { x: number; y: number }) {
    currentRect = buildClusterSelectionRect(canvas, startPoint, endPoint);
    overlay.style.left = `${currentRect.x}px`;
    overlay.style.top = `${currentRect.y}px`;
    overlay.style.width = `${currentRect.width}px`;
    overlay.style.height = `${currentRect.height}px`;
    overlay.setAttribute('aria-hidden', 'false');
  }

  function cancelSelection() {
    selecting = false;
    canvas.classList.remove('hlsf-selecting');
    overlay.classList.remove('is-active');
    resetOverlay();
  }

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (!shouldStartClusterZoom(event)) return;
    selecting = true;
    startPoint = getCanvasRelativePosition(canvas, event);
    updateOverlayRect(startPoint);
    overlay.classList.add('is-active');
    canvas.classList.add('hlsf-selecting');
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!selecting) return;
    const pos = getCanvasRelativePosition(canvas, event);
    updateOverlayRect(pos);
    event.preventDefault();
  };

  const onMouseUp = (event: MouseEvent) => {
    if (!selecting) return;
    const canvasSize = {
      width: canvas.clientWidth || canvas.width || 1,
      height: canvas.clientHeight || canvas.height || 1,
    };
    selecting = false;
    canvas.classList.remove('hlsf-selecting');
    overlay.classList.remove('is-active');
    const endPoint = event ? getCanvasRelativePosition(canvas, event) : startPoint;
    updateOverlayRect(endPoint);
    const rect = currentRect || buildClusterSelectionRect(canvas, startPoint, endPoint);
    const dragVector = { x: endPoint.x - startPoint.x, y: endPoint.y - startPoint.y };
    const shouldZoomOut = dragVector.x < 0 && dragVector.y < 0;
    resetOverlay();
    if (!rect) return;
    const effectiveWidth = Math.max(rect.width, Math.min(minSelectionSize, canvasSize.width));
    const effectiveHeight = Math.max(rect.height, Math.min(minSelectionSize, canvasSize.height));
    let normalizedRect = { ...rect };
    if (rect.width < minSelectionSize || rect.height < minSelectionSize) {
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      const halfW = Math.min(effectiveWidth / 2, canvasSize.width / 2);
      const halfH = Math.min(effectiveHeight / 2, canvasSize.height / 2);
      const left = Math.max(0, Math.min(canvasSize.width - effectiveWidth, centerX - halfW));
      const top = Math.max(0, Math.min(canvasSize.height - effectiveHeight, centerY - halfH));
      normalizedRect = {
        x: left,
        y: top,
        width: Math.min(canvasSize.width, Math.max(effectiveWidth, minSelectionSize)),
        height: Math.min(canvasSize.height, Math.max(effectiveHeight, minSelectionSize)),
      };
    }
    applyClusterZoomSelection(canvas, normalizedRect, shouldZoomOut ? 'out' : 'in');
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && selecting) {
      cancelSelection();
    }
  };

  canvas.addEventListener('mousedown', onMouseDown, { capture: true });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('blur', cancelSelection);
  canvas.dataset.clusterZoomBound = 'true';
  resetOverlay();
}

const MEMBERSHIP_LEVELS = {
  DEMO: 'demo',
  MEMBER: 'member',
} as const;

type MembershipLevel = typeof MEMBERSHIP_LEVELS[keyof typeof MEMBERSHIP_LEVELS];

interface CommandHelpEntry {
  command: string;
  description: string;
  requiresMembership: boolean;
}

const COMMAND_HELP_ENTRIES: CommandHelpEntry[] = [
  { command: '/help', description: 'Show this command catalog', requiresMembership: false },
  { command: '/clear', description: 'Clear log history', requiresMembership: true },
  { command: '/reset', description: 'Clear cache and database snapshots', requiresMembership: true },
  { command: '/del-avatar', description: 'Delete avatar conversation log and voice', requiresMembership: true },
  { command: '/sv-avatar', description: 'Save avatar archive', requiresMembership: true },
  { command: '/ld-avatar', description: 'Load avatar archive', requiresMembership: true },
  { command: '/stats', description: 'Session statistics overview', requiresMembership: true },
  { command: '/database', description: 'View database metadata', requiresMembership: true },
  { command: '/db', description: 'Alias for /database', requiresMembership: true },
  { command: '/export', description: 'Export database metadata as JSON', requiresMembership: true },
  { command: '/glyph', description: 'Generate glyph mappings', requiresMembership: true },
  { command: '/ledger', description: 'Inspect glyph ledger', requiresMembership: true },
  { command: '/encrypt', description: 'Encode text into glyphs', requiresMembership: true },
  { command: '/decrypt', description: 'Decode glyph sequences', requiresMembership: true },
  { command: '/exportledger', description: 'Export glyph ledger', requiresMembership: true },
  { command: '/import', description: 'Import HLSF database file', requiresMembership: true },
  { command: '/read', description: 'Ingest document for adjacency mapping', requiresMembership: true },
  { command: '/ingest', description: 'Alias for /read', requiresMembership: true },
  { command: '/loaddb', description: 'Load remote database manifest', requiresMembership: true },
  { command: '/load', description: 'Bootstrap remote database and sync directory', requiresMembership: false },
  { command: '/remotedir', description: 'Connect remote DB save directory', requiresMembership: false },
  { command: '/remotestats', description: 'View remote database statistics', requiresMembership: true },
  { command: '/remotedb', description: 'Alias for /remotestats', requiresMembership: true },
  { command: '/hlsf', description: 'Render HLSF visualization', requiresMembership: true },
  { command: '/visualize', description: 'Alias for /hlsf', requiresMembership: true },
  { command: '/scheme', description: 'Toggle visual theme', requiresMembership: true },
  { command: '/spin', description: 'Toggle emergent rotation', requiresMembership: true },
  { command: '/omega', description: 'Adjust rotation omega', requiresMembership: true },
  { command: '/alpha', description: 'Adjust alpha transparency', requiresMembership: true },
  { command: '/symbols', description: 'Symbol tokenization controls', requiresMembership: true },
  { command: '/agent', description: 'Toggle autonomous agent loop', requiresMembership: true },
  { command: '/self', description: 'Display engine self state', requiresMembership: true },
  { command: '/state', description: 'Inspect runtime state snapshot', requiresMembership: true },
  { command: '/maphidden', description: 'Reveal hidden adjacency tokens', requiresMembership: true },
  { command: '/hidden', description: 'Alias for /maphidden', requiresMembership: true },
  { command: '/signup', description: 'Create a SaaS profile', requiresMembership: true },
  { command: '/switchuser', description: 'Switch active SaaS profile', requiresMembership: true },
  { command: '/plan', description: 'View subscription and credits', requiresMembership: true },
  { command: '/topup', description: 'Purchase additional credits', requiresMembership: true },
  { command: '/userlist', description: 'List SaaS user profiles', requiresMembership: true },
  { command: '/message', description: 'Send encrypted SaaS message', requiresMembership: true },
  { command: '/inbox', description: 'Show encrypted inbox entries', requiresMembership: true },
  { command: '/decryptmsg', description: 'Decrypt inbox message', requiresMembership: true },
];

const DEMO_UNLOCKED_COMMANDS = new Set([
  '/hlsf',
  '/visualize',
  '/clear',
  '/reset',
  '/stats',
  '/database',
  '/db',
  '/self',
]);

const COMMAND_RESTRICTIONS: Partial<Record<MembershipLevel, Set<string>>> = {
  [MEMBERSHIP_LEVELS.DEMO]: new Set(
    COMMAND_HELP_ENTRIES
      .filter(entry => {
        if (!entry.requiresMembership) return false;
        const normalized = entry.command.toLowerCase();
        return !DEMO_UNLOCKED_COMMANDS.has(normalized);
      })
      .map(entry => entry.command.toLowerCase()),
  ),
};

function ensureCommandAvailable(command: string): boolean {
  const normalized = typeof command === 'string' ? command.trim().toLowerCase() : '';
  if (!normalized || !normalized.startsWith('/')) return true;

  const restrictions = COMMAND_RESTRICTIONS[getMembershipLevel()];
  if (!restrictions || !restrictions.has(normalized)) return true;

  const entry = COMMAND_HELP_ENTRIES.find(item => item.command.toLowerCase() === normalized);
  const label = entry?.command || command;
  const level = getMembershipLevel();

  if (level === MEMBERSHIP_LEVELS.DEMO) {
    const safeLabel = sanitize(label);
    const safeDescription = entry?.description ? sanitize(entry.description) : '';
    addLog(
      `
        <div class="command-locked">
          🔒 ${safeLabel}${safeDescription ? ` <span class="command-locked__desc">${safeDescription}</span>` : ''}
          <div class="command-locked__cta"><a href="#" class="command-upgrade-link" data-upgrade="trial">Start trial</a> to unlock advanced slash commands.</div>
        </div>
      `,
      'warning',
    );
  } else {
    const description = entry?.description ? ` – ${entry.description}` : '';
    logWarning(`${label}${description} is not available for the current membership level.`);
  }

  return false;
}

type ProcessingStatus = {
  isActive?: () => boolean;
  update?: (info: Record<string, unknown>) => void;
  fail?: (summary?: string) => void;
  cancel?: (summary?: string) => void;
  complete?: (info?: Record<string, unknown>) => void;
} | null;

const state = {
  membership: {
    level: MEMBERSHIP_LEVELS.DEMO,
    plan: 'demo',
    trial: false,
    demoMode: 'api',
    name: '',
    email: '',
  },
  focusTokens: [] as string[],
  tokens: new Set<string>(),
  tokenSources: new Map<string, any>(),
  tokenOrder: [] as string[],
  documentCacheBaseline: 0,
  documentCacheBaselineManuallyCleared: false,
  lastComputedCacheBase: 0,
  hlsfReady: false,
  liveGraphMode: false,
  liveGraphUpdateTimer: null as ReturnType<typeof setTimeout> | null,
  liveGraph: { nodes: new Map<string, any>(), links: [] as Array<any> },
  pendingPromptReviews: new Map<string, any>(),
  sessionStats: { totalApiCalls: 0, totalCacheHits: 0, totalCostUsd: 0 },
  networkOffline: false,
  lastNetworkErrorTime: 0,
  networkErrorNotified: false,
  symbolMetrics: null as null | {
    history: unknown[];
    last: unknown;
    lastRunGraph: unknown;
    topNodes: unknown[];
    lastTokens: unknown[];
    lastPipeline: unknown;
  },
  apiKey: '',
  processingStatus: null as ProcessingStatus,
  processingStart: 0,
  processingAverageMs: 0,
  processingSamples: 0,
  isProcessing: false,
};

function getMembershipLevel(): MembershipLevel {
  const rawLevel = typeof state?.membership?.level === 'string'
    ? state.membership.level.toLowerCase()
    : '';
  if (rawLevel === MEMBERSHIP_LEVELS.MEMBER) {
    return MEMBERSHIP_LEVELS.MEMBER;
  }
  return MEMBERSHIP_LEVELS.DEMO;
}

function applyMembershipUi(): void {
  const level = getMembershipLevel();
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('membership-member', level === MEMBERSHIP_LEVELS.MEMBER);
    document.body.classList.toggle('membership-demo', level !== MEMBERSHIP_LEVELS.MEMBER);
    document.body.setAttribute('data-membership', level);
  }
  if (typeof window !== 'undefined') {
    const root = (window as any).CognitionEngine || ((window as any).CognitionEngine = {});
    const current = (state && typeof state === 'object' && state.membership)
      ? state.membership
      : {};
    root.membership = { ...current, level };
  }
}

const METRIC_SCOPE = { RUN: 'run', DB: 'db' };
const DATABASE_READY_EVENT = 'hlsf:database-ready';

const databaseReadyState = {
  lastReason: '',
  lastTokenCount: -1,
  lastTimestamp: 0,
};

function announceDatabaseReady(reason: string): void {
  if (typeof window === 'undefined') return;

  const normalizedReason = typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : 'ready';
  const now = Date.now();
  const db = getDb();
  const dbTokenCount = Array.isArray(db?.full_token_data)
    ? db.full_token_data.length
    : null;
  const cachedTokenCountRaw = getCachedTokenCount();
  const cachedTokenCount = Number.isFinite(cachedTokenCountRaw)
    ? Number(cachedTokenCountRaw)
    : null;

  const detail = {
    reason: normalizedReason,
    timestamp: now,
    isoTimestamp: new Date(now).toISOString(),
    tokens: {
      database: dbTokenCount,
      cached: cachedTokenCount,
    },
  } as const;

  const messageParts: string[] = [];
  if (typeof dbTokenCount === 'number' && Number.isFinite(dbTokenCount)) {
    messageParts.push(`${dbTokenCount} tokens`);
  } else if (typeof cachedTokenCount === 'number' && Number.isFinite(cachedTokenCount)) {
    messageParts.push(`${cachedTokenCount} cached tokens`);
  }
  messageParts.push(`source: ${normalizedReason}`);

  const rootEngine = (window as any).CognitionEngine || ((window as any).CognitionEngine = {});
  const previousState = (rootEngine.database && typeof rootEngine.database === 'object')
    ? rootEngine.database
    : {};
  rootEngine.database = {
    ...previousState,
    ready: true,
    reason: normalizedReason,
    lastReadyAt: detail.isoTimestamp,
    tokens: detail.tokens,
  };

  const nextTokenCount = typeof dbTokenCount === 'number'
    ? dbTokenCount
    : (typeof cachedTokenCount === 'number' ? cachedTokenCount : -1);
  if (databaseReadyState.lastReason !== normalizedReason
    || databaseReadyState.lastTokenCount !== nextTokenCount) {
    const logOk = (window as any).logOK;
    if (typeof logOk === 'function') {
      logOk(`HLSF database ready (${messageParts.join(', ')})`);
    }
  }

  if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(DATABASE_READY_EVENT, { detail }));
    } catch (err) {
      console.warn('Failed to dispatch database ready event:', err);
    }
  }

  databaseReadyState.lastReason = normalizedReason;
  databaseReadyState.lastTokenCount = nextTokenCount;
  databaseReadyState.lastTimestamp = now;

  if (typeof document !== 'undefined' && document.body) {
    document.body.setAttribute('data-hlsf-db', 'ready');
  }

  window.HLSF = window.HLSF || {};
  window.HLSF.databaseReady = detail;
}

const GLOBAL_CONNECTION_RELATION = '∼';
const GLOBAL_CONNECTION_WEIGHT = 0.05;

const DEFAULT_LIVE_TOKEN_CAP = 160;
const DEFAULT_LIVE_EDGE_WEIGHT_MIN = 0.02;
const DEFAULT_LOCAL_MEMORY_EDGE_WEIGHT_MIN = 0.02;
const DEFAULT_HLSF_RELATIONSHIP_LIMIT = 1000;

const SYNTHETIC_BRANCH_CACHE: Map<string, Array<{ token: string; weight: number }>> = new Map();

// Canonical 50-type display names
const REL_EN = {
  "≡":"Identity","⊃":"Contains","⊂":"Is Contained By","≈":"Variant","∈":"Is Instance Of","∋":"Has Instance",
  "⊤":"Is Type Of","⊥":"Has Type","⊏":"Part Of","⊐":"Composes","↔":"Mirrors","⇌":"Inverts","∥":"Parallel To",
  "∼":"Adjacent To","→":"Next","⇒":"Sequence Of","⇐":"Preceded By","↠":"Follows","↗":"Spatially Above","↘":"Spatially Below",
  "↝":"Symbolically Supports","↧":"Symbolically Depends","≠":"Contrasts","⊕":"Complements","⊛":"Associated With","∝":"Correlates With",
  "⇝":"Causes","↼":"Caused By","*":"Evokes","≜":"Represents","★":"Symbolizes","↦":"Refers To","⊢":"Defines","⊣":"Is Defined By",
  "↷":"Transforms To","↶":"Transformed From","∘":"Functions As","⊨":"Interpreted As","◁":"Used With","⇄":"Co-occurs With",
  "⊗":"Synthesizes","÷":"Divides Into","⊘":"Opposes","↳":"Leads To","↲":"Results In","⟂":"Orthogonal To","≉":"Diverges From",
  "≍":"Equivalent In Form","≓":"Approximately Equals","≔":"Defined As","⊚":"Hidden Adjacency"
};

// Return "∼ Adjacent To"
const relDisplay = k => `${k} ${REL_EN[k] ?? ''}`.trim();

const RELKEY_ALIASES = (() => {
  const map = new Map();
  for (const [glyph, name] of Object.entries(REL_EN)) {
    map.set(`${glyph} ${name}`, glyph);
    map.set(name, glyph);
    map.set(name.toLowerCase(), glyph);
  }
  map.set('∗', '*');
  map.set('*', '*');
  map.set('⋆', '*');
  return map;
})();

const EDGE_LABEL_DENSITY_THRESHOLD = 160;

function paletteColor(relKey: string | null | undefined): string {
  const normalizedKey = typeof relKey === 'string' && relKey
    ? normRelKey(relKey) || relKey
    : '';
  if (!normalizedKey) {
    return '#00ff88';
  }
  if (relationColorCache.has(normalizedKey)) {
    return relationColorCache.get(normalizedKey) as string;
  }
  let hash = 0;
  for (let i = 0; i < normalizedKey.length; i += 1) {
    hash = ((hash << 5) - hash) + normalizedKey.charCodeAt(i);
    hash |= 0; // force 32-bit integer
  }
  const hue = Math.abs(hash) % 360;
  const saturation = 55 + (Math.abs(hash >> 3) % 35);
  const lightness = 45 + (Math.abs(hash >> 5) % 20);
  const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  relationColorCache.set(normalizedKey, color);
  return color;
}

function colorWithAlpha(color: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  if (!color) {
    return `rgba(255, 255, 255, ${clamped})`;
  }
  if (/^#([0-9a-f]{3})$/i.test(color)) {
    const [, hex] = color.match(/^#([0-9a-f]{3})$/i) || [];
    if (hex) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      return `rgba(${r}, ${g}, ${b}, ${clamped})`;
    }
  }
  if (/^#([0-9a-f]{6})$/i.test(color)) {
    const [, hex] = color.match(/^#([0-9a-f]{6})$/i) || [];
    if (hex) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${clamped})`;
    }
  }
  if (color.startsWith('rgba(')) {
    return color.replace(/rgba\(([^)]+)\)/, (_, values) => {
      const parts = values.split(',').slice(0, 3).map(part => part.trim());
      return `rgba(${parts.join(', ')}, ${clamped})`;
    });
  }
  if (color.startsWith('rgb(')) {
    return color.replace(/rgb\(([^)]+)\)/, (_, values) => `rgba(${values}, ${clamped})`);
  }
  if (color.startsWith('hsla(')) {
    return color.replace(/hsla\(([^)]+)\)/, (_, values) => {
      const parts = values.split(',').slice(0, 3).map(part => part.trim());
      return `hsla(${parts.join(', ')}, ${clamped})`;
    });
  }
  if (color.startsWith('hsl(')) {
    return color.replace(/hsl\(([^)]+)\)/, (_, values) => `hsla(${values}, ${clamped})`);
  }
  return color;
}

function resolveEdgeRelationDescriptor(edge) {
  if (!edge || typeof edge !== 'object') return null;
  const rawRtype = typeof edge.rtype === 'string' ? edge.rtype.trim() : '';
  const rawRelationship = typeof edge.relationship === 'string' ? edge.relationship.trim() : '';
  const rawType = typeof edge.type === 'string' ? edge.type.trim() : '';
  const glyph = normRelKey(rawRtype) || normRelKey(rawRelationship) || normRelKey(rawType);
  if (!glyph) return null;
  const english = REL_EN[glyph] || '';
  const label = english ? `${glyph} ${english}` : glyph;
  if (!label) return null;
  return {
    glyph,
    english,
    label,
  };
}

function renderEdgeRelationLabels(ctx, entries, options) {
  if (!Array.isArray(entries) || !entries.length) return;
  const theme = options?.theme || { fg: '#fff', bg: '#000' };
  const fontScale = Math.max(0.35, Math.min(3, Number(options?.fontScale) || 1));
  const baseAlphaValue = Math.max(0.1, Math.min(0.99, Number(options?.alpha) || 0.6));
  const fontSize = Math.max(9, Math.round(10 * fontScale));

  ctx.save();
  ctx.font = `${fontSize}px 'Fira Code', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const entry of entries) {
    if (!entry || !entry.label || !entry.from || !entry.to) continue;
    const dx = entry.to.x - entry.from.x;
    const dy = entry.to.y - entry.from.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length < fontSize * 1.8) continue;

    const midX = entry.from.x + dx / 2;
    const midY = entry.from.y + dy / 2;
    ctx.save();
    const angle = Math.atan2(dy, dx);
    ctx.translate(midX, midY);
    ctx.rotate(angle);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) ctx.rotate(Math.PI);

    const metrics = ctx.measureText(entry.label);
    const textWidth = metrics.width || entry.label.length * fontSize * 0.6;
    if (!Number.isFinite(textWidth) || textWidth > length * 0.92) {
      ctx.restore();
      continue;
    }

    const focusAlpha = Math.min(0.85, baseAlphaValue * 0.95);
    const defaultAlpha = Math.min(0.6, baseAlphaValue * 0.7);
    const colorSource = entry.relKey ? paletteColor(entry.relKey) : theme.fg;
    const color = colorWithAlpha(colorSource, entry.focus ? focusAlpha : defaultAlpha);

    ctx.fillStyle = color;
    ctx.fillText(entry.label, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}

const BatchLog = (() => {
  const buf = [];
  let lastFlush = 0;
  let ui = null;
  let bar = null;
  const max = 5000;
  const loggingEnabled = () => window.HLSF?.config?.batchLogging !== false;

  function mount() {
    ui = document.getElementById('hlsf-log-stream');
    bar = document.getElementById('hlsf-log-bar');
  }

  function push(ev) {
    if (!loggingEnabled()) return;
    const t = performance.now();
    buf.push({ t, ...ev });
    if (buf.length > max) buf.shift();
    flush(120);
  }

  function phase(name, evt = 'mark', meta) {
    push({ phase: name, evt, meta });
  }

  function progress(done, total) {
    if (!bar) return;
    if (!loggingEnabled()) {
      bar.style.width = '0%';
      return;
    }
    const pct = Math.floor((100 * done) / Math.max(1, total));
    bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }

  function flush(ms = 120) {
    if (!loggingEnabled()) return;
    const now = performance.now();
    if (!ui || now - lastFlush < ms) return;
    lastFlush = now;
    const tail = buf.slice(-200).map(e => {
      const dt = (e.t / 1000).toFixed(3);
      const tag = e.phase ? `[${e.phase}:${e.evt || 'mark'}]` : '';
      const meta = e.meta ? ` ${JSON.stringify(e.meta)}` : '';
      const msg = e.msg ? ` ${e.msg}` : '';
      return `${dt} ${tag}${msg}${meta}`.trimEnd();
    }).join('\n');
    ui.textContent = tail;
  }

  function toJSON() {
    return JSON.stringify(buf);
  }

  function clear() {
    buf.length = 0;
    lastFlush = 0;
    if (ui) ui.textContent = '';
    if (bar) bar.style.width = '0%';
  }

  function download() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toJSON()], { type: 'application/json' }));
    a.download = `hlsf_batch_log_${Date.now()}.json`;
    a.click();
  }

  window.addEventListener('load', () => {
    mount();
    document.getElementById('hlsf-log-download')?.addEventListener('click', download);
  });

  return { push, phase, progress, flush, clear, toJSON, mount };
})();

const HlsfLoading = (() => {
  let panel = null;
  let bar = null;
  let label = null;
  let detail = null;
  let hideTimer = null;
  const defaultDetail = 'This can take a few seconds for large datasets.';

  function resolve(id) {
    const el = document.getElementById(id);
    return el || null;
  }

  function ensure() {
    if (!panel || !panel.isConnected) panel = resolve('hlsf-loading-panel');
    if (!bar || !bar.isConnected) bar = resolve('hlsf-loading-progress');
    if (!label || !label.isConnected) label = resolve('hlsf-loading-label');
    if (!detail || !detail.isConnected) detail = resolve('hlsf-loading-detail');
    return panel && bar;
  }

  function reveal() {
    if (!ensure()) return false;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    return true;
  }

  function show(message = 'Preparing HLSF visualization…', info = defaultDetail) {
    if (!reveal()) return;
    if (label) label.textContent = message;
    if (detail) detail.textContent = info;
    if (bar) bar.style.width = '0%';
  }

  function update(message, info) {
    if (!reveal()) return;
    if (message && label) label.textContent = message;
    if (detail) detail.textContent = info || detail.textContent || defaultDetail;
  }

  function progress(done, total) {
    if (!reveal()) return;
    const pct = total > 0 ? Math.round(Math.max(0, Math.min(100, (done / total) * 100))) : 0;
    if (bar) bar.style.width = `${pct}%`;
    if (detail) detail.textContent = `Building semantic map… ${pct}%`;
    if (pct >= 100) hide(250);
  }

  function hide(delay = 200) {
    if (!ensure()) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!ensure()) return;
      panel.classList.add('hidden');
      panel.setAttribute('aria-hidden', 'true');
      if (bar) bar.style.width = '0%';
      if (detail) detail.textContent = defaultDetail;
    }, Math.max(0, delay));
  }

  return { show, update, progress, hide };
})();

function normRelKey(k) {
  const cleaned = (k || '').trim();
  if (!cleaned) return null;
  if (REL_EN[cleaned]) return cleaned;
  const normalized = cleaned.replace(/\s+/g, ' ');
  const alias = RELKEY_ALIASES.get(normalized)
    || RELKEY_ALIASES.get(normalized.toLowerCase())
    || RELKEY_ALIASES.get(normalized.split(' ')[0]);
  return REL_EN[alias] ? alias : null;
}

function normalizeRelKeyForStats(k){
  const g = normRelKey(k);
  return REL_EN[g] ? g : null;
}

function renderRelTypeRow(glyph, count){
  return `${relDisplay(glyph)}: ${count} instances`;
}

function resolveVisualizerElements() {
  if (typeof document === 'undefined') {
    return { container: null, canvas: null, overlay: null, emptyState: null };
  }

  const container = document.getElementById('hlsf-canvas-container');
  const canvas = document.getElementById('hlsf-canvas');
  const overlay = document.getElementById('hlsf-overlay');
  const emptyState = document.getElementById('hlsf-empty-state');

  return {
    container: container instanceof HTMLElement ? container : null,
    canvas: canvas instanceof HTMLElement ? canvas : null,
    overlay: overlay instanceof HTMLElement ? overlay : null,
    emptyState: emptyState instanceof HTMLElement ? emptyState : null,
  };
}

function ensureHLSFCanvas(): HTMLCanvasElement | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  const existingCanvas = window.HLSF?.canvas;
  if (existingCanvas instanceof HTMLCanvasElement) {
    return existingCanvas;
  }

  const { container, canvas } = resolveVisualizerElements();
  let targetCanvas: HTMLCanvasElement | null = null;

  if (canvas instanceof HTMLCanvasElement) {
    targetCanvas = canvas;
  } else if (container instanceof HTMLElement) {
    targetCanvas = document.createElement('canvas');
    targetCanvas.id = 'hlsf-canvas';
    targetCanvas.setAttribute('aria-hidden', 'true');
    const overlay = container.querySelector('#hlsf-overlay');
    if (overlay instanceof HTMLElement) {
      container.insertBefore(targetCanvas, overlay);
    } else {
      container.appendChild(targetCanvas);
    }
  }

  if (!(targetCanvas instanceof HTMLCanvasElement)) {
    return null;
  }

  const bounds = (container instanceof HTMLElement)
    ? container.getBoundingClientRect()
    : targetCanvas.getBoundingClientRect();
  const resolvedWidth = Math.max(1, Math.round(bounds.width || targetCanvas.clientWidth || targetCanvas.width || 0));
  const resolvedHeight = Math.max(1, Math.round(bounds.height || targetCanvas.clientHeight || targetCanvas.height || 0));

  if (!targetCanvas.width || Math.abs(targetCanvas.width - resolvedWidth) > 2) {
    targetCanvas.width = resolvedWidth || 1200;
  }
  if (!targetCanvas.height || Math.abs(targetCanvas.height - resolvedHeight) > 2) {
    targetCanvas.height = resolvedHeight || 600;
  }

  window.HLSF = window.HLSF || {};
  window.HLSF.canvas = targetCanvas;
  const ctx = targetCanvas.getContext('2d');
  window.HLSF.ctx = ctx || null;

  return targetCanvas;
}

function showVisualizer(): void {
  const { container, canvas, overlay, emptyState } = resolveVisualizerElements();

  if (container) {
    container.setAttribute('data-hlsf-visualizer', 'visible');
  }

  if (canvas) {
    canvas.classList.remove('hidden');
    canvas.setAttribute('aria-hidden', 'false');
  }

  if (overlay) {
    overlay.classList.remove('hidden');
  }

  if (emptyState) {
    emptyState.classList.add('hidden');
    emptyState.setAttribute('aria-hidden', 'true');
  }

  if (typeof document !== 'undefined' && document.body) {
    document.body.setAttribute('data-hlsf-visualizer', 'visible');
  }
}

function hideVisualizer(): void {
  const { container, canvas, overlay, emptyState } = resolveVisualizerElements();

  if (canvas) {
    canvas.classList.add('hidden');
    canvas.setAttribute('aria-hidden', 'true');
  }

  if (overlay) {
    overlay.classList.add('hidden');
  }

  if (container) {
    container.setAttribute('data-hlsf-visualizer', 'hidden');
  }

  if (emptyState) {
    emptyState.classList.remove('hidden');
    emptyState.setAttribute('aria-hidden', 'false');
  }

  if (typeof document !== 'undefined' && document.body) {
    document.body.setAttribute('data-hlsf-visualizer', 'hidden');
  }
}

// ---------------- HLSF matrix builder ----------------
function buildMatrixForRecord(rec) {
  const edges = [];
  const rels = rec?.relationships || {};
  const keys = Object.keys(rels);
  for (const rawKey of keys) {
    const key = normRelKey(rawKey);
    if (!key) continue;
    const arr = Array.isArray(rels[rawKey]) ? rels[rawKey] : [];
    const items = arr
      .filter(x => x && typeof x.weight === 'number')
      .sort((a, b) => b.weight - a.weight);
    if (!items.length) continue;
    const agg = {
      rtype: key,
      aggWeight: items[0].weight,
      sizeWeight: items.reduce((s, x) => s + x.weight, 0),
      count: items.length,
      items
    };
    edges.push(agg);
  }
  const freq = typeof rec?.f === 'number'
    ? rec.f
    : typeof rec?.frequency === 'number'
      ? rec.frequency
      : typeof rec?.freq === 'number'
        ? rec.freq
        : 1;
  return { token: rec?.token || '', edges, f: freq };
}

function buildHLSFMatrices(db) {
  const raw = db?.full_token_data || [];
  const matrices = new Map();
  const freqs = [];
  for (const rec of raw) {
    const matrix = buildMatrixForRecord(rec);
    matrices.set(matrix.token, matrix);
    if (typeof matrix.f === 'number') freqs.push(matrix.f);
  }

  freqs.sort((a, b) => a - b);
  const freqStats = freqs.length
    ? {
        min: freqs[0],
        max: freqs[freqs.length - 1],
        p90: freqs[Math.max(0, Math.floor(freqs.length * 0.9) - 1)]
      }
    : { min: 0, max: 1, p90: 1 };

  window.HLSF = window.HLSF || {};
  window.HLSF.matrices = matrices;
  window.HLSF.metrics = Object.assign({}, window.HLSF.metrics, { freqStats });

  return matrices;
}

function parseHlsfArgs(str) {
  const out = { mode: 'full', tokens: [], glyphs: [], depth: CONFIG.ADJACENCY_RECURSION_DEPTH };
  const s = (str || '').trim();
  if (!s) return out;
  if (/^--conversation$/i.test(s)) { out.mode = 'conversation'; return out; }
  const m = s.match(/^--\[(.*)\]$/s);
  if (!m) return out;
  const parts = m[1].split(/\s*,\s*/).filter(Boolean);
  for (const p of parts) {
    const kv = p.split(/\s*=\s*/);
    if (kv.length === 2 && /^recursionDepth$/i.test(kv[0])) {
      out.depth = Math.max(0, parseFloat(kv[1]) || 0);
      continue;
    }
    if (/^[\u2200-\u2BFF\u{1F300}-\u{1FAFF}]+$/u.test(p)) out.glyphs.push(p);
    else out.tokens.push(p);
  }
  out.mode = out.glyphs.length ? 'glyphs' : 'tokens';
  return out;
}

function extractHlsfFlags(str) {
  const raw = (str || '').trim();
  if (!raw) return { text: '', flags: {} };

  const parts = raw.split(/\s+/);
  const remain = [];
  const flags = {};

  const parseValue = (part, index) => {
    const eqIdx = part.indexOf('=');
    if (eqIdx >= 0) return part.slice(eqIdx + 1);
    if (index + 1 < parts.length) return parts[index + 1];
    return '';
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lower = part.toLowerCase();

    if (lower === '--nolog') { flags.batchLogging = false; continue; }
    if (lower === '--nowait') { flags.deferredRender = false; continue; }
    if (lower === '-db') { flags.metricScope = METRIC_SCOPE.DB; continue; }
    if (lower === '-run') { flags.metricScope = METRIC_SCOPE.RUN; continue; }

    if (lower.startsWith('--scope')) {
      const value = parseValue(part, i).toLowerCase();
      if (!part.includes('=')) i += 1;
      if (value === METRIC_SCOPE.DB) flags.metricScope = METRIC_SCOPE.DB;
      else if (value === METRIC_SCOPE.RUN) flags.metricScope = METRIC_SCOPE.RUN;
      continue;
    }

    if (lower.startsWith('--depth')) {
      const value = parseValue(part, i);
      if (!part.includes('=')) i += 1;
      const depth = parseFloat(value);
      if (Number.isFinite(depth)) flags.depth = depth;
      continue;
    }

    if (lower.startsWith('--types')) {
      const value = parseValue(part, i);
      if (!part.includes('=')) i += 1;
      const valLower = typeof value === 'string' ? value.toLowerCase() : '';
      if (valLower === 'all' || valLower === 'infinity' || valLower === 'inf' || valLower === '∞') {
        flags.relationTypeCap = Infinity;
      } else {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) flags.relationTypeCap = n;
      }
      continue;
    }

    if (lower.startsWith('--ept')) {
      const value = parseValue(part, i);
      if (!part.includes('=')) i += 1;
      const valLower = typeof value === 'string' ? value.toLowerCase() : '';
      if (valLower === 'all' || valLower === 'infinity' || valLower === 'inf' || valLower === '∞') {
        flags.edgesPerType = Infinity;
      } else {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) flags.edgesPerType = n;
      }
      continue;
    }

    remain.push(part);
  }

  const text = remain.join(' ').trim();
  return { text, flags };
}

function buildIndex(db) {
  const idx = new Map();
  (db?.full_token_data || []).forEach(rec => {
    if (rec?.token) idx.set(rec.token, rec);
  });
  return idx;
}

interface GlyphMapsSnapshot {
  tokenToGlyph: Map<string, string>;
  glyphToToken: Map<string, Set<string>>;
}

function recordGlyphMapping(token: string, glyph: string): void {
  if (!token || !glyph) return;
  const trimmed = token.trim();
  if (!trimmed) return;
  const normalized = trimmed.toLowerCase();
  TokenToGlyph.set(normalized, glyph);
  if (!GlyphToToken.has(glyph)) {
    GlyphToToken.set(glyph, new Set());
  }
  GlyphToToken.get(glyph)?.add(trimmed);
}

function hydrateGlyphMappingsFromLedger(ledger: unknown): number {
  if (!ledger || typeof ledger !== 'object') return 0;
  const glyphMap = (ledger as Record<string, any>).glyph_map
    || (ledger as Record<string, any>).glyphMap
    || ledger;
  if (!glyphMap || typeof glyphMap !== 'object') return 0;
  let count = 0;
  for (const [glyph, entries] of Object.entries(glyphMap)) {
    if (!glyph) continue;
    const list = Array.isArray(entries) ? entries : [];
    for (const entry of list) {
      const tokenValue = typeof entry === 'string'
        ? entry
        : typeof entry?.token === 'string'
          ? entry.token
          : '';
      const trimmed = typeof tokenValue === 'string' ? tokenValue.trim() : '';
      if (!trimmed) continue;
      recordGlyphMapping(trimmed, glyph);
      count += 1;
    }
  }
  return count;
}

function loadGlyphMaps(db: any = null): GlyphMapsSnapshot | null {
  try {
    const sourceDb = db || getDb();
    if (!sourceDb) {
      return null;
    }

    if (typeof window !== 'undefined') {
      const runtime = (window.HLSF = window.HLSF || {});
      if (runtime.glyphMapsSource === sourceDb && runtime.glyphMaps) {
        return runtime.glyphMaps as GlyphMapsSnapshot;
      }
    }

    TokenToGlyph.clear();
    GlyphToToken.clear();

    let hydrated = 0;

    const ledgerHydrated = hydrateGlyphMappingsFromLedger((sourceDb as any).glyph_ledger);
    hydrated += ledgerHydrated;
    if (hydrated === 0) {
      hydrated += hydrateGlyphMappingsFromLedger((sourceDb as any).glyph_map);
    }

    const records = Array.isArray(sourceDb?.full_token_data)
      ? sourceDb.full_token_data
      : [];

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const rawToken = typeof record.token === 'string' ? record.token.trim() : '';
      if (!rawToken) continue;
      const normalized = rawToken.toLowerCase();
      if (TokenToGlyph.has(normalized)) continue;
      const glyphCandidate = typeof record.glyph === 'string' && record.glyph.trim()
        ? record.glyph.trim()
        : null;
      let glyph = glyphCandidate;
      if (!glyph) {
        try {
          const complex = memoizedComplexNumber(rawToken, record);
          glyph = complexToGlyph(complex);
        } catch (err) {
          console.warn('Failed to derive glyph for token:', rawToken, err);
          glyph = null;
        }
      }
      if (!glyph) continue;
      recordGlyphMapping(rawToken, glyph);
      hydrated += 1;
    }

    const snapshot: GlyphMapsSnapshot = {
      tokenToGlyph: new Map(TokenToGlyph),
      glyphToToken: new Map(
        Array.from(GlyphToToken.entries()).map(([glyph, tokens]) => [glyph, new Set(tokens)]),
      ),
    };

    if (typeof window !== 'undefined') {
      const runtime = (window.HLSF = window.HLSF || {});
      runtime.glyphMaps = snapshot;
      runtime.glyphMapsSource = sourceDb;
      runtime.glyphMapCount = hydrated;
    }

    return snapshot;
  } catch (err) {
    console.warn('loadGlyphMaps failed:', err);
    return null;
  }
}

async function loadOrGetIndex() {
  const db = getDb();
  if (!db) throw new Error('No DB loaded');
  if (window.HLSF.indexCache && window.HLSF.indexCacheSource === window.HLSF.dbCache) {
    return window.HLSF.indexCache;
  }
  loadGlyphMaps(db);
  const idx = buildIndex(db);
  window.HLSF.indexCache = idx;
  window.HLSF.indexCacheSource = window.HLSF.dbCache;
  return idx;
}

function getAnchorCap(idx) {
  const configuredCap = Number(window.HLSF?.config?.fullAnchorCap);
  if (Number.isFinite(configuredCap) && configuredCap > 0) {
    const size = idx instanceof Map ? idx.size : configuredCap;
    return Math.min(configuredCap, size);
  }
  return idx instanceof Map ? idx.size : 0;
}

function adjacencyStats(rec) {
  let relTypes = 0;
  let edges = 0;
  for (const arr of Object.values(rec?.relationships || {})) {
    if (Array.isArray(arr) && arr.length) {
      relTypes += 1;
      edges += arr.length;
    }
  }
  return { relTypes, edges };
}

function defaultAnchors(idx, k = 64) {
  const recs = Array.from(idx.values());
  recs.sort((a, b) => {
    const A = adjacencyStats(a);
    const B = adjacencyStats(b);
    return (B.edges - A.edges) || (B.relTypes - A.relTypes);
  });
  return recs.slice(0, k).map(r => r.token);
}

function applyConversationOverlay(index) {
  if (!(index instanceof Map)) {
    return { index, focusTokens: [] };
  }

  const memory = ensureLocalHlsfMemory();
  if (!memory) {
    return { index, focusTokens: [] };
  }

  const idxLower = new Map();
  for (const key of index.keys()) {
    if (typeof key !== 'string') continue;
    idxLower.set(key.toLowerCase(), key);
  }

  const seen = new Set();
  const focusTokens = [];
  const pushToken = (candidate) => {
    if (typeof candidate !== 'string') return;
    const trimmed = candidate.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    const resolved = index.has(trimmed)
      ? trimmed
      : idxLower.get(lower) || null;
    if (!resolved) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    focusTokens.push(resolved);
  };

  const recentPrompts = Array.isArray(memory.prompts) ? memory.prompts.slice(-3) : [];

  if (Array.isArray(memory.lastPrompt?.tokens)) {
    memory.lastPrompt.tokens.forEach(pushToken);
  }
  if (Array.isArray(memory.lastPrompt?.adjacencySeeds)) {
    memory.lastPrompt.adjacencySeeds.forEach(pushToken);
  }
  if (Array.isArray(memory.lastAdjacency?.summary)) {
    memory.lastAdjacency.summary.forEach(entry => pushToken(entry?.token));
  }

  for (let i = recentPrompts.length - 1; i >= 0 && focusTokens.length < 24; i--) {
    const entry = recentPrompts[i];
    if (!entry) continue;
    if (Array.isArray(entry.tokens)) entry.tokens.forEach(pushToken);
    if (Array.isArray(entry.adjacencySeeds)) entry.adjacencySeeds.forEach(pushToken);
  }

  return { index, focusTokens };
}

async function anchorsForMode(args, index) {
  const overlay = applyConversationOverlay(index);
  const effectiveIndex = overlay.index instanceof Map ? overlay.index : index;
  const idx = effectiveIndex instanceof Map ? effectiveIndex : null;

  const focusFromOverlay = Array.isArray(overlay.focusTokens) ? overlay.focusTokens : [];
  if (!idx) {
    return {
      anchors: [],
      idx: effectiveIndex,
      glyphOnly: args?.mode === 'glyphs',
      focusTokens: focusFromOverlay,
    };
  }

  const idxLower = new Map();
  for (const key of idx.keys()) {
    if (typeof key !== 'string') continue;
    idxLower.set(key.toLowerCase(), key);
  }

  const resolveToken = (candidate) => {
    if (typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    if (idx.has(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    if (idxLower.has(lower)) return idxLower.get(lower);
    const record = idx.get(trimmed);
    if (record && typeof record.token === 'string' && idx.has(record.token)) {
      return record.token;
    }
    return null;
  };

  const anchorCap = getAnchorCap(idx) || 0;
  const seenAnchors = new Set();
  let anchors = [];
  const missingTokens = [];
  const addAnchor = (candidate, trackMissing = false) => {
    const resolved = resolveToken(candidate);
    if (!resolved) {
      if (trackMissing && typeof candidate === 'string') {
        missingTokens.push(candidate.trim());
      }
      return;
    }
    const key = resolved.toLowerCase();
    if (seenAnchors.has(key)) return;
    seenAnchors.add(key);
    anchors.push(resolved);
  };

  if (args?.mode === 'tokens' && Array.isArray(args.tokens)) {
    for (const token of args.tokens) addAnchor(token, true);
  } else if (args?.mode === 'glyphs' && Array.isArray(args.glyphs)) {
    loadLedger();
    for (const glyph of args.glyphs) {
      if (typeof glyph !== 'string' || !glyph.trim()) continue;
      const mapped = GlyphToToken.get(glyph) || new Set();
      if (mapped instanceof Set && mapped.size) {
        for (const token of mapped) {
          addAnchor(token, true);
          if (anchorCap > 0 && anchors.length >= anchorCap) break;
        }
      } else {
        addAnchor(glyph, true);
      }
      if (anchorCap > 0 && anchors.length >= anchorCap) break;
    }
  } else if (args?.mode === 'conversation') {
    for (const token of focusFromOverlay) {
      addAnchor(token, false);
      if (anchorCap > 0 && anchors.length >= anchorCap) break;
    }
  }

  if ((!Array.isArray(anchors) || !anchors.length) && idx instanceof Map) {
    anchors = defaultAnchors(idx, anchorCap > 0 ? anchorCap : undefined);
  }

  if ((!Array.isArray(anchors) || !anchors.length) && idx instanceof Map) {
    const fallback = Array.from(idx.keys());
    anchors = anchorCap > 0 ? fallback.slice(0, anchorCap) : fallback;
  }

  if (anchorCap > 0 && anchors.length > anchorCap) {
    anchors = anchors.slice(0, anchorCap);
  }

  const focusSet = new Set();
  const focusTokens = [];
  const addFocus = (candidate) => {
    const resolved = resolveToken(candidate);
    if (!resolved) return;
    const key = resolved.toLowerCase();
    if (focusSet.has(key)) return;
    focusSet.add(key);
    focusTokens.push(resolved);
  };

  focusFromOverlay.forEach(addFocus);
  if (!focusTokens.length) {
    anchors.slice(0, 12).forEach(addFocus);
  }

  if (missingTokens.length) {
    const missingDisplay = missingTokens
      .filter(Boolean)
      .map(token => token.trim())
      .filter(Boolean);
    if (missingDisplay.length) {
      logWarning(`Some requested tokens were not found in the index: ${missingDisplay.join(', ')}`);
    }
  }

  return {
    anchors,
    idx: effectiveIndex,
    glyphOnly: args?.mode === 'glyphs',
    focusTokens,
  };
}

function signatureFor(rec) {
  const S = { weights: new Map(), neigh: new Set() };
  for (const arr of Object.values(rec?.relationships || {})) {
    if (!Array.isArray(arr)) continue;
    for (const rel of arr) {
      const token = rel?.token;
      if (!token) continue;
      const weight = Number.isFinite(rel?.weight)
        ? rel.weight
        : Number.isFinite(rel?.w)
          ? rel.w
          : 1;
      S.weights.set(token, (S.weights.get(token) || 0) + weight);
      S.neigh.add(token);
    }
  }
  return S;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [token, wa] of a.weights) {
    na += wa * wa;
    const wb = b.weights.get(token) || 0;
    if (wb) dot += wa * wb;
  }
  for (const wb of b.weights.values()) nb += wb * wb;
  const denom = Math.sqrt(na * nb);
  return denom ? dot / denom : 0;
}

function jaccard(a, b) {
  if (!a || !b) return 0;
  const A = a.neigh;
  const B = b.neigh;
  let inter = 0;
  const small = A.size <= B.size ? A : B;
  const big = A.size <= B.size ? B : A;
  for (const x of small) if (big.has(x)) inter += 1;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

function affinity(a, b) {
  return 0.6 * cosine(a, b) + 0.4 * jaccard(a, b);
}

function candidateMap(graph) {
  const nbr = new Map();
  const edges = Array.isArray(graph.links) ? graph.links : Array.isArray(graph.edges) ? graph.edges : [];
  for (const edge of edges) {
    const fromSet = nbr.get(edge.from) || (() => {
      const set = new Set();
      nbr.set(edge.from, set);
      return set;
    })();
    const toSet = nbr.get(edge.to) || (() => {
      const set = new Set();
      nbr.set(edge.to, set);
      return set;
    })();
    fromSet.add(edge.to);
    toSet.add(edge.from);
  }
  for (const [a, set] of nbr) {
    for (const b of [...set]) {
      const second = nbr.get(b) || new Set();
      for (const c of second) {
        if (c !== a) set.add(c);
      }
    }
  }
  return nbr;
}

function clusterByAffinity(graph, index, { thresh = 0.35, iters = 8 } = {}) {
  if (!graph || !index) return 0;
  const sig = new Map();
  for (const [token] of graph.nodes) {
    sig.set(token, signatureFor(index.get(token) || {}));
  }
  const cand = candidateMap(graph);
  for (const token of graph.nodes.keys()) {
    if (!cand.has(token)) cand.set(token, new Set());
  }
  const label = new Map();
  for (const token of graph.nodes.keys()) label.set(token, token);
  const limit = Math.max(1, Math.floor(iters));
  const threshold = Math.max(0, Math.min(1, Number(thresh) || 0));
  for (let i = 0; i < limit; i++) {
    let moved = 0;
    for (const [a, neighbors] of cand) {
      let best = label.get(a);
      let bestScore = 0;
      const scores = new Map();
      for (const b of neighbors) {
        const score = affinity(sig.get(a), sig.get(b));
        if (score < threshold) continue;
        const lbl = label.get(b);
        scores.set(lbl, (scores.get(lbl) || 0) + score);
      }
      for (const [lbl, total] of scores) {
        if (total > bestScore) {
          bestScore = total;
          best = lbl;
        }
      }
      if (best !== label.get(a)) {
        label.set(a, best);
        moved += 1;
      }
    }
    if (!moved) break;
  }
  const ids = [...new Set(label.values())].sort();
  const idMap = new Map(ids.map((k, idx) => [k, idx]));
  for (const [token, node] of graph.nodes) {
    node.cluster = idMap.get(label.get(token));
  }
  return idMap.size;
}

function applyAffinityClusters(graph, index) {
  if (!graph || !index) return 0;
  const config = window.HLSF?.config?.affinity || {};
  const threshold = Number.isFinite(config.threshold) ? config.threshold : 0.35;
  const iterations = Number.isFinite(config.iterations) ? config.iterations : 8;
  const count = clusterByAffinity(graph, index, { thresh: threshold, iters: iterations });
  graph.clusterCount = count;
  return count;
}

function recomputeAndRender() {
  const graph = window.HLSF?.currentGraph;
  const idx = window.HLSF?.lastCommand?.idx;
  if (graph && idx) {
    applyAffinityClusters(graph, idx);
  }
  debouncedLegacyRender();
}

function isAdjacencyExpansionEnabled() {
  return window.HLSF?.config?.showAllAdjacencies === true;
}

function getRelationTypeCap() {
  if (isAdjacencyExpansionEnabled()) return Infinity;
  const raw = window.HLSF?.config?.relationTypeCap;
  if (raw === Infinity) return Infinity;
  return clampRelationTypeCap(raw);
}

function getEdgesPerType() {
  if (isAdjacencyExpansionEnabled()) return Infinity;
  const raw = window.HLSF?.config?.edgesPerType;
  if (raw === Infinity) return Infinity;
  return clampEdgesPerType(raw);
}

async function assembleGraphFromAnchorsLogged(anchorsInput, depthFloat, index, options = {}) {
  const opts = options || {};
  const fallbackAnchors = Array.isArray(options?.anchors) ? options.anchors : undefined;
  const legacySeeds = Array.isArray(options?.seeds) ? options.seeds : undefined;
  const rawAnchors = anchorsInput ?? fallbackAnchors ?? legacySeeds ?? [];
  const lowerIndexMap = buildLowercaseIndexMap(index);
  const resolvedAnchorSet = new Set();
  const resolvedAnchors = [];
  for (const rawAnchor of Array.isArray(rawAnchors) ? rawAnchors : []) {
    const resolved = resolveTokenKey(rawAnchor, index, lowerIndexMap) || rawAnchor;
    if (!resolved || resolvedAnchorSet.has(resolved)) continue;
    resolvedAnchorSet.add(resolved);
    resolvedAnchors.push(resolved);
  }
  const anchorList = resolvedAnchors.length ? resolvedAnchors : (Array.isArray(rawAnchors) ? rawAnchors.slice() : []);
  const graph = { nodes: new Map(), links: [], anchors: anchorList.slice() };
  const outSet = new Set();
  const inSet = new Set();
  let edgeTypeEnums = 0;
  const queue = [];
  let head = 0;
  let expanded = 0;
  let enqueued = 0;
  const tick = Math.max(1, Math.round(Number(window.HLSF?.config?.progressTick) || 250));
  const maxDepth = Math.floor(depthFloat);
  const frac = depthFloat - maxDepth;
  const loggingActive = !opts.silent && window.HLSF?.config?.batchLogging !== false;
  const logPhase = (evt, meta) => { if (loggingActive) BatchLog.phase('graph', evt, meta); };
  const logProgress = (done, total) => {
    if (loggingActive) BatchLog.progress(done, total);
    HlsfLoading.progress(done, total);
  };
  const seenTriple = new Set();
  const visitedSrc = new Set();
  const fractionalNodes = new Set();
  const freqFor = (rec) => {
    if (!rec) return 1;
    if (Number.isFinite(rec.f)) return rec.f;
    if (Number.isFinite(rec.frequency)) return rec.frequency;
    if (Number.isFinite(rec.freq)) return rec.freq;
    return 1;
  };
  const ensureNode = (token, layer) => {
    if (!token) return null;
    const existing = graph.nodes.get(token);
    if (existing) {
      if (Number.isFinite(layer)) {
        const currentLayer = Number(existing.layer);
        if (!Number.isFinite(currentLayer) || layer < currentLayer) existing.layer = layer;
      }
      return existing;
    }
    const rec = index.get(token);
    if (!rec) return null;
    const node = { token, f: freqFor(rec), layer: Number.isFinite(layer) ? layer : 0, degree: 0 };
    graph.nodes.set(token, node);
    return node;
  };
  const pushLink = (from, to, rtype, weight, hiddenTokens = []) => {
    const key = `${from}|${rtype}|${to}`;
    if (seenTriple.has(key)) return false;
    seenTriple.add(key);
    const hidden = Array.isArray(hiddenTokens) ? hiddenTokens.filter(Boolean) : [];
    graph.links.push({ from, to, rtype, w: weight, hiddenTokens: hidden });
    outSet.add(from);
    inSet.add(to);
    const fromNode = graph.nodes.get(from);
    const toNode = graph.nodes.get(to);
    if (fromNode) fromNode.degree = (fromNode.degree || 0) + 1;
    if (toNode) toNode.degree = (toNode.degree || 0) + 1;
    expanded += 1;
    if (loggingActive && expanded % tick === 0) {
      logProgress(expanded, expanded + Math.max(0, queue.length - head));
    }
    return true;
  };
  const queueNext = (from, to, rtype, weight, depth) => {
    queue.push({ from, to, rtype, w: weight, depth });
    enqueued += 1;
  };
  const expandSource = (token, depth) => {
    const rec = index.get(token);
    if (!rec) return;
    ensureNode(token, depth);
    const matrix = buildMatrixForRecord(rec);
    const relations = Array.isArray(matrix?.edges) ? matrix.edges.slice(0, getRelationTypeCap()) : [];
    for (const relation of relations) {
      const rawItems = Array.isArray(relation?.items)
        ? relation.items.slice()
        : [];
      if (!rawItems.length) continue;
      const limit = getEdgesPerType();
      const visibleItems = limit === Infinity ? rawItems : rawItems.slice(0, limit);
      if (!visibleItems.length) continue;
      const hiddenItems = limit === Infinity ? [] : rawItems.slice(visibleItems.length);
      const hiddenTokenSet = new Set();
      for (const item of hiddenItems) {
        const hiddenResolved = resolveTokenKey(item?.token, index, lowerIndexMap);
        if (hiddenResolved) hiddenTokenSet.add(hiddenResolved);
      }
      const hiddenTokens = [...hiddenTokenSet];
      let enumerated = false;
      const nextDepth = depth + 1;
      for (const item of visibleItems) {
        const target = item?.token;
        if (!target) continue;
        const canonicalTarget = resolveTokenKey(target, index, lowerIndexMap);
        if (!canonicalTarget) continue;
        const targetRec = index.get(canonicalTarget);
        if (!targetRec) continue;
        ensureNode(canonicalTarget, nextDepth);
        const weight = Number.isFinite(item?.weight)
          ? item.weight
          : Number.isFinite(item?.w)
            ? item.w
            : relation?.aggWeight;
        const normalizedWeight = Number(weight) || 0;
        const added = pushLink(token, canonicalTarget, relation?.rtype, normalizedWeight, hiddenTokens);
        if (added) {
          enumerated = true;
          if (depth < maxDepth) {
            queueNext(token, canonicalTarget, relation?.rtype, normalizedWeight, nextDepth);
          } else if (frac > 0) {
            fractionalNodes.add(canonicalTarget);
          }
        }
      }
      if (enumerated) edgeTypeEnums += 1;
    }
  };

  for (const anchor of anchorList) {
    const resolvedAnchor = resolveTokenKey(anchor, index, lowerIndexMap);
    if (!resolvedAnchor || !index.get(resolvedAnchor)) continue;
    ensureNode(resolvedAnchor, 0);
    expandSource(resolvedAnchor, 0);
    visitedSrc.add(resolvedAnchor);
  }

  logPhase('anchored', { anchors: anchorList.length, queued: enqueued });

  while (head < queue.length) {
    const edge = queue[head++];
    if (!edge) break;
    if (edge.depth > maxDepth) continue;
    if (visitedSrc.has(edge.to)) continue;
    const resolvedTo = resolveTokenKey(edge.to, index, lowerIndexMap) || edge.to;
    expandSource(resolvedTo, edge.depth);
    visitedSrc.add(resolvedTo);
    if (!opts.silent && expanded % 1000 === 0) {
      logPhase('tick', { expanded, queued: Math.max(0, queue.length - head), nodes: graph.nodes.size, link_instances: graph.links.length });
      await microtask();
    }
  }

  if (frac > 0 && fractionalNodes.size) {
    logPhase('fractional', { added: fractionalNodes.size });
  }

  logProgress(1, 1);
  const metrics = {
    nodes: graph.nodes.size,
    edges: edgeTypeEnums,
    relationships: graph.links.length,
    anchors: [...outSet].filter((t) => inSet.has(t)).length,
  };

  const hiddenConfig = {
    limit: Number(window.HLSF?.config?.hiddenAdjacencyDegree) || DEFAULT_HIDDEN_ATTENTION_PER_TOKEN,
    depth: Number(window.HLSF?.config?.hiddenAdjacencyDepth),
    cap: Number(window.HLSF?.config?.hiddenAdjacencyCap),
  };

  const hiddenNetwork = buildHiddenAdjacencyNetwork(graph, index, lowerIndexMap, ensureNode, hiddenConfig);
  if (hiddenNetwork) {
    const { adjacency, scores, stats } = hiddenNetwork;
    let hiddenEdgeCount = 0;
    for (const [key, weight] of scores.entries()) {
      if (!key) continue;
      const [a, b] = key.split('|');
      if (!a || !b) continue;
      const normalizedWeight = normalizeHiddenWeight(weight);
      const addedForward = pushLink(a, b, HIDDEN_ADJACENCY_RELATION, normalizedWeight, []);
      if (addedForward) hiddenEdgeCount += 1;
      const addedReverse = pushLink(b, a, HIDDEN_ADJACENCY_RELATION, normalizedWeight, []);
      if (addedReverse) hiddenEdgeCount += 1;
    }

    const adjacencyMap = new Map();
    for (const [token, neighbors] of adjacency.entries()) {
      adjacencyMap.set(token, Array.from(neighbors));
    }
    graph.hiddenAdjacency = adjacencyMap;
    graph.hiddenAdjacencyStats = stats;
    metrics.hiddenEdges = hiddenEdgeCount;
    metrics.hiddenTokens = adjacency.size;
    metrics.relationships = graph.links.length;
    metrics.nodes = graph.nodes.size;
    metrics.anchors = [...outSet].filter((t) => inSet.has(t)).length;
    const edgeKeySet = new Set();
    for (const edge of graph.links) {
      if (edge?.from && edge?.rtype) {
        edgeKeySet.add(`${edge.from}|${edge.rtype}`);
      }
    }
    metrics.edges = edgeKeySet.size;
    if (loggingActive) {
      logPhase('hidden-adjacency', {
        expansions: stats.expansions,
        seeds: stats.seeds,
        hidden_tokens: adjacency.size,
        hidden_edges: hiddenEdgeCount,
      });
    }
  }

  graph._metrics = metrics;
  logPhase('summary', metrics);
  markRelationLegendDirty();
  if (graph && typeof graph === 'object') graph.__legendDirty = true;
  return graph;
}

function computeDbStats(index) {
  if (!(index instanceof Map)) {
    return {
      tokens: 0,
      edges: 0,
      relationships: 0,
      nodes: 0,
      anchors: 0,
      minEdges: { count: 0, tokens: [] },
      maxEdges: { count: 0, tokens: [] },
    };
  }

  const outSet = new Set();
  const inSet = new Set();
  let relInstances = 0;
  let edgeTypeEnums = 0;
  let minEdgeCount = Infinity;
  let maxEdgeCount = 0;
  const minEdgeTokens = new Set();
  const maxEdgeTokens = new Set();

  for (const [src, rec] of index) {
    if (!rec || typeof rec !== 'object') continue;
    const rels = rec.relationships || {};
    let srcHasType = 0;
    let srcEdgeCount = 0;
    for (const [rtype, arr] of Object.entries(rels)) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      srcHasType += 1;
      srcEdgeCount += arr.length;
      for (const rel of arr) {
        const tgt = rel?.token;
        if (!tgt) continue;
        relInstances += 1;
        outSet.add(src);
        inSet.add(tgt);
      }
    }
    edgeTypeEnums += srcHasType;

    if (srcEdgeCount < minEdgeCount) {
      minEdgeCount = srcEdgeCount;
      minEdgeTokens.clear();
      minEdgeTokens.add(src);
    } else if (srcEdgeCount === minEdgeCount) {
      minEdgeTokens.add(src);
    }

    if (srcEdgeCount > maxEdgeCount) {
      maxEdgeCount = srcEdgeCount;
      maxEdgeTokens.clear();
      maxEdgeTokens.add(src);
    } else if (srcEdgeCount === maxEdgeCount) {
      maxEdgeTokens.add(src);
    }
  }

  const tokens = index.size;
  const anchors = [...outSet].filter((t) => inSet.has(t)).length;

  if (minEdgeCount === Infinity) {
    minEdgeCount = 0;
  }

  const limitTokenList = (set) => {
    if (!(set instanceof Set) || set.size === 0) return [];
    const out = [];
    for (const token of set) {
      out.push(token);
      if (out.length >= 50) break;
    }
    return out;
  };

  return {
    tokens,
    edges: edgeTypeEnums,
    relationships: relInstances,
    nodes: outSet.size,
    anchors,
    minEdges: {
      count: minEdgeCount,
      tokens: limitTokenList(minEdgeTokens),
    },
    maxEdges: {
      count: maxEdgeCount,
      tokens: limitTokenList(maxEdgeTokens),
    },
  };
}

function ensureGraphMetrics(graph) {
  if (!graph) {
    return { nodes: 0, relationships: 0, anchors: 0, edges: 0 };
  }
  if (graph._metrics && typeof graph._metrics === 'object') return graph._metrics;
  const out = new Set();
  const inn = new Set();
  const links = Array.isArray(graph.links)
    ? graph.links
    : (Array.isArray(graph.edges) ? graph.edges : []);
  const edgeTypes = new Set();
  const triples = new Set();
  for (const edge of links) {
    if (edge?.from) out.add(edge.from);
    if (edge?.to) inn.add(edge.to);
    if (edge?.from && edge?.rtype) edgeTypes.add(`${edge.from}|${edge.rtype}`);
    if (edge?.from && edge?.to && edge?.rtype) triples.add(`${edge.from}|${edge.rtype}|${edge.to}`);
  }
  const anchors = [...out].filter((t) => inn.has(t)).length;
  return {
    nodes: out.size,
    relationships: triples.size || links.length,
    anchors,
    edges: edgeTypes.size || links.length,
  };
}

function microtask() {
  return new Promise(resolve => queueMicrotask(resolve));
}

function activeRelationTypes(index, scope, stateRelTypes) {
  const cap = getRelationTypeCap();
  if (scope === 'state' && stateRelTypes && Number.isFinite(stateRelTypes.maxPresent)) {
    return Math.min(cap, Math.max(0, stateRelTypes.maxPresent | 0));
  }
  return cap;
}

function nonEmptyTypes(index) {
  const has = new Set();
  if (index instanceof Map) {
    for (const [, rec] of index) {
      const rels = rec?.relationships;
      if (!rels || typeof rels !== 'object') continue;
      for (const [rtype, arr] of Object.entries(rels)) {
        if (Array.isArray(arr) && arr.length) has.add(rtype);
      }
    }
  }
  return [...has].sort((a, b) => a.localeCompare(b));
}

function computeDimension(index, scope, stateRelTypes) {
  const types = nonEmptyTypes(index);
  const Treq = activeRelationTypes(index, scope, stateRelTypes);
  const limited = types.slice(0, Math.max(0, Treq));
  return { D: 2 * limited.length, types: limited };
}

function degrees(rec) {
  let out = 0;
  let in_ = 0;
  for (const arr of Object.values(rec?.relationships || {})) {
    if (Array.isArray(arr) && arr.length) {
      out += 1;
      for (const rel of arr) {
        in_ += rel?.incoming ? 1 : 0;
      }
    }
  }
  return { out, in_ };
}

function signature(rec) {
  const weights = new Map();
  for (const arr of Object.values(rec?.relationships || {})) {
    if (!Array.isArray(arr)) continue;
    for (const rel of arr) {
      const token = rel?.token;
      if (!token) continue;
      const weight = Number.isFinite(rel?.weight)
        ? rel.weight
        : Number.isFinite(rel?.w)
          ? rel.w
          : 1;
      weights.set(token, (weights.get(token) || 0) + weight);
    }
  }
  return weights;
}

function cosineSignature(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, va] of a.entries()) {
    na += va * va;
    const vb = b.get(k) || 0;
    if (vb) dot += va * vb;
  }
  for (const vb of b.values()) nb += vb * vb;
  const denom = Math.sqrt(Math.max(na, 0) * Math.max(nb, 0));
  return denom ? dot / denom : 0;
}

function selectAnchors(index, D) {
  if (!(index instanceof Map) || D <= 0) return [];
  const sigs = new Map();
  const tokens = [...index.keys()].sort((a, b) => a.localeCompare(b));
  const allSigs = tokens.map(token => {
    const rec = index.get(token) || {};
    const sig = signature(rec);
    sigs.set(token, sig);
    return [token, sig];
  });
  const sample = allSigs.slice(0, Math.min(512, allSigs.length));
  const scored = tokens.map(token => {
    const rec = index.get(token) || {};
    const { out, in_ } = degrees(rec);
    const freq = Number.isFinite(rec?.frequency)
      ? rec.frequency
      : Number.isFinite(rec?.f)
        ? rec.f
        : Number.isFinite(rec?.freq)
          ? rec.freq
          : 0;
    let ac = 0;
    const sig = sigs.get(token) || new Map();
    for (const [, otherSig] of sample) {
      ac += cosineSignature(sig, otherSig);
    }
    ac /= Math.max(1, sample.length);
    const score = 0.4 * freq + 0.3 * out + 0.2 * in_ + 0.1 * ac;
    return { token, score, out, in_ };
  });
  scored.sort((a, b) => (b.score - a.score) || a.token.localeCompare(b.token));
  return scored.slice(0, D).map(entry => entry.token);
}

function clusterToAnchors(index, anchors) {
  const groups = new Map();
  if (!(index instanceof Map) || !Array.isArray(anchors)) return groups;
  const orderedAnchors = [...anchors];
  for (const anchor of orderedAnchors) {
    groups.set(anchor, []);
  }
  if (!orderedAnchors.length) return groups;
  const anchorSigs = new Map(orderedAnchors.map(a => [a, signature(index.get(a) || {})]));
  for (const [token, rec] of index.entries()) {
    if (anchorSigs.has(token)) continue;
    const sig = signature(rec || {});
    let best = orderedAnchors[0];
    let bestScore = -Infinity;
    for (const anchor of orderedAnchors) {
      const c = cosineSignature(sig, anchorSigs.get(anchor) || new Map());
      if (c > bestScore) {
        bestScore = c;
        best = anchor;
      }
    }
    groups.get(best).push(token);
  }
  for (const [anchor, list] of groups) {
    list.sort((a, b) => a.localeCompare(b));
  }
  return groups;
}

function packLevels(index, scope, state) {
  const stateRelTypes = state?.relationTypes || {};
  let { D, types } = computeDimension(index, scope, stateRelTypes);
  const focusListRaw = Array.isArray(state?.focusTokens)
    ? state.focusTokens.filter(token => typeof token === 'string' && index.has(token))
    : [];
  const focusSet = new Set();
  const focusList = [];
  for (const token of focusListRaw) {
    if (focusSet.has(token)) continue;
    focusSet.add(token);
    focusList.push(token);
  }

  const tokensCount = scope === 'state'
    ? (state?.tokens instanceof Set ? state.tokens.size : index.size)
    : index.size;
  if (focusList.length) {
    const minDimension = Math.max(focusList.length, 1);
    D = Math.max(D || minDimension, minDimension);
  }

  let anchors = selectAnchors(index, Math.min(D || tokensCount, tokensCount));
  if (focusList.length) {
    const ordered = focusList.slice();
    anchors = [...ordered, ...anchors.filter(token => !focusSet.has(token))];
    if (anchors.length > D) {
      D = Math.max(D, anchors.length);
    }
  }

  let effectiveD = Math.min(D, Math.max(anchors.length, 0));
  if (focusList.length && effectiveD < focusList.length) {
    effectiveD = Math.min(Math.max(focusList.length, 1), Math.max(anchors.length, focusList.length));
  }

  const levels = [];
  levels.push({ cells: [{ anchor: null, tokens: anchors.slice(0, Math.min(effectiveD || anchors.length, anchors.length)) }] });

  if (!effectiveD || tokensCount <= effectiveD) {
    return { D, effectiveD: Math.min(tokensCount, effectiveD), levels, anchors, types };
  }

  const clusters = clusterToAnchors(index, anchors);
  const cells = [];
  for (const anchor of anchors) {
    const list = clusters.get(anchor) || [];
    const combined = [anchor, ...list];
    const cellTokens = combined.slice(0, effectiveD || combined.length);
    cells.push({ anchor, tokens: cellTokens });
  }
  levels.push({ cells });

  const pool = [];
  for (const anchor of anchors) {
    const list = clusters.get(anchor) || [];
    const combined = [anchor, ...list];
    if (combined.length > (effectiveD || combined.length)) {
      pool.push(...combined.slice(effectiveD));
    }
  }

  if (pool.length) {
    const L2cells = [];
    const span = Math.max(1, effectiveD || 1);
    const blocks = Math.ceil(pool.length / span);
    for (let i = 0; i < blocks; i++) {
      const anchor = cells[i % cells.length]?.anchor ?? null;
      const start = i * span;
      const slice = pool.slice(start, start + span);
      if (!slice.length) continue;
      L2cells.push({ anchor, tokens: slice });
    }
    if (L2cells.length) levels.push({ cells: L2cells });
  }

  return { D, effectiveD, levels, anchors, types };
}

function layoutPolygon(tokens, angles, radius, levelIndex) {
  const tau = Math.PI * 2;
  const out = [];
  if (!Array.isArray(tokens) || !tokens.length) return out;
  const useAngles = Array.isArray(angles) && angles.length ? angles : tokens.map((_, i) => (tau * i) / Math.max(1, tokens.length));
  for (let i = 0; i < tokens.length; i++) {
    const angle = useAngles[i % useAngles.length];
    const normAngle = normalizeAngle(angle);
    out.push({ token: tokens[i], angle: normAngle, radius, level: levelIndex, cellIndex: 0 });
  }
  return out;
}

function layoutSectorPolygon(tokens, baseAngle, sectorSpan, radius, levelIndex, cellIndex) {
  const tau = Math.PI * 2;
  const out = [];
  if (!Array.isArray(tokens) || !tokens.length) return out;
  if (tokens.length === 1) {
    out.push({ token: tokens[0], angle: normalizeAngle(baseAngle), radius, level: levelIndex, cellIndex });
    return out;
  }
  const step = sectorSpan / Math.max(tokens.length, 1);
  const start = baseAngle - (sectorSpan / 2) + step / 2;
  for (let i = 0; i < tokens.length; i++) {
    const angle = normalizeAngle(start + i * step);
    out.push({ token: tokens[i], angle, radius, level: levelIndex, cellIndex });
  }
  return out;
}

function normalizeAngle(angle) {
  const tau = Math.PI * 2;
  let a = angle % tau;
  if (a < 0) a += tau;
  return a;
}

function computeActiveAngles(types) {
  const count = Math.max(0, types.length * 2);
  if (!count) return [];
  const tau = Math.PI * 2;
  const step = tau / count;
  return Array.from({ length: count }, (_, i) => normalizeAngle(i * step));
}

function placeLevels(levels, effectiveD, activeAngles) {
  const positions = new Map();
  const cellsGeom = [];
  const placed = new Set();
  const anchorAngles = new Map();
  const levelCount = Array.isArray(levels) ? levels.length : 0;
  const tau = Math.PI * 2;
  let maxRadius = 0;

  if (!levelCount) {
    return { positions, cells: cellsGeom, maxRadius: 0, anchorAngles };
  }

  const first = levels[0]?.cells?.[0]?.tokens || [];
  const radius0 = 1;
  const l0 = layoutPolygon(first, activeAngles.slice(0, first.length), radius0, 0);
  maxRadius = Math.max(maxRadius, radius0);
  const cell0 = [];
  for (let i = 0; i < l0.length; i++) {
    const entry = l0[i];
    if (!positions.has(entry.token)) {
      positions.set(entry.token, entry);
      placed.add(entry.token);
      anchorAngles.set(entry.token, entry.angle);
    }
    cell0.push(entry);
  }
  cellsGeom.push({ level: 0, index: 0, anchor: null, tokens: cell0 });

  for (let levelIndex = 1; levelIndex < levelCount; levelIndex++) {
    const level = levels[levelIndex];
    const cells = Array.isArray(level?.cells) ? level.cells : [];
    const isLast = levelIndex === levelCount - 1;
    const radius = levelIndex + 1;
    maxRadius = Math.max(maxRadius, radius);
    const components = isLast ? cells.length : Math.max(activeAngles.length, cells.length, 1);
    const step = components ? tau / components : tau;
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
      const cell = cells[cellIndex];
      const anchor = cell?.anchor ?? null;
      let baseAngle;
      if (isLast) {
        baseAngle = cellIndex * step;
      } else if (levelIndex === 1 && anchor != null && anchorAngles.has(anchor)) {
        baseAngle = anchorAngles.get(anchor);
      } else if (activeAngles.length) {
        baseAngle = activeAngles[cellIndex % activeAngles.length];
      } else {
        baseAngle = cellIndex * step;
      }
      const tokens = Array.isArray(cell?.tokens) ? cell.tokens : [];
      const fresh = tokens.filter(token => !placed.has(token));
      const sectorSpan = step;
      const placedEntries = layoutSectorPolygon(fresh, baseAngle, sectorSpan, radius, levelIndex, cellIndex);
      for (const entry of placedEntries) {
        positions.set(entry.token, entry);
        placed.add(entry.token);
      }
      const geomTokens = tokens.map(token => {
        const existing = positions.get(token);
        if (existing) {
          return Object.assign({}, existing, { cellIndex });
        }
        const angle = normalizeAngle(baseAngle);
        return { token, angle, radius, level: levelIndex, cellIndex };
      });
      cellsGeom.push({ level: levelIndex, index: cellIndex, anchor, tokens: geomTokens });
    }
  }

  return { positions, cells: cellsGeom, maxRadius, anchorAngles };
}

function computeLayout(graph, index, options = {}) {
  if (!graph) return { nodes: 0, edges: 0 };
  const idx = index instanceof Map ? index : window.HLSF?.lastCommand?.idx;
  const baseIndex = idx instanceof Map ? idx : new Map();
  const config = window.HLSF?.config || {};
  const desiredScope = (options?.scope || config.hlsfScope || 'db').toLowerCase();
  let scope = desiredScope === 'state' ? 'state' : 'db';
  const focusTokens = Array.isArray(options?.focusTokens)
    ? options.focusTokens.filter(token => typeof token === 'string' && token.trim())
    : [];

  const sessionTokens = window.Session?.tokens instanceof Set ? window.Session.tokens : new Set();
  const scopedTokens = new Set();
  if (scope === 'state') {
    for (const token of sessionTokens) {
      if (baseIndex.has(token)) scopedTokens.add(token);
    }
    if (!scopedTokens.size) scope = 'db';
  }

  let scopedIndex;
  if (scope === 'state') {
    scopedIndex = new Map();
    for (const token of scopedTokens) {
      scopedIndex.set(token, baseIndex.get(token));
    }
  } else {
    scopedIndex = baseIndex;
    for (const token of baseIndex.keys()) scopedTokens.add(token);
  }

  if (!(scopedIndex instanceof Map) || scopedIndex.size === 0) {
    scopedIndex = baseIndex;
    for (const token of baseIndex.keys()) scopedTokens.add(token);
  }

  for (const token of focusTokens) {
    if (scopedIndex.has(token)) scopedTokens.add(token);
  }

  const typeList = nonEmptyTypes(scopedIndex);
  const packed = packLevels(scopedIndex, scope, {
    relationTypes: { maxPresent: typeList.length },
    tokens: scopedTokens,
    focusTokens,
  });
  const activeAngles = computeActiveAngles(packed.types || []);
  const placed = placeLevels(packed.levels, packed.effectiveD, activeAngles);
  const dbMetrics = computeDbStats(scopedIndex);

  const positions = placed.positions;
  const ensurePosition = (token) => {
    if (positions.has(token)) return;
    const radius = (placed.maxRadius || 1) + 1;
    positions.set(token, { token, angle: 0, radius, level: packed.levels.length, cellIndex: 0 });
  };
  for (const token of scopedIndex.keys()) ensurePosition(token);

  const newNodes = new Map();
  for (const [token, rec] of scopedIndex.entries()) {
    const node = graph.nodes.get(token) || {};
    const freq = Number.isFinite(rec?.frequency)
      ? rec.frequency
      : Number.isFinite(rec?.f)
        ? rec.f
        : Number.isFinite(rec?.freq)
          ? rec.freq
          : node.f;
    node.token = token;
    if (Number.isFinite(freq)) node.f = freq;
    const pos = positions.get(token);
    if (pos) {
      node.layer = pos.level;
      node.cluster = pos.cellIndex;
    }
    newNodes.set(token, node);
  }
  graph.nodes = newNodes;

  const levelCount = Array.isArray(packed.levels) ? packed.levels.length : 0;
  const lastLevelComponents = levelCount ? (packed.levels[levelCount - 1]?.cells?.length || 0) : 0;
  const layout = {
    scope,
    dimension: packed.D,
    effectiveDimension: packed.effectiveD,
    anchors: packed.anchors,
    levels: packed.levels,
    cells: placed.cells,
    activeAngles,
    positions,
    maxRadius: placed.maxRadius || levelCount || 1,
    anchorAngles: placed.anchorAngles,
    metrics: dbMetrics,
    dbMetrics,
    levelCount,
    lastLevelComponents,
    types: packed.types,
  };

  graph.dimensionLayout = layout;
  graph.anchors = Array.isArray(packed.anchors) ? packed.anchors : graph.anchors;
  graph._dbMetrics = dbMetrics;
  graph._metrics = ensureGraphMetrics(graph);

  const linkCount = Array.isArray(graph.links)
    ? graph.links.length
    : (Array.isArray(graph.edges) ? graph.edges.length : 0);
  return {
    nodes: newNodes.size,
    edges: linkCount,
    layout,
    metrics: dbMetrics,
    runMetrics: graph._metrics,
  };
}

function prepareBuffers(graph, layout, options = {}) {
  const glyphOnly = options?.glyphOnly === true;
  window.HLSF.currentGraph = graph;
  window.HLSF.currentGlyphOnly = glyphOnly;
  window.HLSF.currentLayoutSnapshot = layout;
  if (window.HLSF?.state) {
    window.HLSF.state.patches = new Map();
    window.HLSF.state.emergentRot = 0;
  }
}

function collectWorkingMemoryAnchors(index, limit) {
  if (!(index instanceof Map)) return [];

  const anchors = [];
  const seen = new Set();
  const limitValue = Number.isFinite(limit) && limit > 0 ? limit : Infinity;

  const caseMap = new Map();
  for (const key of index.keys()) {
    if (typeof key !== 'string') continue;
    const lower = key.toLowerCase();
    if (!caseMap.has(lower)) caseMap.set(lower, key);
  }

  const pushToken = (token) => {
    if (anchors.length >= limitValue) return;
    if (!token) return;
    const lookup = typeof token === 'string' ? token.toLowerCase() : '';
    if (!lookup) return;
    const resolved = caseMap.get(lookup);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    anchors.push(resolved);
  };

  const liveState = typeof state !== 'undefined' ? state : window.CognitionEngine?.state;
  const stateTokens = Array.isArray(liveState?.tokenOrder) ? liveState.tokenOrder : [];
  for (const token of stateTokens) pushToken(token);

  const sessionTokens = window.Session?.tokens;
  if (sessionTokens instanceof Set) {
    for (const token of sessionTokens) pushToken(token);
  }

  const liveNodes = liveState?.liveGraph?.nodes;
  if (liveNodes instanceof Map) {
    for (const token of liveNodes.keys()) pushToken(token);
  }

  return anchors;
}

function buildLowercaseIndexMap(index) {
  const map = new Map();
  if (!(index instanceof Map)) return map;
  for (const key of index.keys()) {
    if (typeof key !== 'string') continue;
    const lower = key.toLowerCase();
    if (!lower || map.has(lower)) continue;
    map.set(lower, key);
  }
  return map;
}

function resolveTokenKey(token, index, lowerMap) {
  if (!token || !(index instanceof Map)) return null;
  if (index.has(token)) return token;
  if (typeof token === 'string') {
    const lower = token.toLowerCase();
    if (index.has(lower)) return lower;
    if (lowerMap instanceof Map) {
      const resolved = lowerMap.get(lower);
      if (resolved && index.has(resolved)) return resolved;
    }
  }
  return null;
}

function normalizeHiddenWeight(value) {
  if (!Number.isFinite(value)) return HIDDEN_EDGE_MIN_WEIGHT;
  const clamped = Math.max(HIDDEN_EDGE_MIN_WEIGHT, value);
  return Math.round(clamped * 1000) / 1000;
}

function topAttentionNeighborsForRecord(record, index, lowerMap, limit) {
  if (!record || typeof record !== 'object') return [];
  const aggregate = new Map();
  const origin = typeof record.token === 'string' ? record.token : '';
  const relationships = record.relationships || {};
  for (const [rawType, edges] of Object.entries(relationships)) {
    if (!Array.isArray(edges) || edges.length === 0) continue;
    const glyph = normRelKey(rawType) || rawType;
    const priority = getRelationshipPriority(glyph);
    if (!Number.isFinite(priority) || priority <= 0) continue;
    for (const edge of edges) {
      if (!edge || typeof edge.token !== 'string') continue;
      const resolved = resolveTokenKey(edge.token, index, lowerMap);
      if (!resolved || resolved === origin) continue;
      const weight = Number(edge.weight);
      const score = (Number.isFinite(weight) ? weight : 1) * priority;
      if (!Number.isFinite(score) || score <= 0) continue;
      aggregate.set(resolved, (aggregate.get(resolved) || 0) + score);
    }
  }
  return [...aggregate.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([token, score]) => ({ token, score }));
}

function gatherHiddenAdjacencySeeds(graph, index, lowerMap, cap) {
  const seeds = new Set();
  const limit = Math.max(1, Number(cap) || 1);

  const addToken = (token) => {
    if (!token || seeds.size >= limit) return;
    const resolved = resolveTokenKey(token, index, lowerMap);
    if (!resolved) return;
    seeds.add(resolved);
  };

  if (graph?.nodes instanceof Map) {
    for (const token of graph.nodes.keys()) {
      addToken(token);
      if (seeds.size >= limit) break;
    }
  }

  const workingAnchors = collectWorkingMemoryAnchors(index, limit);
  for (const token of workingAnchors) {
    addToken(token);
    if (seeds.size >= limit) return Array.from(seeds);
  }

  if (typeof window !== 'undefined') {
    const hlsf = window.HLSF || {};
    const memory = hlsf.localMemory;
    if (memory) {
      const prompts = Array.isArray(memory.prompts) ? memory.prompts : [];
      for (let i = prompts.length - 1; i >= 0 && seeds.size < limit; i--) {
        const entry = prompts[i];
        const tokens = Array.isArray(entry?.tokens) ? entry.tokens : [];
        for (const token of tokens) {
          addToken(token);
          if (seeds.size >= limit) break;
        }
      }

      const summaries = memory.adjacencySummaries;
      if (summaries instanceof Map) {
        const recent = Array.from(summaries.values());
        for (let i = recent.length - 1; i >= 0 && seeds.size < limit; i--) {
          const record = recent[i];
          const summaryEntries = Array.isArray(record?.summary) ? record.summary : [];
          for (const item of summaryEntries) {
            if (!item) continue;
            const token = typeof item === 'string' ? item : item.token;
            addToken(token);
            if (seeds.size >= limit) break;
          }
        }
      }

      const lastAdjacency = memory.lastAdjacency;
      if (lastAdjacency && Array.isArray(lastAdjacency.summary)) {
        for (const item of lastAdjacency.summary) {
          if (!item) continue;
          const token = typeof item === 'string' ? item : item.token;
          addToken(token);
          if (seeds.size >= limit) break;
        }
      }
    }
  }

  return Array.from(seeds);
}

function ensureFullHiddenConnectivity(hiddenMap, nodeIterator, scoreMap) {
  if (!(hiddenMap instanceof Map)) return;
  const baseNodes = Array.isArray(nodeIterator)
    ? nodeIterator
    : Array.from(nodeIterator || []);
  if (!baseNodes.length) return;
  const visited = new Set();
  const components = [];

  const traverse = (start) => {
    const stack = [start];
    const component = [];
    visited.add(start);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      const neighbors = hiddenMap.get(current);
      if (!(neighbors instanceof Set)) continue;
      for (const neighbor of neighbors) {
        if (!neighbor || visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    return component;
  };

  for (const token of baseNodes) {
    if (!token || visited.has(token)) continue;
    components.push(traverse(token));
  }

  if (components.length <= 1) return;

  const primary = components[0] || [];
  const primaryToken = primary[0];
  if (!primaryToken) return;

  for (let i = 1; i < components.length; i++) {
    const component = components[i];
    if (!component || !component.length) continue;
    const target = component[0];
    if (!target) continue;
    let primarySet = hiddenMap.get(primaryToken);
    if (!(primarySet instanceof Set)) {
      primarySet = new Set();
      hiddenMap.set(primaryToken, primarySet);
    }
    primarySet.add(target);
    let targetSet = hiddenMap.get(target);
    if (!(targetSet instanceof Set)) {
      targetSet = new Set();
      hiddenMap.set(target, targetSet);
    }
    targetSet.add(primaryToken);
    const key = primaryToken < target ? `${primaryToken}|${target}` : `${target}|${primaryToken}`;
    if (!scoreMap.has(key)) {
      scoreMap.set(key, HIDDEN_EDGE_MIN_WEIGHT);
    }
  }
}

function buildHiddenAdjacencyNetwork(graph, index, lowerMap, ensureNode, options = {}) {
  if (!(graph?.nodes instanceof Map) || !(index instanceof Map)) return null;

  const limit = Math.max(1, Number(options?.limit) || DEFAULT_HIDDEN_ATTENTION_PER_TOKEN);
  const maxDepth = Math.max(0, Number.isFinite(options?.depth) ? Math.floor(options.depth) : DEFAULT_HIDDEN_ADJACENCY_DEPTH);
  const cap = Math.max(limit, Number.isFinite(options?.cap) ? Math.floor(options.cap) : DEFAULT_HIDDEN_ADJACENCY_CAP);

  const adjacency = new Map();
  const scoreMap = new Map();
  const visited = new Map();
  const queue = [];

  const seeds = gatherHiddenAdjacencySeeds(graph, index, lowerMap, cap);
  if (!seeds.length) {
    return {
      adjacency,
      scores: scoreMap,
      stats: {
        seeds: 0,
        expansions: 0,
        visitedTokens: 0,
        limit,
        depth: maxDepth,
        cap,
        edgeCount: 0,
        hiddenTokens: 0,
        componentCount: 0,
        allSeedsConnected: true,
      },
    };
  }

  for (const seed of seeds) {
    if (!seed || visited.has(seed)) continue;
    visited.set(seed, 0);
    queue.push({ token: seed, depth: 0 });
    if (typeof ensureNode === 'function') {
      ensureNode(seed, 0);
    }
  }

  let expansions = 0;

  while (queue.length) {
    const next = queue.shift();
    if (!next) continue;
    const { token, depth } = next;
    if (!token) continue;
    const record = index.get(token);
    if (!record) continue;

    const neighbors = topAttentionNeighborsForRecord(record, index, lowerMap, limit);
    if (!Array.isArray(neighbors) || neighbors.length === 0) continue;

    expansions += 1;

    const ensureAdjacencySet = (key) => {
      let bucket = adjacency.get(key);
      if (!(bucket instanceof Set)) {
        bucket = new Set();
        adjacency.set(key, bucket);
      }
      return bucket;
    };

    for (const neighbor of neighbors) {
      const neighborToken = typeof neighbor?.token === 'string' ? neighbor.token : null;
      if (!neighborToken || neighborToken === token) continue;

      ensureAdjacencySet(token).add(neighborToken);
      ensureAdjacencySet(neighborToken).add(token);

      const rawWeight = Number.isFinite(neighbor?.score) ? neighbor.score : HIDDEN_EDGE_MIN_WEIGHT;
      const normalizedWeight = normalizeHiddenWeight(rawWeight);
      const key = token < neighborToken ? `${token}|${neighborToken}` : `${neighborToken}|${token}`;
      const previous = scoreMap.get(key) ?? 0;
      scoreMap.set(key, previous ? Math.max(previous, normalizedWeight) : normalizedWeight);

      if (typeof ensureNode === 'function') {
        ensureNode(neighborToken, depth + 1);
      }

      if (!visited.has(neighborToken) && depth < maxDepth && visited.size < cap) {
        visited.set(neighborToken, depth + 1);
        queue.push({ token: neighborToken, depth: depth + 1 });
      }
    }
  }

  const adjacencyNodes = Array.from(adjacency.keys());
  ensureFullHiddenConnectivity(adjacency, adjacencyNodes, scoreMap);

  const seen = new Set();
  let componentCount = 0;
  for (const node of adjacencyNodes) {
    if (!node || seen.has(node)) continue;
    componentCount += 1;
    const stack = [node];
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      const neighbors = adjacency.get(current);
      if (!(neighbors instanceof Set)) continue;
      for (const neighbor of neighbors) {
        if (!neighbor || seen.has(neighbor)) continue;
        stack.push(neighbor);
      }
    }
  }

  const stats = {
    seeds: seeds.length,
    expansions,
    visitedTokens: visited.size,
    limit,
    depth: maxDepth,
    cap,
    edgeCount: scoreMap.size,
    hiddenTokens: adjacency.size,
    componentCount,
    allSeedsConnected: componentCount <= 1,
  };

  return { adjacency, scores: scoreMap, stats };
}

async function collectSymbolAwareTokens(text, baseTokens = [], label = 'default') {
  const baseList = Array.isArray(baseTokens) ? baseTokens : [];
  if (!SETTINGS.tokenizeSymbols) return baseList;

  try {
    const pipelineResult = await pipelineClient.run(text || '', SETTINGS);
    const map = new Map();

    for (const token of baseList) {
      if (!token) continue;
      const normalized = String(token).toLowerCase();
      if (!normalized || map.has(`word:${normalized}`)) continue;
      map.set(`word:${normalized}`, { token: normalized, kind: 'word' });
    }

    for (const token of pipelineResult.tokens) {
      if (!token) continue;
      if (token.kind === 'word') {
        const normalized = token.t.toLowerCase();
        if (!normalized || map.has(`word:${normalized}`)) continue;
        map.set(`word:${normalized}`, { token: normalized, kind: 'word' });
      } else if (token.kind === 'sym') {
        const key = `sym:${token.t}`;
        if (map.has(key)) continue;
        map.set(key, {
          token: token.t,
          kind: 'sym',
          cat: token.cat || null,
          index: token.i,
          span: token.n,
        });
      }
    }

    const combined = Array.from(map.values());
    const metricsBucket = recordSymbolMetrics(label, pipelineResult, baseList.length);
    if (metricsBucket) {
      metricsBucket.lastTokens = combined;
      metricsBucket.lastPipeline = pipelineResult;
    } else {
      const fallbackState = typeof globalThis !== 'undefined' ? (globalThis as any).state : undefined;
      if (fallbackState?.symbolMetrics) {
        fallbackState.symbolMetrics.lastTokens = combined;
        fallbackState.symbolMetrics.lastPipeline = pipelineResult;
      }
    }
    return combined;
  } catch (error) {
    console.warn('Symbol-aware tokenization failed:', error);
    return baseList;
  }
}

function recordSymbolMetrics(label, pipelineResult, baseTokenCount = 0) {
  if (!pipelineResult || typeof pipelineResult !== 'object') return null;

  const globalState = typeof globalThis !== 'undefined' ? (globalThis as any).state : undefined;
  const rootState = (globalState && typeof globalState === 'object') ? globalState : window.CognitionEngine?.state;
  if (!rootState || typeof rootState !== 'object') return null;

  const bucket = (rootState.symbolMetrics = rootState.symbolMetrics || {
    history: [],
    last: null,
    lastRunGraph: null,
    topNodes: [],
    lastTokens: [],
    lastPipeline: null,
  });

  const metrics = pipelineResult.metrics || {};
  const tokens = Array.isArray(pipelineResult.tokens) ? pipelineResult.tokens : [];
  const tokenCount = Number.isFinite(metrics.tokenCount) ? metrics.tokenCount : tokens.length;
  const wordCount = Number.isFinite(metrics.wordCount)
    ? metrics.wordCount
    : tokens.filter(tok => tok?.kind === 'word').length;
  const symbolCount = Number.isFinite(metrics.symbolCount)
    ? metrics.symbolCount
    : tokens.filter(tok => tok?.kind === 'sym').length;
  const symbolDensity = Number.isFinite(metrics.symbolDensity)
    ? metrics.symbolDensity
    : (tokenCount ? symbolCount / tokenCount : 0);
  const edgeCount = Number.isFinite(metrics.edgeCount)
    ? metrics.edgeCount
    : (Array.isArray(pipelineResult.edges) ? pipelineResult.edges.length : 0);
  const symbolEdgeCount = Number.isFinite(metrics.symbolEdgeCount)
    ? metrics.symbolEdgeCount
    : 0;
  const weightSum = Number.isFinite(metrics.weightSum) ? metrics.weightSum : 0;
  const baseCount = Number.isFinite(baseTokenCount) ? baseTokenCount : 0;
  const uniqueTokens = tokens.reduce((acc, tok) => {
    const key = typeof tok?.t === 'string' ? tok.t : typeof tok?.token === 'string' ? tok.token : '';
    if (!key) return acc;
    acc.add(key);
    return acc;
  }, new Set());

  const entry = {
    label,
    timestamp: Date.now(),
    tokenCount,
    wordCount,
    symbolCount,
    symbolDensity,
    edgeCount,
    symbolEdgeCount,
    weightSum,
    baseTokenCount: baseCount,
    deltaTokens: tokenCount - baseCount,
    uniqueTokens: uniqueTokens.size,
  };

  if (!Array.isArray(bucket.history)) bucket.history = [];
  bucket.history.push(entry);
  const maxHistory = 32;
  if (bucket.history.length > maxHistory) {
    bucket.history.splice(0, bucket.history.length - maxHistory);
  }

  bucket.last = entry;
  bucket.lastRunGraph = pipelineResult.graph || null;
  bucket.topNodes = Array.isArray(pipelineResult.top) ? pipelineResult.top.slice(0, 12) : [];
  bucket.lastTokens = Array.isArray(pipelineResult.tokens) ? pipelineResult.tokens : [];
  bucket.lastPipeline = pipelineResult;

  return bucket;
}

function syncSettings() {
  if (typeof window === 'undefined') return;
  window.SETTINGS = Object.assign(window.SETTINGS || {}, SETTINGS);
  if (window.CognitionEngine?.settings) {
    Object.assign(window.CognitionEngine.settings, SETTINGS);
  }
}

function countWords(text) {
  if (!text) return 0;
  const words = String(text).trim().match(/\S+/g);
  return words ? words.length : 0;
}

function limitWords(text, maxWords) {
  const limit = Number.isFinite(maxWords) && maxWords > 0 ? Math.floor(maxWords) : 0;
  if (!text || limit <= 0) {
    return { text: '', wordCount: 0, totalWords: 0, trimmed: Boolean(text) };
  }

  const normalized = String(text).trim();
  const matches = normalized.match(/\S+/g) || [];
  if (matches.length <= limit) {
    return {
      text: normalized,
      wordCount: matches.length,
      totalWords: matches.length,
      trimmed: false,
    };
  }

  let cutoffIndex = normalized.length;
  const re = /\S+/g;
  let match;
  let seen = 0;
  while ((match = re.exec(normalized)) !== null) {
    seen += 1;
    if (seen === limit) {
      cutoffIndex = match.index + match[0].length;
      break;
    }
  }

  const clipped = normalized.slice(0, cutoffIndex).trim();
  return {
    text: clipped,
    wordCount: limit,
    totalWords: matches.length,
    trimmed: true,
  };
}

function splitIntoSentences(text) {
  if (!text) return [];
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const matches = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!matches) return [normalized];
  return matches.map(sentence => sentence.trim()).filter(Boolean);
}

function tokenize(text) {
  if (!text) return [];

  const source = String(text);

  const fallback = () =>
    source
      .split(/\s+/)
      .map(token => token.trim())
      .filter(Boolean);

  if (!SETTINGS.tokenizeSymbols) {
    return fallback();
  }

  try {
    const result = tokenizeWithSymbols(source, { keepOffsets: false });
    if (!Array.isArray(result) || result.length === 0) {
      return fallback();
    }
    return result
      .map(entry => (entry?.t ?? '').toString().trim())
      .filter(Boolean);
  } catch (err) {
    console.warn('Symbol tokenization failed, falling back to whitespace tokenization:', err);
    return fallback();
  }
}

function estimateTokensForText(text) {
  return tokenize(text).length;
}

function estimateTokensForMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    if (!message) continue;
    const contentTokens = estimateTokensForText(message.content || '');
    const roleTokens = message.role ? 4 : 0;
    total += contentTokens + roleTokens;
  }
  return total + 3; // minimal overhead for chat formatting
}

function estimateCompletionTokens(promptTokenCount) {
  const ratio = CONFIG.ESTIMATED_COMPLETION_RATIO ?? 0.7;
  const estimate = Math.round(promptTokenCount * ratio);
  return Math.max(32, estimate);
}

function getModelPricing(model) {
  const pricing = CONFIG.MODEL_PRICING?.[model];
  return pricing || CONFIG.MODEL_PRICING?.default || { inputPerMillion: 0, outputPerMillion: 0 };
}

function estimateCostUsd(promptTokens = 0, completionTokens = 0, model = CONFIG.DEFAULT_MODEL) {
  const pricing = getModelPricing(model);
  return ((promptTokens * pricing.inputPerMillion) + (completionTokens * pricing.outputPerMillion)) / 1_000_000;
}

const Session = (() => {
  const existing = window.Session && typeof window.Session === 'object'
    ? window.Session
    : {};
  const session = Object.assign({ tokens: new Set(), prompts: [] }, existing);
  if (!(session.tokens instanceof Set)) {
    const seedTokens = Array.isArray(session.tokens) ? session.tokens : [];
    session.tokens = new Set(seedTokens.filter(Boolean));
  }
  if (!Array.isArray(session.prompts)) {
    session.prompts = Array.isArray(existing.prompts) ? [...existing.prompts] : [];
  }
  window.Session = session;
  return session;
})();

function addConversationTokens(arr) {
  for (const token of arr || []) {
    if (token) Session.tokens.add(token);
  }
}

function normalizeTokenList(input) {
  if (!input) return [];
  const array = Array.isArray(input)
    ? input
    : String(input).split(/\s+/);
  const out = [];
  const seen = new Set();
  for (const raw of array) {
    if (!raw) continue;
    const token = raw.toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function ensureTokenOrder(token) {
  if (!token) return;
  const key = token.toLowerCase();
  if (!state.tokenOrder.includes(key)) {
    state.tokenOrder.push(key);
  }
}

function ensureTokenEntry(token) {
  if (!token) return null;
  const key = token.toLowerCase();
  let entry = state.tokenSources.get(key);
  if (!entry) {
    entry = { input: false, committed: false, output: false };
    state.tokenSources.set(key, entry);
    ensureTokenOrder(key);
  }
  return entry;
}

function isTokenActive(token) {
  const entry = state.tokenSources.get(token);
  return !!entry && (entry.input || entry.output || entry.committed);
}

function pruneInactiveTokens() {
  for (const [token, entry] of state.tokenSources.entries()) {
    if (!isTokenActive(token)) {
      state.tokenSources.delete(token);
    }
  }
  state.tokenOrder = state.tokenOrder.filter(token => state.tokenSources.has(token));
}

function resolveLiveGraphTokenCap() {
  if (typeof window !== 'undefined') {
    const configured = Number(window?.HLSF?.config?.liveTokenCap);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(12, Math.floor(configured));
    }
  }
  return DEFAULT_LIVE_TOKEN_CAP;
}

function resolveLiveGraphEdgeWeightFloor() {
  if (typeof window !== 'undefined') {
    const configured = Number(window?.HLSF?.config?.liveEdgeWeightMin);
    if (Number.isFinite(configured) && configured >= 0) {
      return Math.max(0, configured);
    }
  }
  return DEFAULT_LIVE_EDGE_WEIGHT_MIN;
}

function resolveLocalMemoryEdgeWeightFloor() {
  if (typeof window !== 'undefined') {
    const config = window?.HLSF?.config || {};
    const raw = config.localMemoryEdgeWeightMin != null
      ? Number(config.localMemoryEdgeWeightMin)
      : Number(config.liveEdgeWeightMin);
    if (Number.isFinite(raw) && raw >= 0) {
      return Math.max(0, raw);
    }
  }
  return DEFAULT_LOCAL_MEMORY_EDGE_WEIGHT_MIN;
}

function pruneRelationshipEdgesByWeight(relationships, minWeight = 0) {
  const result = {};
  let totalWeight = 0;
  let totalEdges = 0;
  const configuredThreshold = (() => {
    const runtime = typeof window !== 'undefined' ? window?.HLSF?.config : null;
    const candidate = runtime?.pruneWeightThreshold ?? activeSettings()?.pruneWeightThreshold;
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    return 0.18;
  })();
  const threshold = Number.isFinite(minWeight) && minWeight > 0
    ? Math.max(minWeight, configuredThreshold)
    : configuredThreshold;

  if (!relationships || typeof relationships !== 'object') {
    return { relationships: result, totalWeight, totalEdges };
  }

  for (const [rel, edges] of Object.entries(relationships)) {
    if (!Array.isArray(edges) || edges.length === 0) continue;
    const filtered = [];
    for (const edge of edges) {
      if (!edge || typeof edge.token !== 'string') continue;
      const token = edge.token.trim();
      if (!token) continue;
      const weight = Number(edge.weight) || 0;
      if (weight < threshold) continue;
      filtered.push({ token, weight });
      totalWeight += weight;
      totalEdges += 1;
    }
    if (filtered.length) {
      filtered.sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
      result[rel] = filtered;
    }
  }

  return { relationships: result, totalWeight, totalEdges };
}

function pruneLiveGraphNodes(nodes, edges, options = {}) {
  if (!(nodes instanceof Map)) {
    return { edges: Array.isArray(edges) ? edges.filter(edge => edge && typeof edge === 'object') : [], removedTokens: [] };
  }

  const minWeight = Number.isFinite(options.minWeight) ? Math.max(0, options.minWeight) : resolveLiveGraphEdgeWeightFloor();
  const maxTokens = Number.isFinite(options.maxTokens) ? Math.max(1, Math.floor(options.maxTokens)) : resolveLiveGraphTokenCap();

  const weightMap = new Map();
  for (const token of nodes.keys()) {
    weightMap.set(token, 0);
  }

  const filteredEdges = [];
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      if (!edge || typeof edge !== 'object') continue;
      const from = typeof edge.from === 'string' ? edge.from : null;
      const to = typeof edge.to === 'string' ? edge.to : null;
      if (!from || !to) continue;
      if (!nodes.has(from) || !nodes.has(to)) continue;
      const weight = Number(edge.w) || 0;
      if (weight < minWeight) continue;
      filteredEdges.push(edge);
      weightMap.set(from, (weightMap.get(from) || 0) + weight);
      weightMap.set(to, (weightMap.get(to) || 0) + weight);
    }
  }

  for (const [token, entry] of state.tokenSources.entries()) {
    if (!nodes.has(token)) continue;
    let base = 0;
    if (entry?.input) base += 1.0;
    if (entry?.output) base += 0.6;
    if (entry?.committed) base += 0.3;
    if (base > 0) {
      weightMap.set(token, (weightMap.get(token) || 0) + base);
    }
  }

  const removalSet = new Set();
  const orderedTokens = Array.from(nodes.keys());

  for (const token of orderedTokens) {
    if (removalSet.has(token)) continue;
    const weight = weightMap.get(token) || 0;
    if (weight > 0) continue;
    const entry = state.tokenSources.get(token);
    const active = !!(entry && (entry.input || entry.output || entry.committed));
    if (!active && nodes.size - removalSet.size > 1) {
      removalSet.add(token);
    }
  }

  let remaining = nodes.size - removalSet.size;
  if (maxTokens > 0 && remaining > maxTokens) {
    const candidates = orderedTokens.filter(token => !removalSet.has(token));
    candidates.sort((a, b) => {
      const weightA = weightMap.get(a) || 0;
      const weightB = weightMap.get(b) || 0;
      if (weightA !== weightB) return weightA - weightB;
      const idxA = state.tokenOrder.indexOf(a);
      const idxB = state.tokenOrder.indexOf(b);
      const normA = idxA === -1 ? Number.MAX_SAFE_INTEGER : idxA;
      const normB = idxB === -1 ? Number.MAX_SAFE_INTEGER : idxB;
      if (normA !== normB) return normA - normB;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    const excess = remaining - maxTokens;
    for (let i = 0; i < excess && i < candidates.length; i += 1) {
      removalSet.add(candidates[i]);
    }
    remaining -= Math.min(excess, candidates.length);
  }

  if (removalSet.size) {
    for (const token of removalSet) {
      nodes.delete(token);
    }
  }

  const finalEdges = filteredEdges.filter(edge => nodes.has(edge.from) && nodes.has(edge.to));

  for (const node of nodes.values()) {
    node.degree = 0;
  }
  for (const edge of finalEdges) {
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (fromNode) fromNode.degree = (fromNode.degree || 0) + 1;
    if (toNode) toNode.degree = (toNode.degree || 0) + 1;
  }

  if (removalSet.size) {
    for (const token of removalSet) {
      state.tokenSources.delete(token);
    }
    state.tokenOrder = state.tokenOrder.filter(token => state.tokenSources.has(token));
  }

  return { edges: finalEdges, removedTokens: Array.from(removalSet) };
}

function setInputPreviewTokens(tokens, options = {}) {
  const { render = true } = options;
  const normalized = normalizeTokenList(tokens);
  const previewSet = new Set(normalized);
  for (const [token, entry] of state.tokenSources.entries()) {
    entry.input = previewSet.has(token);
  }
  for (const token of normalized) {
    const entry = ensureTokenEntry(token);
    if (entry) entry.input = true;
  }
  if (render) rebuildLiveGraph();
}

function commitTokens(tokens, options = {}) {
  const { render = true } = options;
  const normalized = normalizeTokenList(tokens);
  for (const token of normalized) {
    const entry = ensureTokenEntry(token);
    if (!entry) continue;
    entry.committed = true;
    entry.input = false;
  }
  if (render) rebuildLiveGraph();
}

function addOutputTokens(tokens, options = {}) {
  const { render = true } = options;
  const normalized = normalizeTokenList(tokens);
  if (!normalized.length) return;
  for (const token of normalized) {
    const entry = ensureTokenEntry(token);
    if (entry) entry.output = true;
  }
  if (render) rebuildLiveGraph();
}

function tokensFromCompletedInput(text) {
  if (!text) return [];
  const hasTrailingSpace = /\s$/.test(text);
  const portion = hasTrailingSpace ? text : text.replace(/\S+$/, ' ');
  return tokenize(portion);
}

let previewPreloadTimer = null;
let lastPreviewPreloadKey = '';

function schedulePreviewTokenPreload(tokens) {
  const normalized = normalizeTokenList(tokens);
  if (!normalized.length) {
    lastPreviewPreloadKey = '';
    if (previewPreloadTimer) {
      clearTimeout(previewPreloadTimer);
      previewPreloadTimer = null;
    }
    return;
  }
  const key = normalized.join('|');
  if (key === lastPreviewPreloadKey) return;
  lastPreviewPreloadKey = key;
  if (previewPreloadTimer) {
    clearTimeout(previewPreloadTimer);
    previewPreloadTimer = null;
  }
  previewPreloadTimer = setTimeout(async () => {
    previewPreloadTimer = null;
    try {
      if (window.HLSF?.remoteDb?.isReady?.() && typeof window.HLSF.remoteDb.preloadTokens === 'function') {
        await window.HLSF.remoteDb.preloadTokens(normalized);
      }
    } catch (err) {
      console.warn('Preview token preload failed:', err);
    }
  }, 180);
}

function handleLiveInputChange(text) {
  const previewTokens = tokensFromCompletedInput(text);
  setInputPreviewTokens(previewTokens);
  schedulePreviewTokenPreload(previewTokens);
}

function integrateCommittedTokens(tokens, options = {}) {
  const normalized = normalizeTokenList(tokens);
  if (!normalized.length) return;

  addConversationTokens(normalized);

  const opts = typeof options === 'object' && options !== null ? options : {};
  const render = opts.render === true;
  const immediate = opts.immediate === true;
  const reason = typeof opts.reason === 'string' && opts.reason.trim()
    ? opts.reason.trim()
    : (opts.source === 'voice' ? 'prompt-voice' : 'prompt-preload');

  if (render) {
    queueLiveGraphUpdate(immediate ? 32 : 96);
  }

  if (typeof window === 'undefined') return;

  const remote = window?.HLSF?.remoteDb;
  if (!remote
    || typeof remote.isReady !== 'function'
    || !remote.isReady()
    || typeof remote.preloadTokens !== 'function') {
    return;
  }

  try {
    const preloadResult = remote.preloadTokens(normalized);
    if (!preloadResult || typeof preloadResult.then !== 'function') return;
    preloadResult
      .then(stats => {
        const loaded = Number(stats?.loaded) || 0;
        const hits = Number(stats?.hits) || 0;
        if (loaded + hits > 0) {
          notifyHlsfAdjacencyChange(reason, { immediate: true });
        } else if (render) {
          queueLiveGraphUpdate(immediate ? 32 : 120);
        }
      })
      .catch(err => {
        console.warn('Remote adjacency preload failed for committed tokens:', err);
      });
  } catch (err) {
    console.warn('Unable to schedule remote adjacency preload:', err);
  }
}

function commitInputTokensFromText(text, options = {}) {
  const committedTokens = tokenize(text || '');
  if (!committedTokens.length) return committedTokens;
  const opts = typeof options === 'object' && options !== null ? options : {};
  const render = opts.render === true;
  commitTokens(committedTokens, { render });
  integrateCommittedTokens(committedTokens, opts);
  return committedTokens;
}

function getSessionPromptLog() {
  if (!Array.isArray(Session.prompts)) {
    Session.prompts = [];
  }
  return Session.prompts;
}

function recordSessionPrompt(text, context = {}) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) return;

  const entry = {
    text: normalized,
    timestamp: new Date().toISOString(),
  };

  if (context && typeof context === 'object') {
    const meta = {};
    for (const [key, value] of Object.entries(context)) {
      if (value == null) continue;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) continue;
        meta[key] = trimmed;
      } else if (typeof value === 'number') {
        if (Number.isFinite(value)) meta[key] = value;
      } else if (typeof value === 'boolean') {
        meta[key] = value;
      } else if (Array.isArray(value)) {
        if (value.length > 0) meta[key] = value;
      }
    }
    if (Object.keys(meta).length > 0) {
      entry.meta = meta;
    }
  }

  const log = getSessionPromptLog();
  log.push(entry);
  const limit = Math.max(0, Number(CONFIG?.PROMPT_LOG_LIMIT) || 0);
  if (limit && log.length > limit) {
    log.splice(0, log.length - limit);
  }
}

function onUserPromptSubmitted(text) {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  addConversationTokens(toks);
  recordSessionPrompt(text, {
    source: 'prompt',
    tokenCount: toks.length,
  });
}

function formatCurrency(amountUsd) {
  if (!amountUsd || isNaN(amountUsd)) return '$0.0000';
  const abs = Math.abs(amountUsd);
  if (abs > 0 && abs < 0.0001) {
    return amountUsd < 0 ? '-<$0.0001' : '<$0.0001';
  }
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  const prefix = amountUsd < 0 ? '-$' : '$';
  return `${prefix}${Math.abs(amountUsd).toFixed(decimals)}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return '<1s';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function getDocumentCacheBaseline() {
  return Number.isFinite(state.documentCacheBaseline)
    ? Math.max(0, state.documentCacheBaseline)
    : 0;
}

function setDocumentCacheBaseline(value, options = {}) {
  const manual = options?.manual === true;
  const normalized = Number.isFinite(value) ? Math.max(0, value) : getDocumentCacheBaseline();

  if (manual) {
    state.documentCacheBaseline = normalized;
    state.documentCacheBaselineManuallyCleared = normalized === 0;
    return state.documentCacheBaseline;
  }

  if (normalized > 0) {
    state.documentCacheBaseline = normalized;
    state.documentCacheBaselineManuallyCleared = false;
    return state.documentCacheBaseline;
  }

  const existing = getDocumentCacheBaseline();
  if (state.documentCacheBaselineManuallyCleared || existing === 0) {
    state.documentCacheBaseline = 0;
    return 0;
  }

  return existing;
}

function estimateRemoteTokenCount() {
  let total = 0;

  const remote = window.HLSF?.remoteDb;
  if (remote && typeof remote === 'object') {
    try {
      if (typeof remote.listTokens === 'function') {
        const tokens = remote.listTokens();
        if (Array.isArray(tokens) && tokens.length) {
          total = Math.max(total, tokens.length);
        }
      }
    } catch {
      // ignore remote token index errors
    }

    try {
      const meta = typeof remote.metadata === 'function' ? remote.metadata() : null;
      if (meta && typeof meta === 'object') {
        const declared = Number(meta.total_tokens);
        if (Number.isFinite(declared) && declared > 0) {
          total = Math.max(total, Math.floor(declared));
        }
        if (Array.isArray(meta.chunks) && meta.chunks.length) {
          let chunkTotal = 0;
          for (const chunk of meta.chunks) {
            const count = Number(chunk?.token_count);
            if (Number.isFinite(count) && count > 0) {
              chunkTotal += Math.floor(count);
            }
          }
          if (chunkTotal > 0) {
            total = Math.max(total, chunkTotal);
          }
        }
      }
    } catch {
      // ignore metadata access errors
    }
  }

  const metricTokens = Number(window.HLSF?.metrics?.db?.tokens);
  if (Number.isFinite(metricTokens) && metricTokens > 0) {
    total = Math.max(total, Math.floor(metricTokens));
  }

  return total;
}

function getCachedTokenCount() {
  const cachedKeys = safeStorageKeys(TOKEN_CACHE_PREFIX).length;
  if (cachedKeys > 0) return cachedKeys;

  let index = safeStorageGet(DB_INDEX_KEY, []);
  if (typeof index === 'string') {
    try { index = JSON.parse(index); }
    catch { index = []; }
  }
  if (Array.isArray(index) && index.length) {
    return index.length;
  }

  const db = getDb();
  if (db && Array.isArray(db.full_token_data)) {
    return db.full_token_data.length;
  }

  const remoteCount = estimateRemoteTokenCount();
  if (remoteCount > 0) {
    return remoteCount;
  }

  const baseline = getDocumentCacheBaseline();
  if (baseline > 0 && !state.documentCacheBaselineManuallyCleared) {
    return baseline;
  }

  return 0;
}

function listCachedTokens(limit = CONFIG.CACHE_SEED_LIMIT || 0) {
  let index = safeStorageGet(DB_INDEX_KEY, []);
  if (typeof index === 'string') {
    try { index = JSON.parse(index); }
    catch { index = []; }
  }

  const tokens = [];
  if (Array.isArray(index) && index.length) {
    tokens.push(...index);
  }

  if (!tokens.length) {
    const db = getDb();
    if (db && Array.isArray(db.full_token_data)) {
      for (const record of db.full_token_data) {
        if (record?.token) tokens.push(record.token);
      }
    }
  }

  if (!tokens.length) {
    const cacheKeys = safeStorageKeys(TOKEN_CACHE_PREFIX);
    for (const key of cacheKeys) {
      const token = key.slice(TOKEN_CACHE_PREFIX.length);
      if (token) tokens.push(token);
    }
  }

  const seen = new Set();
  const deduped = [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
  for (const token of tokens) {
    const key = (token == null ? '' : String(token)).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(token);
    if (deduped.length >= cap) break;
  }

  return deduped;
}

let pendingHlsfReloadTimer = null;
let hlsfReloadInFlight = false;
let pendingHlsfReloadAfterFlight = false;
let lastQueuedHlsfReason = '';

function markHlsfDataDirty() {
  window.HLSF = window.HLSF || {};
  window.HLSF.matrices = null;
  window.HLSF.layoutCache = null;
  window.HLSF.indexCache = null;
  window.HLSF.indexCacheSource = null;
  state.hlsfReady = false;
}

function scheduleHlsfReload(reason = 'cache-update', options = {}) {
  const { immediate = false, debounceMs = 400 } = options || {};
  if (reason) {
    lastQueuedHlsfReason = reason;
  }

  const trigger = () => {
    pendingHlsfReloadTimer = null;
    if (hlsfReloadInFlight) {
      pendingHlsfReloadAfterFlight = true;
      if (reason) lastQueuedHlsfReason = reason;
      return;
    }

    const finalize = () => {
      hlsfReloadInFlight = false;
      HlsfLoading.hide(0);
      if (pendingHlsfReloadAfterFlight) {
        pendingHlsfReloadAfterFlight = false;
        const queuedReason = lastQueuedHlsfReason || reason || 'queued-refresh';
        lastQueuedHlsfReason = '';
        scheduleHlsfReload(queuedReason, { immediate: true });
        return;
      }
      lastQueuedHlsfReason = '';
    };

    try {
      const last = window.HLSF?.lastCommand;
      const cachedCount = getCachedTokenCount();
      const dbCount = Array.isArray(window.HLSF?.dbCache?.full_token_data)
        ? window.HLSF.dbCache.full_token_data.length
        : 0;
      let task = null;

      const hasLiveTokens = Array.isArray(state.tokenOrder) && state.tokenOrder.length > 0;
      if (!dbCount && hasLiveTokens) {
        rebuildLiveGraph();
        finalize();
        return;
      }

      if (last && last.metricScope !== METRIC_SCOPE.DB && Array.isArray(last.anchors) && last.anchors.length) {
        task = rebuildHlsfFromLastCommand(true);
      } else if (last) {
        const args = typeof last.rawArgs === 'string' ? last.rawArgs : '';
        task = runHlsfSafely(args);
      } else if (cachedCount > 0 || dbCount > 0) {
        task = runHlsfSafely('');
      } else {
        stopHLSFAnimation();
        hideVisualizer();
        if (window.HLSF) {
          window.HLSF.currentGraph = null;
          window.HLSF.currentGlyphOnly = false;
        }
        finalize();
        return;
      }

      if (!task || typeof task.then !== 'function') {
        finalize();
        return;
      }

      hlsfReloadInFlight = true;
      task.then(finalize).catch(err => {
        console.warn('Auto HLSF reload failed:', err);
        finalize();
      });
    } catch (err) {
      console.warn('Failed to refresh HLSF after cache update:', err);
    }
  };

  if (pendingHlsfReloadTimer) {
    clearTimeout(pendingHlsfReloadTimer);
    pendingHlsfReloadTimer = null;
  }

  if (immediate) {
    trigger();
  } else {
    const delay = Number.isFinite(debounceMs) ? Math.max(0, debounceMs) : 400;
    pendingHlsfReloadTimer = setTimeout(trigger, delay);
  }
}

function shouldForceHlsfReload(reason) {
  const label = typeof reason === 'string' ? reason.toLowerCase() : '';
  if (!label) return false;
  if (label.startsWith('prompt')) return true;
  if (label.includes('mental-state')) return true;
  if (label.includes('database') || label.includes('db')) return true;
  if (label.includes('document')) return true;
  if (label === 'cache-update' || label === 'manual-cache' || label === 'hidden-token-sweep') return true;
  return false;
}

function notifyHlsfAdjacencyChange(reason = 'cache-update', options = {}) {
  markHlsfDataDirty();
  const normalizedReason = typeof reason === 'string' ? reason.toLowerCase() : '';
  const isPromptReason = normalizedReason.startsWith('prompt');
  if (isPromptReason) {
    forcePromptLiveGraphPruning();
  }
  const forceReload = shouldForceHlsfReload(normalizedReason);
  const shouldAutoReload = forceReload || window.HLSF?.config?.autoHlsfOnChange === true;
  if (shouldAutoReload) {
    const reloadOptions = forceReload ? { ...options, immediate: true } : options;
    scheduleHlsfReload(reason, reloadOptions);
    return;
  }
  if (normalizedReason) {
    if (isPromptReason) {
      queueLiveGraphUpdate(60);
      return;
    }
    if (normalizedReason === 'cache-update' || normalizedReason === 'manual-cache') {
      queueLiveGraphUpdate(180);
      return;
    }
  }
  queueLiveGraphUpdate(200);
}

// ============================================
// COMPLEX NUMBER ENCODING & GLYPH SYSTEM
// ============================================

// Convert token to complex number representation
// Magnitude = attention score, Phase = semantic hash
function tokenToComplexNumber(token, tokenData) {
  const attentionScore = tokenData?.attention_score || 0.5;
  const magnitude = attentionScore; // 0.0 to 1.0

  // Generate phase from token's semantic properties
  let phaseHash = 0;
  for (let i = 0; i < token.length; i++) {
    phaseHash = ((phaseHash << 5) - phaseHash) + token.charCodeAt(i);
    phaseHash = phaseHash & phaseHash;
  }

  // Normalize phase to 0-2π
  const phase = (Math.abs(phaseHash) % 360) * (Math.PI / 180);

  // Calculate real and imaginary parts
  const real = magnitude * Math.cos(phase);
  const imaginary = magnitude * Math.sin(phase);

  return { real, imaginary, magnitude, phase };
}

const memoizedComplexNumber = (() => {
  const cache = new Map();
  return (token, tokenData) => {
    const score = tokenData?.attention_score ?? 0;
    const key = `${token}_${score}`;
    if (cache.has(key)) return cache.get(key);
    const result = tokenToComplexNumber(token, tokenData);
    cache.set(key, result);
    return result;
  };
})();

// Map complex number to glyph from library
function complexToGlyph(complex) {
  // Use magnitude and phase to select glyph
  const magnitudeIndex = Math.floor(complex.magnitude * 7); // 0-7 range
  const phaseIndex = Math.floor((complex.phase / (2 * Math.PI)) * 10); // 0-9 range
  const glyphIndex = (magnitudeIndex * 10 + phaseIndex) % GLYPH_LIBRARY.length;
  return GLYPH_LIBRARY[glyphIndex];
}

// Generate glyph ledger for all cached tokens
function generateGlyphLedger() {
  const ledger = new Map();
  const reverseMap = new Map(); // glyph -> tokens
  const keys = safeStorageKeys(TOKEN_CACHE_PREFIX);

  for (const key of keys) {
    try {
      const tokenData = safeStorageGet(key);
      if (!tokenData?.token) continue;
      const token = tokenData.token;
      const complex = memoizedComplexNumber(token, tokenData);
      const glyph = complexToGlyph(complex);

      ledger.set(token, {
        glyph,
        complex: {
          real: complex.real.toFixed(4),
          imaginary: complex.imaginary.toFixed(4),
          magnitude: complex.magnitude.toFixed(4),
          phase: complex.phase.toFixed(4)
        },
        attention_score: tokenData.attention_score || 0
      });

      // Track consolidation - multiple tokens per glyph
      if (!reverseMap.has(glyph)) {
        reverseMap.set(glyph, []);
      }
      reverseMap.get(glyph).push(token);
    } catch (err) {
      console.error('Failed to process token:', key, err);
    }
  }

  return { ledger, reverseMap };
}

// Consolidate similar tokens to same glyph
function findConsolidatedTokens(reverseMap) {
  const consolidated = [];
  for (const [glyph, tokens] of reverseMap.entries()) {
    if (tokens.length > 1) {
      consolidated.push({ glyph, tokens, count: tokens.length });
    }
  }
  return consolidated.sort((a, b) => b.count - a.count);
}

// Encode message using glyph ledger
function encodeMessage(message, ledger) {
  const tokens = tokenize(message);
  const encoded = [];
  const unknown = [];

  for (const token of tokens) {
    const entry = ledger.get(token);
    if (entry) {
      encoded.push(entry.glyph);
    } else {
      encoded.push('◌'); // Unknown token marker
      unknown.push(token);
    }
  }

  return {
    encoded: encoded.join(''),
    coverage: ((tokens.length - unknown.length) / tokens.length * 100).toFixed(1),
    unknown
  };
}

// Decode message using reverse glyph map
function decodeMessage(encoded, reverseMap) {
  const glyphs = Array.from(encoded);
  const decoded = [];

  for (const glyph of glyphs) {
    const tokens = reverseMap.get(glyph);
    if (tokens && tokens.length > 0) {
      // Use first token (could use most common or context-aware selection)
      decoded.push(tokens[0]);
    } else {
      decoded.push('[?]');
    }
  }

  return decoded.join(' ');
}

// Export glyph ledger for inter-system transmission
function exportGlyphLedger() {
  const { ledger, reverseMap } = generateGlyphLedger();
  const consolidated = findConsolidatedTokens(reverseMap);

  const exportData = {
    export_timestamp: new Date().toISOString(),
    ledger_version: "1.0",
    description: "HLSF Symbolic Glyph Encryption Ledger - Complex Number Token Encoding",
    specification: {
      encoding: "Complex numbers (magnitude=attention, phase=semantic_hash)",
      glyph_library_size: GLYPH_LIBRARY.length,
      representation: "Unicode symbolic glyphs",
      consolidation: "Similar tokens map to same glyph based on complex number proximity"
    },
    statistics: {
      total_tokens: ledger.size,
      unique_glyphs: reverseMap.size,
      consolidation_ratio: (ledger.size / reverseMap.size).toFixed(2),
      consolidated_groups: consolidated.length
    },
    glyph_ledger: Object.fromEntries(ledger),
    reverse_mapping: Object.fromEntries(
      Array.from(reverseMap.entries()).map(([glyph, tokens]) => [glyph, tokens])
    ),
    consolidated_tokens: consolidated,
    encryption_examples: generateEncryptionExamples(ledger, reverseMap)
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `HLSF_Glyph_Ledger_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return exportData;
}

window.GlyphSystem = window.GlyphSystem || {};
window.GlyphSystem.ledger = null;
window.GlyphSystem.encode = function encode(message) {
  const result = encryptTextToGlyphs(message || '');
  window.GlyphSystem.ledger = loadLedger();
  return { encoded: result.encrypted, coverage: result.coverage, unknown: result.unknown };
};
window.GlyphSystem.decode = function decode(encoded) {
  return decryptGlyphsToText(encoded || '');
};
window.GlyphSystem.export = function exportLedgerSnapshot() {
  return loadLedger();
};

function generateEncryptionExamples(ledger, reverseMap) {
  const examples = [
    "hello world",
    "consciousness",
    "quantum entanglement"
  ];

  return examples.map(msg => {
    const result = encodeMessage(msg, ledger);
    return {
      plaintext: msg,
      encoded: result.encoded,
      coverage: result.coverage + '%',
      decoded: decodeMessage(result.encoded, reverseMap)
    };
  });
}

function showGlyphLedger() {
  const { ledger, reverseMap } = generateGlyphLedger();
  const consolidated = findConsolidatedTokens(reverseMap);

  // Show sample encoded messages
  const sampleMessages = [
    "What is consciousness?",
    "Explain quantum mechanics",
    "The nature of reality"
  ];

  const encodedSamples = sampleMessages.map(msg => {
    const result = encodeMessage(msg, ledger);
    return {
      original: msg,
      encoded: result.encoded,
      coverage: result.coverage,
      decoded: decodeMessage(result.encoded, reverseMap)
    };
  });

  addLog(`
    <div class="section-divider"></div>
    <div class="section-title">🔐 Symbolic Glyph Encryption Ledger</div>

    <div class="adjacency-insight">
      <strong>📐 Complex Number Encoding:</strong><br>
      • Each token → Complex number (magnitude + phase)<br>
      • Magnitude = Attention score (0.0-1.0)<br>
      • Phase = Semantic hash (0-2π radians)<br>
      • Glyph = Visual representation of complex coordinates
    </div>

    <div class="adjacency-insight">
      <strong>📊 Ledger Statistics:</strong><br>
      • Total tokens: <strong>${ledger.size}</strong><br>
      • Unique glyphs: <strong>${reverseMap.size}</strong><br>
      • Consolidation ratio: <strong>${(ledger.size / reverseMap.size).toFixed(2)}:1</strong><br>
      • Efficiency gain: <strong>${(100 - (reverseMap.size / ledger.size * 100)).toFixed(1)}%</strong>
    </div>

    <div class="adjacency-insight">
      <strong>🔄 Token Consolidation (Similar tokens → Same glyph):</strong><br>
      ${consolidated.slice(0, 5).map(c => 
        `• <span style="font-size: 1.5em;">${c.glyph}</span> → ${c.tokens.slice(0, 3).join(', ')}${c.tokens.length > 3 ? '...' : ''} (${c.count} tokens)`
      ).join('<br>')}
      ${consolidated.length === 0 ? '<em>No consolidation yet - need more diverse tokens</em>' : ''}
    </div>

    <div class="adjacency-insight">
      <strong>🔐 Encrypted Message Examples:</strong><br>
      ${encodedSamples.map(s => `
        <div style="margin: 0.75rem 0; padding: 0.5rem; background: rgba(0,0,0,0.3); border-radius: 6px;">
          <div style="opacity: 0.7; font-size: 0.85em;">Original:</div>
          <div style="margin: 0.25rem 0;">${s.original}</div>
          <div style="opacity: 0.7; font-size: 0.85em; margin-top: 0.5rem;">Encrypted (${s.coverage}% coverage):</div>
          <div style="font-size: 1.3em; letter-spacing: 0.1em; color: var(--accent); margin: 0.25rem 0;">${s.encoded}</div>
          <div style="opacity: 0.7; font-size: 0.85em; margin-top: 0.5rem;">Decoded:</div>
          <div style="margin: 0.25rem 0;">${s.decoded}</div>
        </div>
      `).join('')}
    </div>

    <details>
      <summary>📖 View full glyph mapping (first 20 tokens)</summary>
      <pre>${JSON.stringify(
        Object.fromEntries(Array.from(ledger.entries()).slice(0, 20)),
        null, 2
      )}</pre>
    </details>

    <div style="margin-top: 1rem; padding: 0.75rem; background: rgba(0,255,136,0.05); border-radius: 8px; font-size: 0.9rem;">
      💡 <strong>Usage:</strong> This ledger enables secure inter-system communication. 
      Messages encoded with glyphs can be transmitted efficiently and decoded by any system 
      with the same ledger. The consolidation reduces message size while maintaining semantic meaning.
    </div>
  `);
}

// ============================================
// LOGGING
// ============================================
function batchLogUpdates(entries) {
  if (!(elements.log instanceof HTMLElement)) {
    return;
  }
  const fragment = document.createDocumentFragment();
  entries.forEach(entry => fragment.appendChild(entry));
  elements.log.appendChild(fragment);
  elements.log.scrollTop = elements.log.scrollHeight;
}

const LOG_TTS_SECTION_TARGETS = [
  { match: /document reflection/i, selector: '.thought-stream' },
  { match: /self-reflection/i, selector: '.thought-stream' },
  { match: /stream of consciousness/i, selector: 'pre' },
  { match: /structural summary/i, selector: 'pre' },
];

let activeTtsButton: HTMLButtonElement | null = null;
let activeTtsUtterance: SpeechSynthesisUtterance | null = null;

function canUseSpeechSynthesis() {
  return typeof window !== 'undefined'
    && typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance !== 'undefined';
}

function stopActiveSpeech() {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch (err) {
      console.warn('Unable to cancel speech synthesis:', err);
    }
  }
  if (activeTtsButton instanceof HTMLButtonElement) {
    activeTtsButton.dataset.ttsState = 'idle';
    activeTtsButton.classList.remove('is-playing');
    activeTtsButton.setAttribute('aria-pressed', 'false');
  }
  activeTtsButton = null;
  activeTtsUtterance = null;
}

function toggleTtsPlayback(button, text) {
  if (!(button instanceof HTMLButtonElement)) return;
  const spokenText = typeof text === 'string' ? text.trim() : '';
  if (!spokenText) return;
  if (!canUseSpeechSynthesis()) return;

  if (activeTtsButton === button && button.dataset.ttsState === 'playing') {
    stopActiveSpeech();
    return;
  }

  stopActiveSpeech();

  const synth = window.speechSynthesis;
  try {
    const utterance = new window.SpeechSynthesisUtterance(spokenText);
    activeTtsUtterance = utterance;
    activeTtsButton = button;
    button.dataset.ttsState = 'playing';
    button.classList.add('is-playing');
    button.setAttribute('aria-pressed', 'true');
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onend = () => {
      if (activeTtsUtterance === utterance) {
        stopActiveSpeech();
      }
    };
    utterance.onerror = () => {
      if (activeTtsUtterance === utterance) {
        stopActiveSpeech();
      }
    };
    synth.cancel();
    synth.speak(utterance);
  } catch (err) {
    console.warn('Speech synthesis failed:', err);
    stopActiveSpeech();
  }
}

function createTtsButton(getText) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tts-button';
  button.innerText = '🔊';
  button.title = 'Play synthesized narration';
  button.setAttribute('aria-label', 'Play synthesized narration');
  button.setAttribute('aria-pressed', 'false');
  button.dataset.ttsState = 'idle';
  if (!canUseSpeechSynthesis()) {
    button.disabled = true;
  }
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canUseSpeechSynthesis()) return;
    const value = typeof getText === 'function' ? getText() : '';
    toggleTtsPlayback(button, value);
  });
  return button;
}

function findSectionNarrationTarget(titleEl, selector) {
  if (!(titleEl instanceof HTMLElement)) return null;
  let node = titleEl.nextElementSibling;
  while (node) {
    if (node instanceof HTMLElement && node.matches(selector)) {
      return node;
    }
    node = node.nextElementSibling;
  }
  const parent = titleEl.parentElement;
  if (parent) {
    const fallback = parent.querySelector(selector);
    if (fallback instanceof HTMLElement) {
      return fallback;
    }
  }
  return null;
}

function attachTtsButtons(entry) {
  if (!(entry instanceof HTMLElement)) return;
  const titles = entry.querySelectorAll('.section-title');
  if (!titles.length) return;
  titles.forEach((titleEl) => {
    const titleText = (titleEl.textContent || '').trim();
    if (!titleText) return;
    const config = LOG_TTS_SECTION_TARGETS.find(target => target.match.test(titleText));
    if (!config) return;
    if (titleEl.querySelector('.tts-button')) return;
    const target = findSectionNarrationTarget(titleEl, config.selector);
    if (!target) return;
    const narration = (target.textContent || '').trim();
    if (!narration) return;
    const button = createTtsButton(() => target.textContent || '');
    titleEl.appendChild(button);
  });
}

function enhanceLogEntry(entry) {
  attachTtsButtons(entry);
}

function printStartupBanner(): void {
  addLog(`
    <div class="startup-banner">
      <strong>HLSF Cognition Engine</strong><br/>
      Type a prompt to build adjacencies & render the HLSF graph.<br/>
      Try <code>/help</code> for available commands. Examples:
      <code>/hlsf</code>, <code>/database</code>, <code>/stats</code>, <code>/reset</code>.
    </div>
  `);
}

function addLog(content, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<div class="timestamp">${new Date().toLocaleTimeString()}</div>${content}`;
  enhanceLogEntry(entry);
  batchLogUpdates([entry]);
  return entry;
}

function appendLog(msg, type = 'info') {
  if (typeof msg === 'string') return addLog(msg, type);
  return addLog(sanitize(String(msg)), type);
}

function logStatus(msg) {
  return appendLog(`<div class="processing-indicator"><span class="spinner"></span>${sanitize(msg)}</div>`, 'status');
}
function logError(msg) { return appendLog(`🔴 ${sanitize(msg)}`, 'error'); }
window.logOK = (msg) => addLog(`✅ ${sanitize(String(msg))}`, 'success');
function logWarning(msg) { return appendLog(`⚠️ ${sanitize(msg)}`, 'warning'); }
function logFinal(msg) { return appendLog(`✅ ${sanitize(msg)}`, 'success'); }

const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now()
  : Date.now());

const RealtimeStatus = (() => {
  const activeStatuses = new Set();
  let intervalId = null;

  const scheduleTick = () => {
    if (intervalId != null) return;
    intervalId = setInterval(() => {
      const current = nowMs();
      activeStatuses.forEach((status: any) => {
        try {
          if (typeof status.render === 'function') status.render(current);
        } catch (err) {
          console.warn('Realtime status render failed:', err);
        }
      });
      if (activeStatuses.size === 0 && intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }, 500);
  };

  const register = (status: any) => {
    activeStatuses.add(status);
    scheduleTick();
  };

  const unregister = (status: any) => {
    activeStatuses.delete(status);
    if (activeStatuses.size === 0 && intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const create = (label: string, options: Record<string, unknown> = {}) => {
    const resolvedLabel = typeof label === 'string' && label.trim() ? label.trim() : 'Processing';
    const icon = typeof options.icon === 'string' && options.icon.trim() ? options.icon.trim() : '⏳';
    const entry = logStatus(`${resolvedLabel}…`);
    const indicator = entry?.querySelector?.('.processing-indicator');
    if (!(indicator instanceof HTMLElement)) {
      return {
        element: entry,
        update() {},
        render() {},
        complete() {},
        fail(message?: string) { if (message) logWarning(message); },
        cancel(message?: string) { if (message) logWarning(message); },
        isActive: () => false,
      };
    }

    const statusState = {
      entry,
      indicator,
      label: resolvedLabel,
      icon,
      createdAt: nowMs(),
      info: {
        queueLength: 0,
        pendingWorkUnits: 0,
        pendingChunks: 0,
        averageMsPerUnit: 0,
        activeStart: null as number | null,
        activeWorkUnits: 0,
        extraDetails: '',
      },
      completed: false,
    };

    const render = (current = nowMs()) => {
      if (statusState.completed) return;
      const elapsed = Math.max(0, current - statusState.createdAt);

      let etaMs: number | null = null;
      if (statusState.info.averageMsPerUnit > 0 && statusState.info.pendingWorkUnits > 0) {
        const activeStart = typeof statusState.info.activeStart === 'number' ? statusState.info.activeStart : null;
        const activeWork = Math.max(0, statusState.info.activeWorkUnits || 0);
        let consumedWork = 0;
        if (activeStart != null && activeWork > 0) {
          const activeElapsed = Math.max(0, current - activeStart);
          consumedWork = Math.min(activeWork, activeElapsed / statusState.info.averageMsPerUnit);
        }
        const remainingWork = Math.max(0, statusState.info.pendingWorkUnits - consumedWork);
        etaMs = remainingWork * statusState.info.averageMsPerUnit;
      }

      const parts: string[] = [`${statusState.icon} ${statusState.label}`];
      if (statusState.info.queueLength > 0) {
        const queueLabel = statusState.info.queueLength === 1 ? 'update' : 'updates';
        parts.push(`${statusState.info.queueLength} ${queueLabel}`);
      }
      if (statusState.info.pendingChunks > 0) {
        const chunkLabel = statusState.info.pendingChunks === 1 ? 'chunk' : 'chunks';
        parts.push(`${statusState.info.pendingChunks} ${chunkLabel}`);
      }
      if (etaMs != null && etaMs > 0) {
        parts.push(`ETA ${formatDuration(etaMs)}`);
      }
      parts.push(`elapsed ${formatDuration(elapsed)}`);
      if (statusState.info.extraDetails) parts.push(statusState.info.extraDetails);

      statusState.indicator.innerHTML = `<span class="spinner"></span>${sanitize(parts.join(' • '))}`;
    };

    const status = {
      element: entry,
      update(info: Record<string, unknown> = {}) {
        const normalizeNumber = (value: unknown, fallback: number) => (
          Number.isFinite(value)
            ? Math.max(0, Number(value))
            : fallback
        );

        statusState.info.queueLength = normalizeNumber(info.queueLength, statusState.info.queueLength);
        statusState.info.pendingWorkUnits = normalizeNumber(info.pendingWorkUnits, statusState.info.pendingWorkUnits);
        statusState.info.pendingChunks = normalizeNumber(info.pendingChunks, statusState.info.pendingChunks);
        if (Number.isFinite(info.averageMsPerUnit)) {
          statusState.info.averageMsPerUnit = Math.max(0, Number(info.averageMsPerUnit));
        }
        if (info.activeStart == null) {
          statusState.info.activeStart = null;
        } else if (Number.isFinite(info.activeStart)) {
          statusState.info.activeStart = Number(info.activeStart);
        }
        statusState.info.activeWorkUnits = normalizeNumber(info.activeWorkUnits, statusState.info.activeWorkUnits);
        if (typeof info.extraDetails === 'string' && info.extraDetails.trim()) {
          statusState.info.extraDetails = info.extraDetails.trim();
        }
        render();
      },
      render,
      complete(opts: { summary?: string } = {}) {
        if (statusState.completed) return;
        statusState.completed = true;
        unregister(status);
        const totalElapsed = Math.max(0, nowMs() - statusState.createdAt);
        const summary = typeof opts.summary === 'string' && opts.summary.trim()
          ? opts.summary.trim()
          : `${statusState.label} complete`;
        statusState.entry.classList.remove('status');
        statusState.entry.classList.add('success');
        statusState.indicator.classList.remove('processing-indicator');
        statusState.indicator.innerHTML = sanitize(`✅ ${summary} (${formatDuration(totalElapsed)}).`);
      },
      fail(message?: string) {
        if (statusState.completed) return;
        statusState.completed = true;
        unregister(status);
        const totalElapsed = Math.max(0, nowMs() - statusState.createdAt);
        const summary = message && String(message).trim() ? String(message).trim() : `${statusState.label} failed`;
        statusState.entry.classList.remove('status');
        statusState.entry.classList.add('error');
        statusState.indicator.classList.remove('processing-indicator');
        statusState.indicator.innerHTML = sanitize(`🔴 ${summary} (${formatDuration(totalElapsed)}).`);
      },
      cancel(message?: string) {
        if (statusState.completed) return;
        statusState.completed = true;
        unregister(status);
        const totalElapsed = Math.max(0, nowMs() - statusState.createdAt);
        const summary = message && String(message).trim() ? String(message).trim() : `${statusState.label} cancelled`;
        statusState.entry.classList.remove('status');
        statusState.entry.classList.add('warning');
        statusState.indicator.classList.remove('processing-indicator');
        statusState.indicator.innerHTML = sanitize(`⚠️ ${summary} (${formatDuration(totalElapsed)}).`);
      },
      isActive: () => !statusState.completed,
    };

    register(status);
    render();
    return status;
  };

  return { create };
})();

function debounce(fn, delay) {
  let timeout;
  return function debounced(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

async function safeAsync(fn, errorMsg, options = null) {
  const config = (options && typeof options === 'object') ? options : {};
  try {
    return await fn();
  } catch (err) {
    const message = err?.message || 'Unknown error';
    const isNetworkError = /network error/i.test(message) || message === 'Failed to fetch';

    if (isNetworkError) {
      state.networkOffline = true;
      state.lastNetworkErrorTime = Date.now();
      const shouldLogError = !config.dedupeNetworkError || !state.networkErrorNotified;
      if (shouldLogError) {
        logError(`${errorMsg}: ${message}`);
        console.error(errorMsg, err);
      }
      if (!state.networkErrorNotified) {
        logWarning('Network connection unavailable. Continuing in offline mode; live synthesis may be limited.');
        state.networkErrorNotified = true;
      }
      return config.fallbackValue ?? null;
    }

    logError(`${errorMsg}: ${message}`);
    console.error(errorMsg, err);
    return config.fallbackValue ?? null;
  }
}

// ============================================
// CACHE BATCH TRACKING
// ============================================
const CacheBatch = (() => {
  const tracker = { depth: 0, baseline: 0, pendingTokens: new Set(), listeners: new Set() };

  const normalizeCount = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

  function begin(options = {}) {
    if (tracker.depth === 0) {
      tracker.pendingTokens.clear();
      const hints = [];
      hints.push(normalizeCount(getDocumentCacheBaseline()));
      hints.push(normalizeCount(state.lastComputedCacheBase || 0));
      if (Number.isFinite(options.baseline)) hints.push(normalizeCount(options.baseline));
      if (Number.isFinite(options.snapshot)) {
        hints.push(normalizeCount(options.snapshot));
      } else {
        const raw = getCachedTokenCount();
        if (Number.isFinite(raw)) hints.push(normalizeCount(raw));
      }
      const baselineValue = hints.length ? Math.max(...hints) : 0;
      tracker.baseline = normalizeCount(baselineValue);
    }
    tracker.depth += 1;
    updateCachedTokenDisplay(state.lastComputedCacheBase || 0);
  }

  function record(token) {
    if (tracker.depth === 0) return;
    const normalized = (token == null ? '' : String(token)).toLowerCase();
    if (!normalized || tracker.pendingTokens.has(normalized)) return;
    tracker.pendingTokens.add(normalized);
    updateCachedTokenDisplay(state.lastComputedCacheBase || 0);
    if (tracker.listeners.size) {
      const original = token == null ? '' : String(token);
      tracker.listeners.forEach(listener => {
        try {
          listener(original);
        } catch (err) {
          console.warn('CacheBatch listener failed:', err);
        }
      });
    }
  }

  function end(options = {}) {
    if (tracker.depth === 0) return;
    tracker.depth -= 1;
    if (tracker.depth === 0) {
      const pending = tracker.pendingTokens.size;
      if (options.commit !== false) {
        const raw = getCachedTokenCount();
        const rawCount = normalizeCount(raw);
        const baseline = Math.max(tracker.baseline, normalizeCount(getDocumentCacheBaseline()));
        const finalTotal = Math.max(rawCount, baseline + pending);
        const existingBaseline = normalizeCount(getDocumentCacheBaseline());
        setDocumentCacheBaseline(Math.max(existingBaseline, finalTotal));
      }
      tracker.baseline = 0;
      tracker.pendingTokens.clear();
      updateStats();
    } else {
      updateCachedTokenDisplay(state.lastComputedCacheBase || 0);
    }
  }

  function listen(listener) {
    if (typeof listener !== 'function') return () => {};
    tracker.listeners.add(listener);
    return () => tracker.listeners.delete(listener);
  }

  function cancel() {
    tracker.depth = 0;
    tracker.baseline = 0;
    tracker.pendingTokens.clear();
    updateStats();
  }

  function isActive() { return tracker.depth > 0; }
  function getBaseline() { return tracker.baseline; }
  function getPending() { return tracker.pendingTokens.size; }
  function resolvedBase(baseCount) {
    return isActive() ? tracker.baseline : normalizeCount(baseCount);
  }
  function total(baseCount) {
    const base = resolvedBase(baseCount);
    return isActive() ? base + getPending() : base;
  }
  function format(baseCount) {
    const base = resolvedBase(baseCount);
    if (!isActive()) return String(base);
    return `${base} +${getPending()}`;
  }

  return { begin, end, cancel, record, isActive, getBaseline, getPending, resolvedBase, total, format, listen };
})();

const DEFAULT_REMOTE_DB_MIN_RELATION_WEIGHT = 0.1;
const REMOTE_DB_RELATION_WEIGHT_OVERRIDES = new Map([['seed-link', 0]]);

function resolveRemoteDbPruneThreshold(override) {
  if (Number.isFinite(override) && override >= 0) {
    return Math.max(0, Number(override));
  }
  if (typeof window !== 'undefined') {
    const config = window?.HLSF?.config || {};
    const candidates = [
      config.remoteDbPruneWeightMin,
      config.remoteDbMinRelationshipWeight,
      config.remoteDbPruneWeightThreshold,
    ];
    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric >= 0) {
        return Math.max(0, numeric);
      }
    }
  }
  return DEFAULT_REMOTE_DB_MIN_RELATION_WEIGHT;
}

function pruneRemoteRecordRelationships(record, options = {}) {
  if (!record || typeof record !== 'object') return false;
  const relationshipsSource = record.relationships;
  const relationships = relationshipsSource && typeof relationshipsSource === 'object'
    ? relationshipsSource
    : {};
  if (relationshipsSource !== relationships) {
    record.relationships = relationships;
  }

  const overrides = options.relationThresholds instanceof Map
    ? options.relationThresholds
    : REMOTE_DB_RELATION_WEIGHT_OVERRIDES;
  const defaultThreshold = resolveRemoteDbPruneThreshold(options.threshold);

  let changed = false;
  let totalEdges = 0;

  for (const rel of Object.keys(relationships)) {
    const edges = Array.isArray(relationships[rel]) ? relationships[rel] : null;
    const override = overrides.has(rel) ? overrides.get(rel) : undefined;
    const minWeight = Number.isFinite(override)
      ? Math.max(0, Number(override))
      : defaultThreshold;

    if (!edges || edges.length === 0) {
      if (relationships[rel] != null) {
        delete relationships[rel];
        changed = true;
      }
      continue;
    }

    let writeIndex = 0;
    let mutated = false;

    for (let i = 0; i < edges.length; i += 1) {
      const edge = edges[i];
      if (!edge || typeof edge.token !== 'string') {
        mutated = true;
        continue;
      }
      const token = edge.token.trim();
      if (!token) {
        mutated = true;
        continue;
      }
      const numericWeight = Number(edge.weight);
      if (!Number.isFinite(numericWeight) || numericWeight < minWeight) {
        mutated = true;
        continue;
      }
      if (edge.token !== token) {
        edge.token = token;
        mutated = true;
      }
      if (edge.weight !== numericWeight) {
        edge.weight = numericWeight;
        mutated = true;
      }
      if (writeIndex !== i) {
        edges[writeIndex] = edge;
        mutated = true;
      }
      writeIndex += 1;
    }

    if (writeIndex === 0) {
      delete relationships[rel];
      changed = true;
      continue;
    }

    if (writeIndex !== edges.length) {
      edges.length = writeIndex;
      mutated = true;
    }

    edges.sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
    if (mutated) changed = true;
    totalEdges += edges.length;
  }

  const relationKeys = Object.keys(relationships);
  if (record.total_relationships !== totalEdges) {
    record.total_relationships = totalEdges;
    changed = true;
  }

  if ('relationshipTypes' in record) {
    if (typeof record.relationshipTypes === 'number') {
      if (record.relationshipTypes !== relationKeys.length) {
        record.relationshipTypes = relationKeys.length;
        changed = true;
      }
    } else if (!Array.isArray(record.relationshipTypes)
      || record.relationshipTypes.length !== relationKeys.length
      || record.relationshipTypes.some((value, idx) => value !== relationKeys[idx])) {
      record.relationshipTypes = relationKeys.slice();
      changed = true;
    }
  }

  if ('relationship_types' in record) {
    if (typeof record.relationship_types === 'number') {
      if (record.relationship_types !== relationKeys.length) {
        record.relationship_types = relationKeys.length;
        changed = true;
      }
    } else if (!Array.isArray(record.relationship_types)
      || record.relationship_types.length !== relationKeys.length
      || record.relationship_types.some((value, idx) => value !== relationKeys[idx])) {
      record.relationship_types = relationKeys.slice();
      changed = true;
    }
  }

  return changed;
}

const RemoteDbRecorder = (() => {
  const STORAGE_KEY = 'HLSF_REMOTE_DB_CHUNKS_V1';
  const META_KEY = 'HLSF_REMOTE_DB_META_V1';
  const chunkMap = new Map();
  let lastGeneratedAt = null;

  const normalizeTokenKey = (token) => (token == null ? '' : String(token).toLowerCase());

  const prefixForToken = (token) => {
    const normalized = normalizeTokenKey(token);
    if (!normalized) return '_';
    const first = normalized.charAt(0);
    if (first >= 'a' && first <= 'z') return first;
    if (first >= '0' && first <= '9') return first;
    return '_';
  };

  const cloneRecord = (record) => {
    if (!record || typeof record !== 'object') return null;
    try {
      return JSON.parse(JSON.stringify(record));
    } catch (err) {
      const fallback = {};
      for (const [key, value] of Object.entries(record)) {
        if (value == null) continue;
        if (typeof value === 'object') {
          try { fallback[key] = JSON.parse(JSON.stringify(value)); }
          catch { fallback[key] = value; }
        } else {
          fallback[key] = value;
        }
      }
      return fallback;
    }
  };

  const ensureBucket = (prefix) => {
    const key = prefix || '_';
    if (!chunkMap.has(key)) chunkMap.set(key, new Map());
    return chunkMap.get(key);
  };

  const hasDataInternal = () => {
    for (const bucket of chunkMap.values()) {
      if (bucket.size > 0) return true;
    }
    return false;
  };

  const serialize = () => {
    const entries = [];
    const compareTokens = (a, b) => {
      if (!a?.token && !b?.token) return 0;
      if (!a?.token) return -1;
      if (!b?.token) return 1;
      return a.token.localeCompare(b.token, undefined, { sensitivity: 'base' });
    };
    const comparePrefix = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

    for (const [prefix, bucket] of chunkMap.entries()) {
      if (!bucket || bucket.size === 0) continue;
      const tokens = Array.from(bucket.values())
        .map(cloneRecord)
        .filter(Boolean)
        .sort(compareTokens);
      entries.push({ prefix, token_count: tokens.length, tokens });
    }

    entries.sort((a, b) => comparePrefix(a.prefix || '_', b.prefix || '_'));
    return entries;
  };

  const getChunkTokens = (prefix) => {
    const key = typeof prefix === 'string' && prefix ? prefix.toLowerCase() : '_';
    const bucket = chunkMap.get(key) || chunkMap.get('_');
    if (!bucket) return [];
    return Array.from(bucket.values()).map(cloneRecord).filter(Boolean);
  };

  const computeStats = () => {
    const chunks = serialize();
    let totalTokens = 0;
    let totalRelationships = 0;
    const tokenSet = new Set();

    for (const chunk of chunks) {
      totalTokens += Number(chunk.token_count) || 0;
      for (const record of chunk.tokens || []) {
        if (!record || typeof record.token !== 'string') continue;
        tokenSet.add(record.token);
        const rels = record.relationships && typeof record.relationships === 'object'
          ? record.relationships
          : {};
        for (const value of Object.values(rels)) {
          if (Array.isArray(value)) totalRelationships += value.length;
        }
      }
    }

    const tokenIndex = Array.from(tokenSet)
      .filter(token => typeof token === 'string' && token.trim())
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    return { chunks, totalTokens, totalRelationships, tokenIndex };
  };

  const buildManifestPayload = (stats, options = {}) => {
    const { includeTokenIndex = false, generatedAt = null } = options || {};
    const timestamp = generatedAt || lastGeneratedAt || new Date().toISOString();
    lastGeneratedAt = timestamp;
    const manifestPayload = {
      version: '2.1',
      generated_at: timestamp,
      source: 'session-cache',
      total_tokens: stats.totalTokens,
      total_relationships: stats.totalRelationships,
      chunk_prefix_length: 1,
      chunks: stats.chunks.map(chunk => ({
        prefix: chunk.prefix,
        href: `chunks/${chunk.prefix}.json`,
        token_count: chunk.token_count,
      })),
      token_index_href: 'token-index.json',
    };
    if (includeTokenIndex) {
      manifestPayload.token_index = stats.tokenIndex;
    }
    return manifestPayload;
  };

  const manifest = (options = {}) => buildManifestPayload(computeStats(), options);

  const tokenIndex = () => computeStats().tokenIndex;

  const PERSIST_DEBOUNCE_MS = 250;
  let persistSchedule = null;
  let persistPromise = null;
  let persistResolver = null;
  let lastPersistPayload = null;

  const cancelScheduledPersist = () => {
    if (!persistSchedule) return;
    const { type, id } = persistSchedule;
    if (type === 'idle') {
      const cancelIdle = typeof window !== 'undefined' ? window.cancelIdleCallback : null;
      if (typeof cancelIdle === 'function') {
        try { cancelIdle(id); }
        catch (err) { console.warn('Failed to cancel idle persist callback:', err); }
      }
    } else {
      clearTimeout(id);
    }
    persistSchedule = null;
  };

  const broadcastPersistResult = (payload) => {
    lastPersistPayload = payload;
    try {
      const writer = window?.HLSF?.remoteDbFileWriter;
      if (writer && typeof writer.handlePersist === 'function') {
        writer.handlePersist(payload);
      }
    } catch (err) {
      console.warn('Remote DB writer notification failed:', err);
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
      try {
        const event = new window.CustomEvent('hlsf:remote-db-updated', { detail: payload });
        window.dispatchEvent(event);
      } catch (err) {
        console.warn('Failed to dispatch remote DB update event:', err);
      }
    }
  };

  const persistNow = () => {
    cancelScheduledPersist();
    if (!hasDataInternal()) {
      safeStorageRemove(STORAGE_KEY);
      safeStorageRemove(META_KEY);
      lastGeneratedAt = null;
      const emptyPayload = { metadata: null, chunks: [], tokenIndex: [] };
      broadcastPersistResult(emptyPayload);
      return emptyPayload;
    }

    const stats = computeStats();
    const generatedAt = new Date().toISOString();
    const manifestPayload = buildManifestPayload(stats, { includeTokenIndex: true, generatedAt });
    const chunksPayload = stats.chunks;
    safeStorageSet(STORAGE_KEY, JSON.stringify(chunksPayload));
    safeStorageSet(META_KEY, JSON.stringify(manifestPayload));
    const payload = { metadata: manifestPayload, chunks: chunksPayload, tokenIndex: stats.tokenIndex };
    broadcastPersistResult(payload);
    return payload;
  };

  const schedulePersist = () => {
    if (persistPromise) return persistPromise;
    persistPromise = new Promise(resolve => { persistResolver = resolve; });

    const run = () => {
      persistSchedule = null;
      let result = null;
      try {
        result = persistNow();
      } catch (err) {
        console.warn('Remote DB persist failed:', err);
        result = lastPersistPayload || { metadata: null, chunks: [], tokenIndex: [] };
      }
      const resolve = persistResolver;
      persistPromise = null;
      persistResolver = null;
      if (typeof resolve === 'function') {
        try { resolve(result); }
        catch (resolveErr) { console.warn('Persist promise resolution failed:', resolveErr); }
      }
    };

    const useIdle = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function';
    if (useIdle) {
      try {
        const id = window.requestIdleCallback(run, { timeout: 1000 });
        persistSchedule = { type: 'idle', id };
        return persistPromise;
      } catch (err) {
        console.warn('requestIdleCallback unavailable, falling back to timeout:', err);
      }
    }

    const id = setTimeout(run, PERSIST_DEBOUNCE_MS);
    persistSchedule = { type: 'timeout', id };
    return persistPromise;
  };

  const flush = () => {
    if (persistResolver && !persistPromise) {
      // Should not happen, but guard against inconsistent state.
      persistResolver = null;
    }
    if (persistSchedule) {
      cancelScheduledPersist();
    }
    const result = persistNow();
    if (persistResolver) {
      try { persistResolver(result); }
      catch (err) { console.warn('Persist flush resolution failed:', err); }
      persistResolver = null;
    }
    persistPromise = null;
    return result;
  };

  const remove = (token, options = {}) => {
    const { deferPersist = false } = options || {};
    const normalized = normalizeTokenKey(token);
    if (!normalized) return false;
    let removed = false;
    for (const [prefix, bucket] of chunkMap.entries()) {
      if (!bucket || bucket.size === 0) continue;
      if (bucket.delete(normalized)) {
        removed = true;
        if (bucket.size === 0) chunkMap.delete(prefix);
        break;
      }
    }
    if (removed && !deferPersist) schedulePersist();
    return removed;
  };

  const removeMany = (tokens) => {
    if (!Array.isArray(tokens) || !tokens.length) return 0;
    let removed = 0;
    for (const token of tokens) {
      if (remove(token, { deferPersist: true })) removed += 1;
    }
    if (removed > 0) schedulePersist();
    return removed;
  };

  const ingest = (record, options = {}) => {
    const { deferPersist = false } = options || {};
    const normalized = normalizeRecord(record);
    if (!normalized) return false;
    const key = normalizeTokenKey(normalized.token);
    if (!key) return false;
    if (!normalized.cached_at) {
      normalized.cached_at = (record && record.cached_at) || new Date().toISOString();
    }
    const prefix = prefixForToken(normalized.token);
    const bucket = ensureBucket(prefix);
    const existing = bucket.get(key);
    const sanitized = cloneRecord(normalized);
    if (!sanitized) return false;
    pruneRemoteRecordRelationships(sanitized);
    if (existing) pruneRemoteRecordRelationships(existing);
    if (existing?.cached_at && !sanitized.cached_at) {
      sanitized.cached_at = existing.cached_at;
    }
    let changed = false;
    if (!existing) {
      changed = true;
    } else {
      try {
        changed = JSON.stringify(existing) !== JSON.stringify(sanitized);
      } catch {
        changed = true;
      }
    }
    if (!sanitized.cached_at) sanitized.cached_at = new Date().toISOString();
    bucket.set(key, sanitized);
    if (!deferPersist && changed) schedulePersist();
    return changed;
  };

  const REMOTE_DB_INGEST_YIELD_EVERY = 250;

  const ingestMany = async (records) => {
    let changed = 0;
    if (!Array.isArray(records)) return changed;

    let processed = 0;
    const yieldInterval = REMOTE_DB_INGEST_YIELD_EVERY;

    for (const record of records) {
      if (ingest(record, { deferPersist: true })) changed += 1;
      processed += 1;
      if (processed % yieldInterval === 0) {
        await yieldDbImport();
      }
    }

    if (changed > 0) schedulePersist();
    return changed;
  };

  const hydrateFromStorage = () => {
    chunkMap.clear();
    lastGeneratedAt = null;
    let stored = safeStorageGet(STORAGE_KEY, null);
    if (typeof stored === 'string') {
      try { stored = JSON.parse(stored); }
      catch { stored = null; }
    }
    if (Array.isArray(stored)) {
      for (const chunk of stored) {
        if (!chunk || typeof chunk !== 'object') continue;
        const prefix = typeof chunk.prefix === 'string' && chunk.prefix ? chunk.prefix : '_';
        const bucket = ensureBucket(prefix);
        const tokens = Array.isArray(chunk.tokens) ? chunk.tokens : [];
        for (const record of tokens) {
          ingest(record, { deferPersist: true });
        }
        if (bucket.size === 0) chunkMap.delete(prefix);
      }
    }

    let storedMeta = safeStorageGet(META_KEY, null);
    if (typeof storedMeta === 'string') {
      try { storedMeta = JSON.parse(storedMeta); }
      catch { storedMeta = null; }
    }
    if (storedMeta && typeof storedMeta === 'object' && storedMeta.generated_at) {
      lastGeneratedAt = storedMeta.generated_at;
    }

    if (!hasDataInternal()) {
      chunkMap.clear();
    }
  };

  const listChunks = () => serialize();

  const reset = () => {
    chunkMap.clear();
    lastGeneratedAt = null;
    cancelScheduledPersist();
    persistPromise = null;
    persistResolver = null;
    safeStorageRemove(STORAGE_KEY);
    safeStorageRemove(META_KEY);
    broadcastPersistResult({ metadata: null, chunks: [], tokenIndex: [] });
  };

  const hasData = () => hasDataInternal();

  try {
    hydrateFromStorage();
  } catch (err) {
    console.warn('RemoteDbRecorder hydration failed:', err);
  }

  return {
    ingest,
    ingestMany,
    listChunks,
    manifest,
    tokenIndex,
    hasData,
    reset,
    remove,
    removeMany,
    flush,
    schedulePersist,
    getChunkTokens,
  };
})();

window.HLSF = window.HLSF || {};
window.HLSF.remoteDbRecorder = RemoteDbRecorder;

let remoteDbSyncStatus = null;

const ensureRemoteDbSyncStatus = () => {
  if (!remoteDbSyncStatus || typeof remoteDbSyncStatus.isActive !== 'function' || !remoteDbSyncStatus.isActive()) {
    remoteDbSyncStatus = RealtimeStatus.create('Remote DB sync', { icon: '💾' });
  }
  return remoteDbSyncStatus;
};

const updateRemoteDbSyncStatus = (info: Record<string, unknown> = {}) => {
  const queueLength = Number.isFinite(info.queueLength) ? Number(info.queueLength) : 0;
  const pendingWorkUnits = Number.isFinite(info.pendingWorkUnits) ? Number(info.pendingWorkUnits) : 0;
  const activeWorkUnits = Number.isFinite(info.activeWorkUnits) ? Number(info.activeWorkUnits) : 0;
  const hasActivity = queueLength > 0 || pendingWorkUnits > 0 || (typeof info.activeStart === 'number' && activeWorkUnits > 0);
  if (!remoteDbSyncStatus && !hasActivity) return;
  const status = ensureRemoteDbSyncStatus();
  status.update({
    queueLength,
    pendingWorkUnits,
    pendingChunks: Number.isFinite(info.pendingChunks) ? Number(info.pendingChunks) : undefined,
    averageMsPerUnit: Number.isFinite(info.averageMsPerUnit) ? Number(info.averageMsPerUnit) : undefined,
    activeStart: typeof info.activeStart === 'number' ? Number(info.activeStart) : null,
    activeWorkUnits,
  });
};

const remoteDbFileWriter = createRemoteDbFileWriter({
  onMissingDirectory(reason) {
    if (reason === 'unsupported') {
      logWarning('Remote DB auto-save requires a Chromium browser with the File System Access API. Updates will remain in the session cache.');
      return;
    }
    if (reason === 'permission') {
      logWarning('Remote DB directory access was denied. Run /remotedir to reconnect and grant write permission.');
      return;
    }
    addLog(`
      <div class="adjacency-insight">
        💾 Remote DB updates are ready to sync.<br>
        <button class="inline-command" data-command="/remotedir">Select save directory</button>
        or run <code>/remotedir</code> to choose where chunk files should be written automatically.
      </div>
    `);
  },
  onSyncStart(info) {
    updateRemoteDbSyncStatus(info || {});
  },
  onSyncProgress(info) {
    updateRemoteDbSyncStatus(info || {});
  },
  onSyncSuccess(info) {
    const status = ensureRemoteDbSyncStatus();
    const count = Number.isFinite(info?.chunkCount) ? Number(info?.chunkCount) : 0;
    const suffix = count === 1 ? 'chunk' : 'chunks';
    const summary = count > 0
      ? `Remote DB files updated (${count} ${suffix})`
      : 'Remote DB files synchronized';
    status.complete({ summary });
    remoteDbSyncStatus = null;
  },
  onSyncIdle(info) {
    if (!remoteDbSyncStatus || (typeof remoteDbSyncStatus.isActive === 'function' && !remoteDbSyncStatus.isActive())) return;
    const count = Number.isFinite(info?.chunkCount) ? Number(info?.chunkCount) : 0;
    const suffix = count === 1 ? 'chunk' : 'chunks';
    const summary = count > 0
      ? `Remote DB files updated (${count} ${suffix})`
      : 'Remote DB files up to date';
    remoteDbSyncStatus.complete({ summary });
    remoteDbSyncStatus = null;
  },
  onSyncError(message) {
    if (!remoteDbSyncStatus || (typeof remoteDbSyncStatus.isActive === 'function' && !remoteDbSyncStatus.isActive())) {
      remoteDbSyncStatus = RealtimeStatus.create('Remote DB sync', { icon: '💾' });
    }
    remoteDbSyncStatus.fail(message || 'Remote DB sync failed');
    remoteDbSyncStatus = null;
    if (message) logWarning(message);
  },
});

window.HLSF.remoteDbFileWriter = remoteDbFileWriter;
setRemotedirFlag(typeof remoteDbFileWriter?.hasDirectory === 'function' && remoteDbFileWriter.hasDirectory());

function updateCachedTokenDisplay(baseCount) {
  const normalizedBase = Number.isFinite(baseCount) ? Math.max(0, Math.floor(baseCount)) : 0;
  const displayValue = CacheBatch.format(normalizedBase);
  const cachedTokensEl = elements.cachedTokens;
  if (!(cachedTokensEl instanceof HTMLElement)) {
    return;
  }
  cachedTokensEl.textContent = displayValue;
  const total = CacheBatch.total(normalizedBase);
  if (total > 0) {
    cachedTokensEl.style.color = total > 50 ? '#00ff88' : '#ffd54f';
  } else {
    cachedTokensEl.style.removeProperty('color');
  }
}

// ============================================
// STATS
// ============================================
function updateStats() {
  const { totalApiCalls, totalCacheHits, totalCostUsd } = state.sessionStats;
  const total = totalApiCalls + totalCacheHits;
  const hitRate = total > 0 ? ((totalCacheHits / total) * 100).toFixed(1) + '%' : '—';

  let baseline = getDocumentCacheBaseline();
  const manualReset = state.documentCacheBaselineManuallyCleared === true;

  const rawCount = getCachedTokenCount();
  let cachedCount = baseline;

  if (Number.isFinite(rawCount)) {
    const normalized = Math.max(0, Math.floor(rawCount));
    if (normalized > 0) {
      if (CacheBatch.isActive()) {
        cachedCount = Math.max(normalized, baseline, CacheBatch.getBaseline());
      } else {
        cachedCount = normalized;
        if (normalized !== baseline) {
          baseline = setDocumentCacheBaseline(normalized);
        } else if (manualReset) {
          state.documentCacheBaselineManuallyCleared = false;
        }
      }
    } else if (!CacheBatch.isActive()) {
      if (manualReset) {
        cachedCount = 0;
        baseline = setDocumentCacheBaseline(0, { manual: true });
      } else {
        cachedCount = baseline;
      }
    } else {
      cachedCount = Math.max(0, CacheBatch.getBaseline());
    }
  } else if (CacheBatch.isActive()) {
    cachedCount = Math.max(0, CacheBatch.getBaseline());
  } else if (manualReset && baseline === 0) {
    cachedCount = 0;
  }

  cachedCount = Math.max(0, Math.floor(Number.isFinite(cachedCount) ? cachedCount : 0));
  state.lastComputedCacheBase = cachedCount;

  if (elements.cacheHitRate instanceof HTMLElement) {
    elements.cacheHitRate.textContent = hitRate;
  }
  updateCachedTokenDisplay(state.lastComputedCacheBase);
  if (elements.sessionCost instanceof HTMLElement) {
    elements.sessionCost.textContent = formatCurrency(totalCostUsd);
  }
}

function updateHeaderCounts() {
  updateStats();
}

// ============================================
// CACHE
// ============================================
function getCacheKey(token) {
  const normalized = token == null ? '' : String(token);
  return `${TOKEN_CACHE_PREFIX}${normalized.toLowerCase()}`;
}

function isTokenCached(token) {
  const key = getCacheKey(token);
  if (knowledgeStore.hasInMemory(token)) return true;
  try {
    if (localStorage.getItem(key) != null) return true;
  } catch {
    // ignore storage access errors and fall back to in-memory cache
  }
  return memoryStorageFallback.has(key);
}

function updateTokenIndex(token) {
  if (!token) return;

  let index = safeStorageGet(DB_INDEX_KEY, []);
  if (!Array.isArray(index)) index = [];
  if (!index.includes(token)) {
    index.push(token);
    safeStorageSet(DB_INDEX_KEY, JSON.stringify(index));
  }
}

function getFromCache(token) {
  try {
    const raw = safeStorageGet(getCacheKey(token));
    if (!raw) return null;
    state.sessionStats.totalCacheHits++;
    updateStats();
    return raw;
  } catch { return null; }
}

function buildRelationshipSignature(relationships) {
  const signature = new Map();
  if (!relationships || typeof relationships !== 'object') {
    return signature;
  }

  for (const [rawKey, values] of Object.entries(relationships)) {
    const relKey = normRelKey(rawKey) || rawKey;
    if (!relKey) continue;
    if (!Array.isArray(values)) continue;

    for (const entry of values) {
      if (!entry || typeof entry.token !== 'string') continue;
      const neighbor = String(entry.token).trim().toLowerCase();
      if (!neighbor) continue;
      const key = `${relKey}::${neighbor}`;
      const weight = typeof entry.weight === 'number' ? entry.weight : Number(entry.weight);
      signature.set(key, Number.isFinite(weight) ? weight : null);
    }
  }

  return signature;
}

function relationshipsExpanded(previousRelationships, nextRelationships) {
  const nextSignature = buildRelationshipSignature(nextRelationships);
  if (!nextSignature.size) return false;

  const previousSignature = buildRelationshipSignature(previousRelationships);
  if (!previousSignature.size && nextSignature.size) {
    return true;
  }

  for (const [key, weight] of nextSignature.entries()) {
    if (!previousSignature.has(key)) {
      return true;
    }
    const previousWeight = previousSignature.get(key);
    const nextNumeric = typeof weight === 'number' ? weight : null;
    const previousNumeric = typeof previousWeight === 'number' ? previousWeight : null;
    if (nextNumeric !== null) {
      if (previousNumeric === null) {
        return true;
      }
      if (nextNumeric > previousNumeric + 1e-6) {
        return true;
      }
    }
  }

  return false;
}

function refreshDbReference(record, options = {}) {
  const { deferReload = false, persist = true } = options || {};
  if (!record || typeof record !== 'object') return null;

  const rawToken = (record as any).token;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) return null;

  const normalizedToken = token.toLowerCase();
  const enrichedRecord = Object.assign({}, record, { token });

  if (!enrichedRecord.relationships || typeof enrichedRecord.relationships !== 'object') {
    enrichedRecord.relationships = {};
  }

  if (typeof window === 'undefined') {
    return enrichedRecord;
  }

  try {
    window.HLSF = window.HLSF || {};
    const dbRoot = (window.HLSF.dbCache && typeof window.HLSF.dbCache === 'object')
      ? window.HLSF.dbCache
      : (window.HLSF.dbCache = { full_token_data: [] });

    if (!Array.isArray(dbRoot.full_token_data)) {
      dbRoot.full_token_data = [];
    }

    let existingIndex = -1;
    for (let i = 0; i < dbRoot.full_token_data.length; i += 1) {
      const current = dbRoot.full_token_data[i];
      const currentToken = typeof current?.token === 'string' ? current.token.trim().toLowerCase() : '';
      if (currentToken === normalizedToken) {
        existingIndex = i;
        break;
      }
    }

    const existingRecord = existingIndex >= 0 ? dbRoot.full_token_data[existingIndex] : null;
    const mergedRelationships = existingRecord && existingRecord.relationships && enrichedRecord.relationships
      ? { ...existingRecord.relationships, ...enrichedRecord.relationships }
      : enrichedRecord.relationships;

    const mergedRecord = Object.assign({}, existingRecord || {}, enrichedRecord, {
      relationships: mergedRelationships,
    });

    if (existingIndex >= 0) {
      dbRoot.full_token_data[existingIndex] = mergedRecord;
    } else {
      dbRoot.full_token_data.push(mergedRecord);
    }

    if (persist !== false) {
      try {
        safeStorageSet(DB_RAW_KEY, JSON.stringify(dbRoot));
      } catch (err) {
        console.warn('Failed to persist DB snapshot after cache refresh:', err);
      }
    }

    try {
      if (knowledgeStore && typeof knowledgeStore.markInMemory === 'function') {
        knowledgeStore.markInMemory(token);
      }
      if (knowledgeStore && typeof knowledgeStore.put === 'function') {
        void knowledgeStore.put({
          token: normalizedToken,
          relationships: mergedRecord.relationships,
          attention_score: mergedRecord.attention_score,
          total_relationships: mergedRecord.total_relationships,
        });
      }
    } catch (err) {
      console.warn('Failed to update knowledge store from DB refresh:', err);
    }

    if (!deferReload) {
      try {
        notifyHlsfAdjacencyChange('cache-update');
      } catch (err) {
        console.warn('Failed to schedule HLSF refresh after DB update:', err);
      }
    }

    return mergedRecord;
  } catch (err) {
    console.warn('Failed to refresh database cache reference:', err);
    return null;
  }
}

function saveToCache(token, data, options = {}) {
  const { deferReload = false } = options || {};
  try {
    const payloadData = Object.assign({ token }, data, {
      cached_at: new Date().toISOString(),
    });
    const recordToken = (typeof payloadData.token === 'string' && payloadData.token)
      ? payloadData.token
      : token;
    payloadData.token = recordToken;
    const wasCached = isTokenCached(recordToken);
    const previousRecord = wasCached ? getCachedRecordForToken(recordToken) : null;
    const enrichedRecord = refreshDbReference(payloadData, { deferReload });
    if (!enrichedRecord || typeof enrichedRecord.token !== 'string') return;
    const finalToken = enrichedRecord.token;
    const cacheKey = getCacheKey(finalToken);
    const payload = JSON.stringify(enrichedRecord);
    const persisted = safeStorageSet(cacheKey, payload);
    const fallbackStored = !persisted && memoryStorageFallback.has(cacheKey);
    if (!persisted && !fallbackStored) return;
    updateTokenIndex(finalToken);
    const adjacencyExpanded = relationshipsExpanded(
      previousRecord?.relationships,
      enrichedRecord.relationships,
    );
    if (!wasCached || adjacencyExpanded) CacheBatch.record(finalToken);
    signalVoiceCloneTokensChanged('token-cached');
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      logWarning('Cache full. Use /reset to clear old data.');
    }
  }
}

window.CognitionEngine.cache = {
  get: getFromCache,
  set: saveToCache,
  key: getCacheKey,
  list: listCachedTokens,
};

function removeTokensFromCache(tokens, options = {}) {
  const { silent = false } = options || {};
  const map = new Map();
  for (const raw of Array.isArray(tokens) ? tokens : []) {
    if (!raw) continue;
    const original = String(raw).trim();
    if (!original) continue;
    const normalized = original.toLowerCase();
    if (!normalized || map.has(normalized)) continue;
    map.set(normalized, original);
  }

  if (!map.size) return 0;

  let removed = 0;
  for (const [, original] of map) {
    const cacheKey = getCacheKey(original);
    if (safeStorageRemove(cacheKey)) removed += 1;
    else if (original.toLowerCase() !== original) {
      const fallbackKey = getCacheKey(original.toLowerCase());
      if (safeStorageRemove(fallbackKey)) removed += 1;
    }
  }

  let index = safeStorageGet(DB_INDEX_KEY, []);
  if (typeof index === 'string') {
    try { index = JSON.parse(index); }
    catch { index = []; }
  }
  if (Array.isArray(index) && index.length) {
    const filtered = index.filter(token => !map.has(String(token).toLowerCase()));
    if (filtered.length !== index.length) {
      safeStorageSet(DB_INDEX_KEY, JSON.stringify(filtered));
    }
  }

  const db = window.HLSF.dbCache;
  if (db && Array.isArray(db.full_token_data)) {
    const filtered = db.full_token_data.filter(record => {
      const key = record && record.token ? String(record.token).toLowerCase() : '';
      return key && !map.has(key);
    });
    if (filtered.length !== db.full_token_data.length) {
      db.full_token_data = filtered;
      try {
        safeStorageSet(DB_RAW_KEY, JSON.stringify(db));
      } catch (err) {
        console.warn('Failed to persist DB snapshot after removal:', err);
      }
    }
  }

  try {
    const recorder = window.HLSF?.remoteDbRecorder;
    if (recorder && typeof recorder.removeMany === 'function') {
      recorder.removeMany(Array.from(map.values()));
    }
  } catch (err) {
    console.warn('Remote DB recorder removal failed:', err);
  }

  markHlsfDataDirty();
  const cachedCount = getCachedTokenCount();
  if (Number.isFinite(cachedCount)) {
    setDocumentCacheBaseline(Math.max(0, cachedCount));
  }
  updateHeaderCounts();
  if (!silent) {
    queueLiveGraphUpdate(80);
  }
  if (removed > 0) {
    signalVoiceCloneTokensChanged('token-removed');
  }
  return removed;
}

function cloneAdjacencyForTokens(matrices, tokenMap) {
  const entries = [];
  if (!(matrices instanceof Map) || !(tokenMap instanceof Map)) return entries;
  for (const [normalized, original] of tokenMap.entries()) {
    const key = normalized || (original ? String(original).toLowerCase() : '');
    const source = matrices.get(key) || matrices.get(original);
    if (!source) continue;
    const clone = cloneAdjacencyEntry(source, original);
    if (!clone) continue;
    clone.token = original || clone.token;
    entries.push(clone);
  }
  return entries;
}

function updatePromptReviewSummary(review) {
  if (!review || !review.summaryElement) return;
  const tokens = Array.from(review.tokens.values());
  if (!tokens.length) {
    review.summaryElement.innerHTML = '<em>No new tokens cached in this prompt.</em>';
    return;
  }
  const rendered = tokens.map(token => `<span class="token-highlight">${sanitize(token)}</span>`).join(', ');
  review.summaryElement.innerHTML = `Captured tokens: ${rendered}`;
}

function setPromptReviewStatus(review, message, tone = 'info') {
  if (!review || !review.statusElement) return;
  review.statusElement.textContent = message || '';
  review.statusElement.dataset.tone = tone || 'info';
}

function setPromptReviewEditorState(review, open) {
  if (!review || !review.editorPanel) return;
  const editButton = review.element?.querySelector('button[data-prompt-action="edit"]');
  if (open) {
    review.editorPanel.classList.remove('hidden');
    if (editButton) editButton.setAttribute('aria-expanded', 'true');
  } else {
    review.editorPanel.classList.add('hidden');
    if (editButton) editButton.setAttribute('aria-expanded', 'false');
  }
}

function registerPromptReview(promptId, tokenMap, matrices) {
  if (!promptId || !(tokenMap instanceof Map) || tokenMap.size === 0) return;
  const adjacencyEntries = cloneAdjacencyForTokens(matrices, tokenMap);
  const serialized = JSON.stringify(adjacencyEntries, null, 2);
  const html = `
    <div class="prompt-review" data-prompt-id="${sanitize(promptId)}">
      <div class="prompt-review-header">
        <div class="prompt-review-title"><strong>Offline adjacency updates ready</strong></div>
        <div class="prompt-review-actions">
          <button type="button" class="btn btn-primary" data-prompt-action="approve">👍 Save</button>
          <button type="button" class="btn btn-secondary" data-prompt-action="discard">👎 Discard</button>
          <button type="button" class="btn btn-secondary" data-prompt-action="edit" aria-expanded="false">✏️ Edit</button>
        </div>
      </div>
      <div class="prompt-review-summary" data-prompt-summary="${sanitize(promptId)}"></div>
      <div class="prompt-review-editor hidden" data-prompt-editor-panel="${sanitize(promptId)}">
        <p class="prompt-review-instructions">Adjust tokens, weights, and adjacencies below. Provide an array of objects shaped like {"token": "example", "relationships": { ... }}.</p>
        <textarea class="prompt-review-editor-field" data-prompt-editor="${sanitize(promptId)}" spellcheck="false"></textarea>
        <div class="prompt-review-editor-actions">
          <button type="button" class="btn btn-primary" data-prompt-action="save">Save edits</button>
          <button type="button" class="btn btn-secondary" data-prompt-action="cancel">Cancel</button>
        </div>
        <div class="prompt-review-status" data-prompt-status="${sanitize(promptId)}"></div>
      </div>
    </div>
  `;
  const entry = addLog(html);
  const textarea = entry.querySelector(`[data-prompt-editor="${cssEscape(promptId)}"]`);
  if (textarea) textarea.value = serialized;
  const review = {
    id: promptId,
    tokens: new Map(tokenMap),
    adjacency: new Map(adjacencyEntries.map(record => [String(record.token).toLowerCase(), record])),
    serialized,
    element: entry,
    textarea,
    statusElement: entry.querySelector(`[data-prompt-status="${cssEscape(promptId)}"]`),
    editorPanel: entry.querySelector(`[data-prompt-editor-panel="${cssEscape(promptId)}"]`),
    summaryElement: entry.querySelector(`[data-prompt-summary="${cssEscape(promptId)}"]`),
  };
  promptReviewStore.set(promptId, review);
  if (review.tokens.size) {
    try {
      removeTokensFromCache(Array.from(review.tokens.values()));
    } catch (err) {
      console.warn('Failed to stage prompt review tokens:', err);
    }
  }
  updatePromptReviewSummary(review);
  setPromptReviewStatus(review, 'Review changes before committing.', 'info');
}

function savePromptReviewEdits(review) {
  if (!review || !review.textarea) return false;
  let parsed;
  try {
    parsed = JSON.parse(review.textarea.value || '[]');
  } catch (err) {
    setPromptReviewStatus(review, 'Unable to parse edits. Ensure valid JSON.', 'error');
    return false;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object') ? Object.values(parsed) : [];

  const normalizedEntries = [];
  const newTokenMap = new Map();
  for (const entry of list) {
    const normalized = normalizeRecord(entry);
    if (!normalized || !normalized.token) continue;
    const token = String(normalized.token).trim();
    if (!token) continue;
    const key = token.toLowerCase();
    newTokenMap.set(key, token);
    normalizedEntries.push(Object.assign({}, normalized, { token }));
  }

  review.tokens = newTokenMap;
  review.adjacency = new Map(normalizedEntries.map(record => [record.token.toLowerCase(), record]));
  review.serialized = JSON.stringify(normalizedEntries, null, 2);
  if (review.textarea) review.textarea.value = review.serialized;
  updatePromptReviewSummary(review);
  setPromptReviewStatus(review, 'Edits staged. Approve to commit.', 'success');
  return true;
}

function cancelPromptReviewEdits(review) {
  if (!review) return;
  if (review.textarea) review.textarea.value = review.serialized;
  setPromptReviewEditorState(review, false);
  setPromptReviewStatus(review, 'Edits cancelled.', 'info');
}

function finalizePromptReview(review, message, tone = 'info') {
  if (!review || !review.element) return;
  const buttons = review.element.querySelectorAll('button[data-prompt-action]');
  buttons.forEach(btn => { btn.disabled = true; });
  setPromptReviewEditorState(review, false);
  review.element.classList.add('prompt-review-completed');
  setPromptReviewStatus(review, message, tone);
  promptReviewStore.delete(review.id);
}

function approvePromptReview(review) {
  if (!review) return;
  const entries = Array.from(review.adjacency.values()).filter(Boolean);
  if (!entries.length) {
    finalizePromptReview(review, 'No staged adjacency updates to commit.', 'info');
    logWarning('Prompt review approved without staged updates.');
    return;
  }

  let committed = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || !entry.token) continue;
    saveToCache(entry.token, entry, { deferReload: i < entries.length - 1 });
    committed += 1;
  }

  if (committed > 0) {
    commitTokens(entries.map(entry => entry.token), { render: false });
    notifyHlsfAdjacencyChange('prompt-review-approve');
    rebuildLiveGraph();
  }

  finalizePromptReview(review, `Committed ${committed} token${committed === 1 ? '' : 's'} to database.`, 'success');
  logOK('Adjacency updates committed to database.');
}

function discardPromptReview(review) {
  const tokens = Array.from(review.tokens.values());
  const removed = tokens.length ? removeTokensFromCache(tokens) : 0;
  for (const token of tokens) {
    const normalized = token ? String(token).toLowerCase() : '';
    if (normalized) {
      state.tokenSources.delete(normalized);
    }
    if (token) {
      Session.tokens.delete(token);
      Session.tokens.delete(token.toLowerCase());
    }
  }
  pruneInactiveTokens();
  rebuildLiveGraph();
  review.tokens.clear();
  review.adjacency.clear();
  review.serialized = '[]';
  if (review.textarea) review.textarea.value = review.serialized;
  updatePromptReviewSummary(review);
  finalizePromptReview(review, `Discarded ${removed} token${removed === 1 ? '' : 's'} from cache.`, 'warning');
  logWarning('Prompt tokens discarded without committing to database.');
}

function togglePromptReviewEditor(review) {
  if (!review || !review.editorPanel) return;
  const isHidden = review.editorPanel.classList.contains('hidden');
  setPromptReviewEditorState(review, isHidden);
  if (isHidden && review.textarea) {
    review.textarea.focus();
  }
}

function handlePromptReviewClick(event) {
  const quickCommand = event.target.closest('button[data-command]');
  if (quickCommand) {
    const command = quickCommand.getAttribute('data-command');
    if (command) {
      event.preventDefault();
      handleCommand(command);
      return;
    }
  }

  const button = event.target.closest('button[data-prompt-action]');
  if (!button) return;
  const container = button.closest('.prompt-review');
  if (!container) return;
  const promptId = container.getAttribute('data-prompt-id');
  const review = promptReviewStore.get(promptId);
  if (!review) return;
  event.preventDefault();
  const action = button.getAttribute('data-prompt-action');
  switch (action) {
    case 'approve':
      approvePromptReview(review);
      break;
    case 'discard':
      discardPromptReview(review);
      break;
    case 'edit':
      togglePromptReviewEditor(review);
      break;
    case 'save':
      savePromptReviewEdits(review);
      break;
    case 'cancel':
      cancelPromptReviewEdits(review);
      break;
    default:
      break;
  }
}

const RemoteDbStore = (() => {
  let metadata = null;
  let metadataUrl = null;
  let chunkPrefixLength = 1;
  let chunkMap = new Map();
  const chunkCache = new Map();
  const tokenCache = new Map();
  let tokenIndex = [];
  let recorderSource = null;

  const resolveChunkConcurrency = () => {
    const configured = Number(window.HLSF?.config?.remoteChunkConcurrency);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(1, Math.floor(configured));
    }
    const hardware = typeof navigator !== 'undefined'
      && navigator
      && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 0;
    if (Number.isFinite(hardware) && hardware > 0) {
      const derived = Math.floor(hardware / 2) || 1;
      return Math.max(1, Math.min(6, derived));
    }
    return 3;
  };

  const normalizeToken = (token) => (token == null ? '' : String(token)).toLowerCase();

  const REMOTE_DB_PRUNE_INTERVAL_MS = 120000;
  let remotePruneIntervalId = null;
  let remotePruneSchedule = null;

  const cancelScheduledRemotePrune = () => {
    if (!remotePruneSchedule) return;
    if (remotePruneSchedule.type === 'idle') {
      const cancelIdle = typeof window !== 'undefined' ? window.cancelIdleCallback : null;
      if (typeof cancelIdle === 'function') {
        try { cancelIdle(remotePruneSchedule.id); }
        catch (err) { console.warn('Failed to cancel remote prune idle callback:', err); }
      }
    } else {
      clearTimeout(remotePruneSchedule.id);
    }
    remotePruneSchedule = null;
  };

  const pruneRemoteCaches = (options = {}) => {
    const { persist = false } = options || {};
    const pruneOptions = {
      threshold: options.threshold,
      relationThresholds: options.relationThresholds,
    };

    const dirtyTokens = new Set();

    const applyPrune = (tokenKey, record) => {
      if (!record || typeof record !== 'object') return;
      const normalized = normalizeToken(tokenKey || record.token);
      if (!normalized) return;
      const changed = pruneRemoteRecordRelationships(record, pruneOptions);
      if (changed) dirtyTokens.add(normalized);
    };

    for (const chunk of chunkCache.values()) {
      if (!(chunk instanceof Map)) continue;
      for (const [tokenKey, record] of chunk.entries()) {
        applyPrune(tokenKey, record);
      }
    }

    for (const [tokenKey, record] of tokenCache.entries()) {
      applyPrune(tokenKey, record);
    }

    let persisted = 0;
    if (persist && dirtyTokens.size) {
      for (const token of dirtyTokens) {
        if (!token || !isTokenCached(token)) continue;
        let record = tokenCache.get(token);
        if (!record) {
          for (const chunk of chunkCache.values()) {
            if (!(chunk instanceof Map)) continue;
            if (chunk.has(token)) {
              record = chunk.get(token);
              break;
            }
          }
        }
        if (!record || typeof record !== 'object') {
          const cachedRecord = getCachedRecordForToken(token);
          if (cachedRecord && typeof cachedRecord === 'object') {
            record = cachedRecord;
            pruneRemoteRecordRelationships(record, pruneOptions);
            tokenCache.set(token, record);
          } else {
            continue;
          }
        }
        pruneRemoteRecordRelationships(record, pruneOptions);
        try {
          const payload = JSON.stringify(record);
          const cacheKey = getCacheKey(record.token || token);
          const persistedOk = safeStorageSet(cacheKey, payload);
          if (!persistedOk) memoryStorageFallback.set(cacheKey, payload);
        } catch (err) {
          console.warn('Failed to persist pruned remote DB record:', err);
        }
        try {
          refreshDbReference(record, { deferReload: true, persist: false });
        } catch (err) {
          console.warn('Failed to refresh DB snapshot after pruning remote record:', err);
        }
        persisted += 1;
      }
    }

    return { pruned: dirtyTokens.size, persisted };
  };

  const runRemotePruneNow = (options = {}) => {
    const result = pruneRemoteCaches(Object.assign({ persist: true }, options));
    if (result.pruned > 0) {
      updateHeaderCounts();
    }
    return result;
  };

  const ensureRemotePruneTicker = () => {
    if (remotePruneIntervalId != null) return;
    if (typeof setInterval !== 'function') return;
    remotePruneIntervalId = setInterval(() => {
      scheduleRemotePruneRun();
    }, REMOTE_DB_PRUNE_INTERVAL_MS);
  };

  const scheduleRemotePruneRun = (options = {}) => {
    ensureRemotePruneTicker();
    if (options.immediate === true) {
      cancelScheduledRemotePrune();
      return runRemotePruneNow(options);
    }
    if (remotePruneSchedule) return null;

    const idle = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback.bind(window)
      : null;

    const execute = () => {
      remotePruneSchedule = null;
      try {
        runRemotePruneNow(options);
      } catch (err) {
        console.warn('Remote DB relationship pruning failed:', err);
      }
    };

    if (idle) {
      const id = idle(execute, { timeout: 1500 });
      remotePruneSchedule = { type: 'idle', id };
    } else {
      const id = setTimeout(execute, 800);
      remotePruneSchedule = { type: 'timeout', id };
    }
    return null;
  };

  const hasMetadata = () => metadata != null || recorderSource != null;

  const fallbackPrefix = () => {
    if (chunkMap.has('_')) return '_';
    const iter = chunkMap.keys().next();
    return iter.done ? '_' : iter.value;
  };

  const chunkKeyFor = (token) => {
    const normalized = normalizeToken(token);
    if (!normalized) return fallbackPrefix();
    const primary = normalized.slice(0, chunkPrefixLength) || normalized.charAt(0);
    if (primary && chunkMap.has(primary)) return primary;
    const fallback = normalized.charAt(0);
    if (fallback && chunkMap.has(fallback)) return fallback;
    return fallbackPrefix();
  };

  const resolveChunkUrl = (info) => new URL(info.href, metadataUrl).href;

  const loadTokenIndex = async (href) => {
    tokenIndex = [];
    if (!href) return;
    try {
      const url = new URL(href, metadataUrl).href;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && Array.isArray(data.tokens)) {
        tokenIndex = data.tokens.map(tok => String(tok));
      }
    } catch (err) {
      console.warn('Failed to load remote DB token index:', err);
      tokenIndex = [];
    }
  };

  const ensureChunk = async (prefix) => {
    const key = chunkMap.has(prefix) ? prefix : chunkKeyFor(prefix);
    if (chunkCache.has(key)) return chunkCache.get(key);
    const info = chunkMap.get(key);
    if (!info) {
      const empty = new Map();
      chunkCache.set(key, empty);
      return empty;
    }
    if (info.recorder === true && recorderSource && typeof recorderSource.getChunkTokens === 'function') {
      const entries = new Map();
      const list = recorderSource.getChunkTokens(info.prefix) || [];
      for (const entry of list) {
        const normalized = normalizeRecord(entry);
        if (!normalized) continue;
        pruneRemoteRecordRelationships(normalized);
        const tokenKey = normalizeToken(normalized.token);
        if (!tokenKey) continue;
        entries.set(tokenKey, normalized);
      }
      chunkCache.set(key, entries);
      scheduleRemotePruneRun();
      return entries;
    }

    const url = resolveChunkUrl(info);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const entries = new Map();
    const list = Array.isArray(payload?.tokens) ? payload.tokens : [];
    for (const entry of list) {
      const normalized = normalizeRecord(entry);
      if (!normalized) continue;
      pruneRemoteRecordRelationships(normalized);
      const tokenKey = normalizeToken(normalized.token);
      if (!tokenKey) continue;
      entries.set(tokenKey, normalized);
    }
    chunkCache.set(key, entries);
    scheduleRemotePruneRun();
    return entries;
  };

  const ingestRecord = (record) => {
    if (!record || !record.token) return false;
    pruneRemoteRecordRelationships(record);
    const cacheKey = getCacheKey(record.token);
    const alreadyCached = isTokenCached(record.token);
    let changed = false;

    if (!alreadyCached) {
      const payload = JSON.stringify(record);
      const persisted = safeStorageSet(cacheKey, payload);
      if (!persisted) memoryStorageFallback.set(cacheKey, payload);
      CacheBatch.record(record.token);
      updateTokenIndex(record.token);
      changed = true;
    } else {
      const existing = getCachedRecordForToken(record.token);
      const hasAdjacency = existing && existing.relationships && Object.keys(existing.relationships).length > 0;
      if (!hasAdjacency) {
        const payload = JSON.stringify(record);
        const persisted = safeStorageSet(cacheKey, payload);
        if (!persisted) memoryStorageFallback.set(cacheKey, payload);
        updateTokenIndex(record.token);
        changed = true;
      }
    }

    refreshDbReference(record, { deferReload: true, persist: false });
    scheduleRemotePruneRun();
    return changed;
  };

  const preloadTokens = async (tokens) => {
    if (!hasMetadata()) return { loaded: 0, hits: 0 };
    const stats = { loaded: 0, hits: 0 };
    const normalizedTokens = Array.from(new Set((tokens || []).map(normalizeToken).filter(Boolean)));
    const loadedTokens = new Set();
    const recordLoadedToken = (value) => {
      if (!value) return;
      const normalized = typeof value === 'string' ? value.trim() : '';
      if (!normalized) return;
      loadedTokens.add(normalized);
    };
    if (!normalizedTokens.length) return stats;

    const pending = new Map();
    for (const token of normalizedTokens) {
      if (isTokenCached(token)) {
        const existing = getCachedRecordForToken(token);
        const hasAdjacency = existing && existing.relationships && Object.keys(existing.relationships).length > 0;
        if (hasAdjacency) {
          stats.hits++;
          recordLoadedToken(existing?.token || token);
          continue;
        }
      }
      const cached = tokenCache.get(token);
      if (cached) {
        if (ingestRecord(cached)) {
          stats.loaded++;
          recordLoadedToken(cached.token);
        } else {
          stats.hits++;
          recordLoadedToken(cached.token || token);
        }
        continue;
      }
      const prefix = chunkKeyFor(token);
      if (!pending.has(prefix)) pending.set(prefix, new Set());
      pending.get(prefix).add(token);
    }

    const requests = Array.from(pending.entries()).map(([prefix, set]) => ({
      prefix,
      tokens: Array.from(set),
    }));

    if (requests.length) {
      const concurrency = Math.max(1, Math.min(resolveChunkConcurrency(), requests.length));
      for (let i = 0; i < requests.length; i += concurrency) {
        const batch = requests.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async request => {
          try {
            const chunk = await ensureChunk(request.prefix);
            return { request, chunk };
          } catch (err) {
            console.warn(`Failed to hydrate remote DB chunk ${request.prefix}:`, err);
            return { request, chunk: null };
          }
        }));

        for (const { request, chunk } of results) {
          if (!chunk) continue;
          for (const token of request.tokens) {
            const record = chunk.get(token);
            if (!record) continue;
            tokenCache.set(token, record);
            if (ingestRecord(record)) {
              stats.loaded++;
              recordLoadedToken(record.token);
            } else {
              stats.hits++;
              recordLoadedToken(record.token || token);
            }
          }
        }
      }
    }

    if (stats.loaded > 0) {
      updateHeaderCounts();
    }
    if (loadedTokens.size > 0) {
      const orderedLoaded = Array.from(loadedTokens);
      const targetToken = normalizedTokens[normalizedTokens.length - 1] || orderedLoaded[0];
      onAdjacencyPreloadComplete(targetToken, orderedLoaded);
    }
    return stats;
  };

  const configure = async (url) => {
    if (!url) throw new Error('Metadata URL required');
    const resolved = new URL(url, location.href).href;
    const res = await fetch(resolved, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || typeof data !== 'object' || !Array.isArray(data.chunks)) {
      throw new Error('Invalid metadata payload');
    }

    metadata = data;
    metadataUrl = resolved;
    chunkPrefixLength = Math.max(1, Number(data.chunk_prefix_length) || 1);
    chunkMap = new Map();
    for (const chunk of data.chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      const rawPrefix = chunk.prefix == null ? '' : String(chunk.prefix);
      const prefixKey = normalizeToken(rawPrefix) || rawPrefix || '_';
      if (!chunk.href) continue;
      chunkMap.set(prefixKey, {
        prefix: prefixKey,
        href: chunk.href,
        token_count: Number(chunk.token_count) || 0,
      });
    }

    chunkCache.clear();
    tokenCache.clear();
    recorderSource = null;
    await loadTokenIndex(data.token_index_href);

    window.HLSF.dbCache = { full_token_data: [] };
    window.HLSF.dbMeta = metadata;
    updateHeaderCounts();
    scheduleRemoteCacheWarmup({ remote: RemoteDbStore, limit: CONFIG.CACHE_SEED_LIMIT, reason: 'configure' });
    scheduleRemotePruneRun({ immediate: true });
    return metadata;
  };

  const attachRecorder = (recorder) => {
    if (!recorder || typeof recorder.manifest !== 'function') {
      throw new Error('Recorder with manifest() required');
    }
    const manifest = recorder.manifest({ includeTokenIndex: true });
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.chunks)) {
      throw new Error('Recorder manifest missing chunk data');
    }

    metadata = manifest;
    metadataUrl = location.href;
    chunkPrefixLength = Math.max(1, Number(manifest.chunk_prefix_length) || 1);
    chunkMap = new Map();
    for (const chunk of manifest.chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      const rawPrefix = chunk.prefix == null ? '' : String(chunk.prefix);
      const prefixKey = normalizeToken(rawPrefix) || rawPrefix || '_';
      chunkMap.set(prefixKey, {
        prefix: prefixKey,
        href: chunk.href || '',
        token_count: Number(chunk.token_count) || 0,
        recorder: true,
      });
    }

    recorderSource = recorder;
    chunkCache.clear();
    tokenCache.clear();
    if (Array.isArray(manifest.token_index)) {
      tokenIndex = manifest.token_index.map(tok => String(tok));
    } else if (typeof recorder.tokenIndex === 'function') {
      tokenIndex = recorder.tokenIndex();
    } else {
      tokenIndex = [];
    }

    if (window.HLSF) {
      window.HLSF.dbMeta = manifest;
    }
    updateHeaderCounts();
    scheduleRemoteCacheWarmup({ remote: RemoteDbStore, limit: CONFIG.CACHE_SEED_LIMIT, reason: 'recorder', force: true });
    scheduleRemotePruneRun({ immediate: true });
    return manifest;
  };

  const listTokens = () => Array.isArray(tokenIndex) ? [...tokenIndex] : [];

  const reset = () => {
    metadata = null;
    metadataUrl = null;
    chunkPrefixLength = 1;
    chunkMap = new Map();
    chunkCache.clear();
    tokenCache.clear();
    tokenIndex = [];
    recorderSource = null;
    try {
      if (window.HLSF) {
        window.HLSF.dbCache = null;
        window.HLSF.dbMeta = null;
        window.HLSF.dbIndex = [];
      }
    } catch (err) {
      console.warn('Remote DB reset failed to clear HLSF state:', err);
    }
    updateHeaderCounts();
    cancelScheduledRemotePrune();
    scheduleRemotePruneRun({ immediate: true });
  };

  ensureRemotePruneTicker();
  scheduleRemotePruneRun({ immediate: true });

  return {
    configure,
    isReady: hasMetadata,
    preloadTokens,
    listTokens,
    metadata: () => metadata,
    chunkForToken: chunkKeyFor,
    attachRecorder,
    reset,
    pruneRelationships: (options = {}) => runRemotePruneNow(options),
  };
})();

let remoteCacheWarmPromise = null;
let remoteCacheWarmActiveKey = '';
let remoteCacheWarmCompletedKey = '';

function handleRemoteDbUpdatedEvent(event) {
  if (typeof window === 'undefined') return;

  const detail = event && typeof event === 'object' ? event.detail : null;
  if (detail && typeof detail === 'object') {
    try {
      if (detail.metadata && typeof detail.metadata === 'object') {
        window.HLSF = window.HLSF || {};
        window.HLSF.dbMeta = detail.metadata;
      }
      if (Array.isArray(detail.tokenIndex)) {
        window.HLSF = window.HLSF || {};
        window.HLSF.dbIndex = detail.tokenIndex.slice();
      }
    } catch (err) {
      console.warn('Failed to apply remote DB manifest update:', err);
    }
  }

  let warmupPromise = null;
  try {
    const recorder = window.HLSF?.remoteDbRecorder;
    const remote = window.HLSF?.remoteDb;
    if (remote && recorder && typeof remote.attachRecorder === 'function') {
      remote.attachRecorder(recorder);
      warmupPromise = remoteCacheWarmPromise;
    }
  } catch (err) {
    console.warn('Remote DB attachment after update failed:', err);
  }

  try {
    updateHeaderCounts();
  } catch (err) {
    console.warn('Failed to refresh header counts after remote DB update:', err);
  }

  const triggerReload = () => {
    try {
      notifyHlsfAdjacencyChange('remote-db-update', { immediate: true });
    } catch (err) {
      console.warn('Failed to notify HLSF after remote DB update:', err);
    }
  };

  if (warmupPromise && typeof warmupPromise.then === 'function') {
    warmupPromise
      .then(triggerReload)
      .catch(err => {
        console.warn('Remote cache warmup after update failed:', err);
        triggerReload();
      });
  } else {
    triggerReload();
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('hlsf:remote-db-updated', handleRemoteDbUpdatedEvent);
}

function computeRemoteDatasetKey(tokens, metadata) {
  const metaPart = (() => {
    if (!metadata || typeof metadata !== 'object') return '';
    const version = metadata.version || metadata.db_version || '';
    const generated = metadata.generated_at || metadata.generatedAt || '';
    const total = Number.isFinite(metadata.total_tokens)
      ? metadata.total_tokens
      : (Number.isFinite(metadata.totalTokens) ? metadata.totalTokens : '');
    const chunkCount = Array.isArray(metadata.chunks) ? metadata.chunks.length : '';
    return `meta:${version}|${generated}|${total}|${chunkCount}`;
  })();

  if (typeof window !== 'undefined' && window?.HLSF?.config) {
    const bootstrap = window.HLSF.config.bootstrapDbUrl;
    if (typeof bootstrap === 'string' && bootstrap.trim()) {
      return `url:${bootstrap.trim()}|${metaPart || 'default'}`;
    }
  }
  if (metaPart) return metaPart;
  if (Array.isArray(tokens) && tokens.length) {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    return `tokens:${tokens.length}|${first}|${last}`;
  }
  return 'remote:unknown';
}

function scheduleRemoteCacheWarmup(options = {}) {
  const remote = options.remote || (typeof window !== 'undefined' ? window?.HLSF?.remoteDb : null);
  if (!remote || typeof remote.isReady !== 'function' || !remote.isReady()) return null;
  if (typeof remote.listTokens !== 'function' || typeof remote.preloadTokens !== 'function') return null;

  const metadata = typeof remote.metadata === 'function' ? remote.metadata() : null;
  let tokens = remote.listTokens();
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  tokens = tokens
    .map(token => (typeof token === 'string' ? token.trim() : ''))
    .filter(Boolean);
  if (!tokens.length) return null;

  const datasetKey = computeRemoteDatasetKey(tokens, metadata);
  const force = options.force === true;

  if (!force) {
    if (remoteCacheWarmPromise && remoteCacheWarmActiveKey === datasetKey) {
      return remoteCacheWarmPromise;
    }
    if (!remoteCacheWarmPromise && remoteCacheWarmCompletedKey === datasetKey) {
      return Promise.resolve({ warmed: 0, total: 0, skipped: true });
    }
  }

  const limitOption = Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : 0;
  const limit = limitOption > 0 ? Math.min(tokens.length, limitOption) : tokens.length;
  if (limit <= 0) return null;

  const subset = tokens.slice(0, limit);
  if (!subset.length) return null;

  const batchSize = (() => {
    if (Number.isFinite(options.batchSize) && options.batchSize > 0) {
      return Math.max(1, Math.floor(options.batchSize));
    }
    const derived = Math.ceil(subset.length / 12);
    return Math.max(8, Math.min(200, derived));
  })();

  const run = async () => {
    let warmed = 0;
    for (let i = 0; i < subset.length; i += batchSize) {
      const batch = subset.slice(i, i + batchSize);
      if (!batch.length) continue;
      try {
        const stats = await remote.preloadTokens(batch);
        if (stats && typeof stats.loaded === 'number') {
          warmed += stats.loaded;
        } else if (stats && typeof stats.hits === 'number' && (stats.loaded == null || stats.loaded === undefined)) {
          warmed += stats.hits;
        } else {
          warmed += batch.length;
        }
      } catch (err) {
        console.warn('Remote token cache warmup failed for batch:', err);
      }
    }
    return { warmed, total: subset.length };
  };

  remoteCacheWarmActiveKey = datasetKey;

  const schedule = (invoke) => {
    const idle = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback.bind(window)
      : null;
    if (idle) {
      idle(invoke, { timeout: 2000 });
    } else {
      setTimeout(invoke, 150);
    }
  };

  let currentPromise;
  const startWarmup = () => run().catch(err => {
    console.warn('Remote token cache warmup failed:', err);
    return { warmed: 0, total: subset.length, error: err };
  }).then(result => {
    remoteCacheWarmCompletedKey = datasetKey;
    return result;
  }).finally(() => {
    if (remoteCacheWarmPromise === currentPromise) {
      remoteCacheWarmPromise = null;
      remoteCacheWarmActiveKey = '';
    }
  });

  currentPromise = new Promise(resolve => {
    schedule(() => {
      startWarmup().then(resolve);
    });
  });

  remoteCacheWarmPromise = currentPromise;
  return currentPromise;
}

window.HLSF.remoteDb = RemoteDbStore;

try {
  const recorder = window.HLSF?.remoteDbRecorder;
  const storeReady = typeof RemoteDbStore.isReady === 'function' ? RemoteDbStore.isReady() : false;
  if (!storeReady && recorder && typeof RemoteDbStore.attachRecorder === 'function') {
    RemoteDbStore.attachRecorder(recorder);
  }
} catch (err) {
  console.warn('Initial remote DB recorder attachment failed:', err);
}

function onAdjacencyPreloadComplete(triggerToken, loadedTokens = []) {
  const normalizedTrigger = typeof triggerToken === 'string' ? triggerToken.toLowerCase() : '';
  const candidates = Array.isArray(loadedTokens) ? loadedTokens.filter(token => typeof token === 'string' && token.trim()) : [];
  let focusToken = null;
  if (normalizedTrigger) {
    focusToken = candidates.find(token => token.toLowerCase() === normalizedTrigger) || null;
  }
  if (!focusToken && candidates.length) {
    focusToken = candidates[candidates.length - 1];
  }
  if (!focusToken && normalizedTrigger) {
    focusToken = normalizedTrigger;
  }
  if (!focusToken) return;
  setDocumentFocusTokens([focusToken]);
  notifyHlsfAdjacencyChange('prompt-preload', { immediate: true });
}

function getCachedRecordForToken(token) {
  if (!token) return null;
  try {
    const raw = safeStorageGet(getCacheKey(token));
    if (!raw) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return null; }
    }
    return raw;
  } catch {
    return null;
  }
}

function computeLiveGraphEdges(nodes) {
  const edges = [];
  const activeTokens = Array.from(nodes.keys());
  const activeSet = new Set(activeTokens);
  const seen = new Set();

  for (const node of nodes.values()) {
    node.degree = 0;
  }

  for (const token of activeTokens) {
    if (!isTokenCached(token)) continue;
    const record = getCachedRecordForToken(token);
    if (!record || typeof record !== 'object') continue;
    const rels = record.relationships || {};
    const candidates = [];
    for (const [rawRel, arr] of Object.entries(rels)) {
      if (!Array.isArray(arr)) continue;
      const rel = normRelKey(rawRel) || rawRel;
      for (const relEntry of arr) {
        const neighbor = typeof relEntry?.token === 'string' ? relEntry.token.toLowerCase() : null;
        if (!neighbor || neighbor === token || !activeSet.has(neighbor)) continue;
        const weight = Number(relEntry.weight) || 0;
        candidates.push({ neighbor, weight, rel });
      }
    }
    candidates.sort((a, b) => b.weight - a.weight);
    const limit = Math.min(4, candidates.length);
    for (let i = 0; i < limit; i++) {
      const candidate = candidates[i];
      const from = token;
      const to = candidate.neighbor;
      const key = from < to ? `${from}->${to}->${candidate.rel}` : `${to}->${from}->${candidate.rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const edge = { from, to, rtype: candidate.rel, w: candidate.weight, hiddenTokens: [] };
      edges.push(edge);
      const fromNode = nodes.get(from);
      const toNode = nodes.get(to);
      if (fromNode) fromNode.degree = (fromNode.degree || 0) + 1;
      if (toNode) toNode.degree = (toNode.degree || 0) + 1;
    }
  }

  return edges;
}

function queueLiveGraphUpdate(delay = 120) {
  const ms = Number.isFinite(delay) ? Math.max(16, Math.floor(delay)) : 120;
  if (state.liveGraphUpdateTimer) return;
  state.liveGraphUpdateTimer = setTimeout(() => {
    state.liveGraphUpdateTimer = null;
    try {
      rebuildLiveGraph();
    } catch (err) {
      console.warn('Live graph update failed:', err);
    }
  }, ms);
}

function forcePromptLiveGraphPruning() {
  try {
    const totalTokens = Array.isArray(state.tokenOrder) ? state.tokenOrder.length : 0;
    if (totalTokens === 0) return;
    const result = rebuildLiveGraph({ render: false }) || {};
    const removed = Array.isArray(result.removedTokens) ? result.removedTokens : [];
    if (removed.length) {
      removeTokensFromCache(removed, { silent: true });
    }
  } catch (err) {
    console.warn('Prompt adjacency pruning failed:', err);
  }
}

let activeCompositeAnimation = null;

function stopHLSFAnimation() {
  try {
    if (activeCompositeAnimation !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(activeCompositeAnimation);
    }
  } catch (err) {
    console.warn('Failed to cancel HLSF animation frame:', err);
  } finally {
    activeCompositeAnimation = null;
  }

  try {
    const renderer = window.HLSF?.rendering;
    if (renderer && typeof renderer.stop === 'function') {
      renderer.stop();
    } else {
      stopLegacyHLSFAnimation();
    }
  } catch (err) {
    console.warn('Error while stopping HLSF animation:', err);
  }
}

function animateHLSF(graph, glyphOnly = false) {
  try {
    const renderer = window.HLSF?.rendering;
    if (renderer && typeof renderer.animate === 'function') {
      const result = renderer.animate(graph, glyphOnly === true);
      if (typeof result === 'number') {
        activeCompositeAnimation = result;
      }
      return;
    }

    const compositeAnimator = window?.animateComposite;
    if (typeof compositeAnimator === 'function') {
      const result = compositeAnimator(graph, glyphOnly === true);
      if (typeof result === 'number') {
        activeCompositeAnimation = result;
      }
      return;
    }

    if (typeof requestAnimationFrame === 'function') {
      activeCompositeAnimation = requestAnimationFrame(animateLegacyHLSF);
    }
  } catch (err) {
    console.warn('Unable to start HLSF animation:', err);
  }
}

function rebuildLiveGraph(options = {}) {
  const { render = true } = options;
  if (state.liveGraphUpdateTimer) {
    clearTimeout(state.liveGraphUpdateTimer);
    state.liveGraphUpdateTimer = null;
  }
  const graph = state.liveGraph || { nodes: new Map(), links: [] };
  state.liveGraph = graph;

  pruneInactiveTokens();
  const activeTokens = state.tokenOrder.slice();
  const nodes = new Map();
  activeTokens.forEach((token, index) => {
    const status = isTokenCached(token) ? 'cached' : 'unknown';
    nodes.set(token, {
      token,
      layer: 0,
      cluster: index,
      f: 1,
      status,
      color: status === 'cached' ? '#00ff88' : '#ff8800',
    });
  });

  graph.nodes = nodes;
  let edges = computeLiveGraphEdges(nodes);
  const pruneResult = pruneLiveGraphNodes(nodes, edges);
  edges = pruneResult.edges;
  graph.links = edges;
  graph.edges = edges;
  graph.nodeCount = nodes.size;
  graph.dimensionLayout = null;
  graph.live = true;
  graph.removedTokens = Array.isArray(pruneResult.removedTokens)
    ? pruneResult.removedTokens
    : [];

  if (!render) return graph;

  if (graph.nodeCount > 0) {
    state.hlsfReady = true;
    state.liveGraphMode = !getDb();
    if (state.liveGraphMode) {
      window.HLSF.config.layout = 'layered';
    }
    window.HLSF.currentGraph = graph;
    showVisualizer();
    animateHLSF(graph, false);
  } else if (!getDb()) {
    stopHLSFAnimation();
    hideVisualizer();
    window.HLSF.currentGraph = null;
  }

  return graph;
}

// ============================================
// OPENAI API
// ============================================
async function callOpenAI(messages, options = {}) {
  if (!state.apiKey) throw new Error('No API key configured');

  const body = {
    model: options.model || CONFIG.DEFAULT_MODEL,
    messages,
    max_tokens: options.max_tokens ?? CONFIG.MAX_TOKENS_PER_RESPONSE,
    temperature: options.temperature || 0.7,
  };

  let attempt = 0;
  while (attempt < CONFIG.MAX_RETRY_ATTEMPTS) {
    if (currentAbortController?.signal.aborted) {
      const error = new Error('Cancelled');
      error.name = 'AbortError';
      throw error;
    }

    attempt++;
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429 && attempt < CONFIG.MAX_RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)));
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `API error (${response.status})`;

        try {
          const errorData = JSON.parse(errorText);
          if (errorData.error?.message) errorMessage = errorData.error.message;
        } catch (e) {
          if (errorText) errorMessage = errorText;
        }

        if (response.status === 401) errorMessage = 'Invalid API key';
        else if (response.status === 403) errorMessage = 'Access forbidden - check billing setup';
        else if (response.status === 429) errorMessage = 'Rate limit exceeded';

        throw new Error(errorMessage);
      }

      const data = await response.json();
      state.sessionStats.totalApiCalls++;

      const content = data.choices?.[0]?.message?.content?.trim() || '';
      const usage = data.usage || {};
      const promptTokens = usage.prompt_tokens ?? estimateTokensForMessages(messages);
      const completionTokens = usage.completion_tokens ?? estimateTokensForText(content);
      const callCost = estimateCostUsd(promptTokens, completionTokens, body.model);
      state.sessionStats.totalCostUsd += callCost;
      updateStats();

      if (state.networkOffline) {
        state.networkOffline = false;
        state.networkErrorNotified = false;
        state.lastNetworkErrorTime = 0;
      }

      return content;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err.message === 'Failed to fetch') {
        throw new Error('Network error - check connection or download HTML to run locally');
      }
      if (attempt === CONFIG.MAX_RETRY_ATTEMPTS) throw err;
    }
  }
}

window.CognitionEngine.api = {
  callOpenAI,
};

// ============================================
// ADJACENCY
// ============================================
class ProgressTracker {
  constructor(total, label) {
    const initialTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
    this.total = Math.max(1, initialTotal);
    this.current = 0;
    this.label = label;
    this.element = logStatus(`⏳ ${label} (0/${this.total})`);
  }

  increment(count = 1) {
    this.current += count;
    if (this.current > this.total) {
      this.total = this.current;
    }
    const percent = this.total === 0 ? 100 : Math.round((this.current / this.total) * 100);
    if (this.element) {
      this.element.innerHTML = `⏳ ${this.label} (${this.current}/${this.total}) - ${percent}%`;
    }
  }

  addTotal(count = 0) {
    if (!Number.isFinite(count) || count <= 0) return;
    this.total += Math.floor(count);
    if (this.total < this.current) {
      this.total = this.current;
    }
    const percent = this.total === 0 ? 100 : Math.round((this.current / this.total) * 100);
    if (this.element) {
      this.element.innerHTML = `⏳ ${this.label} (${this.current}/${this.total}) - ${percent}%`;
    }
  }

  complete(message) {
    if (this.element) {
      this.element.innerHTML = `✅ ${message || `${this.label} complete`}`;
    }
  }
}

const realWordValidationCache = new Map();

async function validateTokenIsRealWord(token) {
  const normalized = (token == null ? '' : String(token)).trim();
  if (!normalized) return false;

  const cacheKey = normalized.toLowerCase();
  const cached = realWordValidationCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached && typeof cached.then === 'function') return cached;
    return cached;
  }

  if (!state.apiKey) {
    realWordValidationCache.set(cacheKey, true);
    return true;
  }

  const validationPromise = (async () => {
    const prompt = `Token: "${normalized}"
Determine whether this token is a valid standalone English word (proper nouns count as real words).
Respond strictly with JSON: {"token": "${normalized}", "is_real_word": true | false}.`;

    const content = await safeAsync(
      () => callOpenAI([
        { role: 'system', content: 'You are a linguistic validator that answers with strict JSON.' },
        { role: 'user', content: prompt },
      ], { temperature: 0, max_tokens: 40 }),
      `Real word validation failed for ${normalized}`,
      { fallbackValue: null }
    );

    if (!content) return true;

    try {
      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) return true;
      const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.is_real_word === 'boolean') return parsed.is_real_word;
        if (typeof parsed.real_word === 'boolean') return parsed.real_word;
      }
    } catch (err) {
      console.warn('Failed to parse real word validation result for', normalized, err);
    }

    return true;
  })();

  realWordValidationCache.set(cacheKey, validationPromise);

  let result;
  try {
    result = await validationPromise;
  } catch {
    realWordValidationCache.delete(cacheKey);
    return true;
  }

  const finalResult = result === false ? false : true;
  realWordValidationCache.set(cacheKey, finalResult);
  return finalResult;
}

async function filterVariantRelationships(entry) {
  if (!entry || typeof entry !== 'object') return { entry, removed: 0 };

  const relationships = entry.relationships;
  if (!relationships || typeof relationships !== 'object') return { entry, removed: 0 };

  const variantKeys = Object.keys(relationships).filter(key => {
    if (!key) return false;
    if (key === '≈') return true;
    return key.toLowerCase().includes('variant');
  });

  if (!variantKeys.length) return { entry, removed: 0 };

  let removed = 0;

  for (const key of variantKeys) {
    const edges = Array.isArray(relationships[key]) ? relationships[key] : null;
    if (!edges || edges.length === 0) continue;

    const evaluations = await Promise.all(edges.map(async (edge) => {
      const candidate = (edge && typeof edge.token === 'string') ? edge.token.trim() : '';
      if (!candidate) return { edge, keep: false };
      const isReal = await validateTokenIsRealWord(candidate);
      return { edge, keep: isReal !== false };
    }));

    const filtered = evaluations
      .filter(item => item.keep && item.edge)
      .map(item => item.edge);

    removed += edges.length - filtered.length;
    relationships[key] = filtered;
  }

  return { entry, removed };
}

async function fetchAdjacency(entry, context) {
  if (currentAbortController?.signal.aborted) {
    throw new Error('AbortError');
  }

  const baseToken = typeof entry === 'string' ? entry : entry?.token;
  const token = String(baseToken || '').trim();
  if (!token) return { token: '', relationships: {}, error: 'invalid_token' };

  const kind = typeof entry === 'object' && entry && entry.kind ? entry.kind : 'word';
  const cat = typeof entry === 'object' && entry ? entry.cat || null : null;

  let cached = getFromCache(token);
  if (!cached && window.HLSF?.remoteDb?.isReady?.()
    && typeof window.HLSF.remoteDb.preloadTokens === 'function') {
    try {
      const preloadStats = await window.HLSF.remoteDb.preloadTokens([token]);
      if (preloadStats && (Number(preloadStats.loaded) > 0 || Number(preloadStats.hits) > 0)) {
        cached = getFromCache(token);
      }
    } catch (err) {
      console.warn('Remote DB preload failed for token', token, err);
    }
  }

  if (cached) {
    const { entry: filteredCached, removed } = await filterVariantRelationships(cached);
    if (removed > 0) {
      saveToCache(token, filteredCached, { deferReload: true });
    }
    return { ...filteredCached, cache_hit: true, kind };
  }

  if (!state.apiKey) return { token, relationships: {}, offline: true };

  if (kind === 'sym') {
    return {
      token,
      relationships: {},
      cache_hit: true,
      offline: true,
      kind,
      symbol: { cat },
    };
  }

  const roleLine = kind === 'sym' ? 'Role: "symbol"' : 'Role: "word"';
  const categoryLine = cat ? `\nCategory: "${cat}"` : '';
  const prompt = `Token: "${token}"
${roleLine}${categoryLine}
Context: "${context}"

For this token, identify the most relevant adjacent tokens across relationship types. For each that applies, provide related tokens with weights 0.01-1.00.

Relationship types: ≡ Identity, ⊃ Contains, ⊂ Is Contained By, ≈ Variant, ∈ Is Instance Of, ∋ Has Instance, ⊤ Is Type Of, ⊥ Has Type, ⊏ Part Of, ⊐ Composes, ↔ Mirrors, ⇌ Inverts, ∥ Parallel To, ∼ Adjacent To, → Next, ⇒ Sequence Of, ⇐ Preceded By, ↠ Follows, ↗ Spatially Above, ↘ Spatially Below, ⇝ Symbolically Supports, ⇂ Symbolically Depends, ≠ Contrasts, ⊕ Complements, ⊛ Associated With, ∝ Correlates With, ⇝ Causes, ⇐ Caused By, ∗ Evokes, ≜ Represents, ⋆ Symbolizes, 7→ Refers To, ⊢ Defines, ⊣ Is Defined By, ↷ Transforms To, ↶ Transformed From, ◦ Functions As, |= Interpreted As, ◁ Used With, ⇄ Co-occurs With, ⊗ Synthesizes, ÷ Divides Into, ⊘ Opposes, × Rejects, ¬ Negates, † Destroys, ⊠ Blocks, /∈ Invalidates, ⊬ Contradicts, ⊩ Asserts, ⊨ Provides Evidence, ? Uncertainty, ⚡ Memory, ⇒ Attention, ↶ Self-Reference, ∧ Perspective, ↭ Continuity, ▷◁ Relationality

Return JSON: {"token": "${token}", "relationships": {"≡": [{"token": "...", "weight": 0.95}], ...}}`;

  let safePrompt;
  try {
    safePrompt = validatePrompt(prompt);
  } catch (err) {
    logError(`Prompt validation failed for ${token}: ${err.message}`);
    return { token, relationships: {}, error: 'invalid_prompt' };
  }

  if (state.networkOffline && state.lastNetworkErrorTime) {
    const elapsed = Date.now() - state.lastNetworkErrorTime;
    if (elapsed < CONFIG.NETWORK_RETRY_BACKOFF_MS) {
      return { token, relationships: {}, offline: true, error: 'network_offline' };
    }
  }

  const content = await safeAsync(
    () => callOpenAI([
      { role: 'system', content: 'You are an HLSF token adjacency analyzer.' },
      { role: 'user', content: safePrompt },
    ]),
    `Adjacency fetch failed for ${token}`,
    { dedupeNetworkError: true }
  );

  if (!content) {
    return { token, relationships: {}, error: 'request_failed' };
  }

  try {
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
    const { entry: filtered } = await filterVariantRelationships(parsed);
    saveToCache(token, filtered, { deferReload: true });
    return { ...filtered, cache_hit: false, kind };
  } catch {
    return { token, relationships: {}, error: 'Parse failed' };
  }
}

function normalizeAdjacencyInputs(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const unique = new Map();
  for (const entry of list) {
    if (entry == null) continue;
    if (typeof entry === 'object') {
      const token = entry.token ? String(entry.token).trim() : '';
      if (!token) continue;
      const kind = entry.kind || 'word';
      const key = `${kind}:${token}`;
      if (!unique.has(key)) unique.set(key, { token, kind, cat: entry.cat || null });
    } else {
      const token = String(entry).trim();
      if (!token) continue;
      const key = `word:${token.toLowerCase()}`;
      if (!unique.has(key)) unique.set(key, { token: token.toLowerCase(), kind: 'word' });
    }
  }
  return Array.from(unique.values());
}

function resolveAdjacencyConcurrency(base = CONFIG.MAX_CONCURRENCY) {
  if (Number.isFinite(base) && base <= 0) base = 1;
  const configured = window?.HLSF?.config?.adjacencyConcurrency;
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.floor(configured));
  }
  const hardware = typeof navigator !== 'undefined'
    && navigator
    && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 0;
  if (Number.isFinite(hardware) && hardware > 0) {
    const derived = Math.max(1, Math.round(hardware * 0.75));
    const clamped = Math.min(12, derived);
    return Math.max(Math.floor(base), clamped);
  }
  return Math.max(1, Math.floor(base));
}

async function batchFetchAdjacencies(tokens, context, label) {
  CacheBatch.begin();
  try {
    const results = new Map();
    const normalized = normalizeAdjacencyInputs(tokens);

    const remoteTargets = [];
    for (const entry of normalized) {
      if (entry.kind === 'sym') {
        results.set(entry.token, {
          token: entry.token,
          relationships: {},
          kind: entry.kind,
          offline: true,
          cache_hit: true,
          symbol: { cat: entry.cat || null },
        });
      } else {
        remoteTargets.push(entry);
      }
    }

    if (window.HLSF?.remoteDb?.isReady?.()) {
      try {
        await window.HLSF.remoteDb.preloadTokens(remoteTargets.map(entry => entry.token));
      } catch (err) {
        console.warn('Remote DB preload failed:', err);
      }
    }

    const progress = new ProgressTracker(remoteTargets.length, label);

    const concurrency = resolveAdjacencyConcurrency(CONFIG.MAX_CONCURRENCY);
    let processed = 0;
    for (let i = 0; i < remoteTargets.length; i += concurrency) {
      if (currentAbortController?.signal.aborted) {
        progress.complete(`${label} cancelled (${processed}/${remoteTargets.length})`);
        break;
      }

      const batch = remoteTargets.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map(entry => fetchAdjacency(entry, context)));

      settled.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          results.set(batch[idx].token, result.value);
        }
      });

      processed += batch.length;
      progress.increment(batch.length);
    }

    const hits = Array.from(results.values()).filter(r => r.cache_hit).length;
    progress.complete(`${label}: ${hits} cached, ${results.size - hits} new`);
    return results;
  } finally {
    CacheBatch.end();
  }
}

function formatTokenList(tokens, limit = 12) {
  const unique = [];
  const seen = new Set();
  for (const entry of Array.isArray(tokens) ? tokens : []) {
    if (!entry) continue;
    const value = String(entry).trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }

  if (!unique.length) return '';

  const capped = unique.slice(0, Math.max(1, limit));
  const extra = unique.length - capped.length;
  const base = capped.join(', ');
  return extra > 0 ? `${base} +${extra} more` : base;
}

function gatherLevelUpSeeds(graph: any, anchors: string[], maxSeeds: number): string[] {
  const limit = Math.max(maxSeeds, anchors.length);
  const seen = new Set<string>();
  const seeds: string[] = [];

  const addSeed = (token: unknown) => {
    const value = typeof token === 'string' ? token.trim() : '';
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    seeds.push(value);
  };

  for (const anchor of anchors) addSeed(anchor);

  const adjacency = new Map<string, { token: string; weight: number }[]>();
  const pushNeighbor = (source: unknown, target: unknown, weight: number) => {
    const from = typeof source === 'string' ? source.trim() : '';
    const to = typeof target === 'string' ? target.trim() : '';
    if (!from || !to) return;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push({ token: to, weight });
  };

  const links = Array.isArray(graph?.links) ? graph.links : [];
  for (const link of links) {
    if (!link) continue;
    const weight = Number(link.w);
    const normalizedWeight = Number.isFinite(weight) ? weight : 0;
    pushNeighbor(link.from, link.to, normalizedWeight);
    pushNeighbor(link.to, link.from, normalizedWeight);
  }

  for (const list of adjacency.values()) {
    list.sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
  }

  const spawnLimit = Math.max(1, Math.floor(CONFIG.ADJACENCY_SPAWN_LIMIT) || 1);
  for (const anchor of anchors) {
    const list = adjacency.get(anchor) || [];
    for (let i = 0; i < list.length && i < spawnLimit; i += 1) {
      addSeed(list[i].token);
      if (seeds.length >= limit) break;
    }
    if (seeds.length >= limit) break;
  }

  if (seeds.length < limit) {
    const global: { token: string; weight: number }[] = [];
    adjacency.forEach(list => {
      for (const entry of list) global.push(entry);
    });
    global.sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
    for (const entry of global) {
      addSeed(entry.token);
      if (seeds.length >= limit) break;
    }
  }

  if (seeds.length < limit && graph?.nodes instanceof Map) {
    const nodes = Array.from(graph.nodes.values());
    nodes.sort((a, b) => (Number(b?.degree) || 0) - (Number(a?.degree) || 0));
    for (const node of nodes) {
      const token = typeof node?.token === 'string'
        ? node.token
        : typeof node?.id === 'string'
          ? node.id
          : '';
      addSeed(token);
      if (seeds.length >= limit) break;
    }
  }

  return seeds.slice(0, limit);
}

const levelUpState = { running: false };

async function levelUpHlsfGraph(options: { root?: HTMLElement | null } = {}) {
  if (levelUpState.running) {
    logWarning('Complete graph level up already running.');
    return;
  }

  levelUpState.running = true;
  const root = options.root instanceof HTMLElement ? options.root : document.getElementById('hlsf-canvas-container');
  let status: HTMLElement | null = null;

  try {
    const graph = window.HLSF?.currentGraph;
    const last = window.HLSF?.lastCommand;
    if (!graph || !last) {
      logWarning('No active HLSF graph to level up. Run /hlsf first.');
      return;
    }

    let index = last.idx;
    if (!(index instanceof Map)) {
      try {
        index = await loadOrGetIndex();
      } catch (err) {
        console.warn('Level up index refresh failed:', err);
      }
    }
    if (!(index instanceof Map)) {
      logWarning('Unable to access HLSF index for level up.');
      return;
    }
    last.idx = index;

    const currentDepth = Number.isFinite(last.depth) ? Math.floor(last.depth) : getRecursionDepthSetting();
    let desiredDepth = clampRecursionDepth(currentDepth + 1);

    const input = root?.querySelector<HTMLInputElement>('#hlsf-recursion-depth') || null;
    const depthLabel = root?.querySelector<HTMLElement>('#hlsf-recursion-depth-val') || null;
    if (input) {
      const requested = clampRecursionDepth(input.value);
      if (String(requested) !== input.value) {
        input.value = String(requested);
      }
      if (requested > currentDepth) {
        desiredDepth = requested;
      }
    }

    if (desiredDepth <= currentDepth) {
      logStatus(`Recursion depth already at ${currentDepth}. Increase the depth value to expand further.`);
      if (input) input.value = String(currentDepth);
      if (depthLabel) depthLabel.textContent = String(currentDepth);
      return;
    }

    const appliedDepth = applyRecursionDepthSetting(desiredDepth);
    if (input) input.value = String(appliedDepth);
    if (depthLabel) depthLabel.textContent = String(appliedDepth);
    last.depth = appliedDepth;

    const anchors = Array.isArray(last.anchors)
      ? last.anchors.map(anchor => (typeof anchor === 'string' ? anchor.trim() : '')).filter(Boolean)
      : [];
    const seeds = gatherLevelUpSeeds(graph, anchors, MAX_LEVEL_UP_SEEDS);
    if (!seeds.length) {
      logWarning('No candidate tokens available for level up.');
      return;
    }

    const normalizedSeeds = normalizeAdjacencyInputs(seeds);
    if (!normalizedSeeds.length) {
      logWarning('No valid seeds available for level up.');
      return;
    }

    const anchorPreview = anchors.length ? formatTokenList(anchors, 6) : '';
    const contextPieces = [
      `Level-up from depth ${currentDepth} to ${appliedDepth}`,
      anchorPreview ? `Anchors: ${anchorPreview}` : '',
    ].filter(Boolean);
    const context = contextPieces.join('. ');
    const label = `graph level-up depth ${appliedDepth}`;
    status = logStatus(`Leveling graph to depth ${appliedDepth} (${normalizedSeeds.length} seed${normalizedSeeds.length === 1 ? '' : 's'})…`);

    const recursionResult = await fetchRecursiveAdjacencies(
      normalizedSeeds,
      context,
      label,
      {
        depth: appliedDepth,
        normalizedSeeds,
        preferDb: true,
        onTokenLoaded: () => queueLiveGraphUpdate(48),
        requireCompleteGraph: false,
      },
    );

    if (recursionResult?.matrices instanceof Map && recursionResult.matrices.size) {
      window.HLSF.matrices = mergeAdjacencyMaps(window.HLSF.matrices, recursionResult.matrices);
    }

    const stats = recursionResult?.stats || {};
    const summaryParts = [
      `visited ${stats.visitedTokens ?? 0}`,
      `expansions ${stats.expansions ?? 0}`,
      `API ${stats.apiCalls ?? 0}`,
    ];
    addLog(`<div class="adjacency-insight"><strong>🔺 Graph level up:</strong> ${sanitize(summaryParts.join(' · '))}</div>`);

    if (status) {
      status.textContent = `✅ Level up complete at depth ${appliedDepth}.`;
    }

    await rebuildHlsfFromLastCommand(true);
  } catch (err) {
    if (status) {
      status.textContent = `❌ Level up failed: ${err?.message || err}`;
    }
    logError(`Complete graph level up failed: ${err?.message || err}`);
  } finally {
    levelUpState.running = false;
  }
}

function limitAdjacencyEntryEdges(
  entry,
  maxEdges,
  priorityTokens = [],
) {
  if (!entry || typeof entry !== 'object') return entry;

  const configuredLimit = Number.isFinite(maxEdges) && maxEdges > 0 ? Math.floor(maxEdges) : 0;
  const priorityMap = new Map();
  if (priorityTokens && typeof (priorityTokens as any)[Symbol.iterator] === 'function') {
    for (const value of priorityTokens) {
      let token = '';
      if (typeof value === 'string') {
        token = value.trim();
      } else if (value && typeof value === 'object' && typeof value.token === 'string') {
        token = value.token.trim();
      }
      if (!token) continue;
      const key = token.toLowerCase();
      if (!priorityMap.has(key)) {
        priorityMap.set(key, token);
      }
    }
  }

  const defaultEdgeLimit = Number.isFinite(CONFIG.ADJACENCY_EDGES_PER_LEVEL)
    ? Math.max(0, Math.floor(CONFIG.ADJACENCY_EDGES_PER_LEVEL))
    : 0;
  let hardEdgeLimit = configuredLimit > 0 ? configuredLimit : defaultEdgeLimit;
  if (defaultEdgeLimit > 0) {
    hardEdgeLimit = Math.min(hardEdgeLimit || defaultEdgeLimit, defaultEdgeLimit);
  }

  const relationshipCap = Number.isFinite(CONFIG.ADJACENCY_RELATIONSHIPS_PER_NODE)
    ? Math.max(0, Math.floor(CONFIG.ADJACENCY_RELATIONSHIPS_PER_NODE))
    : 0;
  if (relationshipCap > 0) {
    const maxEdgesFromRelationships = Math.max(1, Math.floor(relationshipCap / 2));
    hardEdgeLimit = hardEdgeLimit > 0 ? Math.min(hardEdgeLimit, maxEdgesFromRelationships) : maxEdgesFromRelationships;
  }

  if (hardEdgeLimit <= 0 && priorityMap.size === 0) {
    return { ...entry, relationships: {} };
  }
  if (hardEdgeLimit <= 0) {
    hardEdgeLimit = Math.max(1, Math.min(priorityMap.size, relationshipCap > 0 ? Math.max(1, Math.floor(relationshipCap / 2)) : priorityMap.size));
  }

  const relationshipLimit = relationshipCap > 0 ? relationshipCap : hardEdgeLimit * 2;

  const entryToken = typeof entry.token === 'string' ? entry.token.trim() : '';
  const entryKey = entryToken ? entryToken.toLowerCase() : '';
  const isSeedEntry = entryKey && priorityMap.has(entryKey);

  const aggregated = [];
  const rels = entry.relationships && typeof entry.relationships === 'object' ? entry.relationships : {};
  for (const [rel, edges] of Object.entries(rels)) {
    if (!Array.isArray(edges)) continue;
    for (const edge of edges) {
      if (!edge || !edge.token) continue;
      const token = String(edge.token).trim();
      if (!token) continue;
      const normalized = token.toLowerCase();
      aggregated.push({
        relation: rel,
        token,
        normalized,
        weight: Number(edge.weight) || 0,
        priority: priorityMap.has(normalized) && normalized !== entryKey,
      });
    }
  }

  aggregated.sort((a, b) => b.weight - a.weight);

  const selected = [];
  const seenPairs = new Set();
  const selectedTokenKeys = new Set();

  const pushEdge = (item) => {
    if (!item || !item.token) return false;
    if (hardEdgeLimit > 0 && selected.length >= hardEdgeLimit) return false;
    const pairKey = `${item.relation}|${item.normalized}`;
    if (seenPairs.has(pairKey)) return false;
    seenPairs.add(pairKey);
    selected.push(item);
    selectedTokenKeys.add(item.normalized);
    return true;
  };

  for (const item of aggregated) {
    if (!item.priority) continue;
    pushEdge(item);
  }

  for (const item of aggregated) {
    if (selected.length >= hardEdgeLimit) break;
    pushEdge(item);
  }

  if (isSeedEntry && priorityMap.size > 1) {
    for (const [key, token] of priorityMap.entries()) {
      if (key === entryKey) continue;
      if (selectedTokenKeys.has(key)) continue;
      const synthetic = {
        relation: 'seed-link',
        token,
        normalized: key,
        weight: 0.001,
        priority: true,
      };
      pushEdge(synthetic);
    }
  }

  const relationships = {};
  const finalEdges = relationshipLimit > 0 ? selected.slice(0, relationshipLimit) : selected;
  for (const item of finalEdges) {
    if (!item.token) continue;
    if (!relationships[item.relation]) relationships[item.relation] = [];
    relationships[item.relation].push({ token: item.token, weight: item.weight });
  }

  return {
    ...entry,
    relationships,
  };
}

function collectNeighborCandidates(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const rels = entry.relationships && typeof entry.relationships === 'object' ? entry.relationships : {};
  const seen = new Set();
  const candidates = [];
  for (const edges of Object.values(rels)) {
    if (!Array.isArray(edges)) continue;
    for (const edge of edges) {
      if (!edge || !edge.token) continue;
      const token = String(edge.token).trim();
      if (!token) continue;
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ token, weight: Number(edge.weight) || 0 });
    }
  }
  candidates.sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));
  return candidates;
}

function selectHighAttentionNeighbors(entry, limit = 2) {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const candidates = collectNeighborCandidates(entry);
  if (!candidates.length) return [];
  const max = Math.max(0, Math.floor(limit));
  return candidates.slice(0, max);
}

function countEntryRelationships(entry) {
  if (!entry || typeof entry !== 'object') {
    return { edgeCount: 0, relationTypes: 0 };
  }
  const rels = entry.relationships && typeof entry.relationships === 'object' ? entry.relationships : {};
  let relationTypes = 0;
  let edgeCount = 0;
  for (const edges of Object.values(rels)) {
    if (!Array.isArray(edges) || edges.length === 0) continue;
    relationTypes += 1;
    edgeCount += edges.length;
  }
  return { edgeCount, relationTypes };
}

function deterministicSyntheticNeighbors(token, needed, excludeSet, baseWeight) {
  if (!needed || needed <= 0) return [];
  const base = (token || '').trim() || 'thought';
  const suffixes = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν'];
  const proposals = [];
  let index = 0;
  while (proposals.length < needed) {
    const suffix = index < suffixes.length ? suffixes[index] : String(index + 1);
    const candidate = `${base} ${suffix}`.trim();
    const normalized = candidate.toLowerCase();
    if (!excludeSet.has(normalized)) {
      excludeSet.add(normalized);
      proposals.push({ token: candidate, weight: baseWeight });
    }
    index += 1;
    if (index > 64) break;
  }
  return proposals.slice(0, needed);
}

async function requestSyntheticNeighbors(token, context, needed, excludeSet, baseWeight) {
  if (!token || needed <= 0 || !state.apiKey) {
    return [];
  }

  const safeContext = (context || '').slice(0, 320);
  const prompt = `Seed token: "${token}"
Context: "${safeContext}"
Generate ${Math.max(needed * 2, 4)} unique adjacency expansions that would connect bi-directionally with the seed token inside the Hierarchical Latent Semantic Framework. Prefer concise single or dual-word tokens.
Respond strictly with JSON: {"seed":"${token}","expansions":[{"token":"...","weight":0.42}]}`;

  const content = await safeAsync(
    () => callOpenAI([
      { role: 'system', content: 'You expand the HLSF adjacency lattice by proposing tightly-coupled tokens.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.35, max_tokens: 220 }),
    `Adjacency expansion synthesis failed for ${token}`,
    { fallbackValue: null },
  );

  if (!content) return [];

  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(content.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.expansions)) {
      return [];
    }
    const expansions = [];
    for (const entry of parsed.expansions) {
      if (!entry || typeof entry !== 'object' || typeof entry.token !== 'string') continue;
      const candidate = entry.token.trim();
      if (!candidate) continue;
      const normalized = candidate.toLowerCase();
      if (excludeSet.has(normalized)) continue;
      excludeSet.add(normalized);
      const weight = Number(entry.weight);
      expansions.push({ token: candidate, weight: Number.isFinite(weight) ? weight : baseWeight });
    }
    return expansions.slice(0, needed);
  } catch (err) {
    console.warn('Failed to parse synthetic adjacency expansion for', token, err);
  }

  return [];
}

function mergeSyntheticRelationships(entry, syntheticEdges, minWeight) {
  if (!syntheticEdges.length) return entry;
  const relationships = entry?.relationships && typeof entry.relationships === 'object'
    ? Object.fromEntries(Object.entries(entry.relationships).map(([rel, edges]) => [
      rel,
      Array.isArray(edges)
        ? edges.map(edge => ({ token: String(edge.token || '').trim(), weight: Number(edge.weight) || 0 }))
        : [],
    ]))
    : {};

  const targetRel = GLOBAL_CONNECTION_RELATION;
  const existing = Array.isArray(relationships[targetRel])
    ? relationships[targetRel].slice()
    : [];
  const seen = new Set(existing.map(edge => (edge?.token || '').toLowerCase()));
  for (const edge of syntheticEdges) {
    const rawToken = typeof edge.token === 'string' ? edge.token.trim() : '';
    if (!rawToken) continue;
    const normalized = rawToken.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const weight = Number.isFinite(edge.weight)
      ? Math.max(minWeight, edge.weight)
      : minWeight;
    existing.push({ token: rawToken, weight });
  }
  if (existing.length) {
    existing.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    relationships[targetRel] = existing;
  }
  return { ...entry, relationships };
}

async function synthesizeBranchNeighbors(entry, needed, context, excludeSet, minWeight) {
  if (!entry || needed <= 0) return [];
  const token = typeof entry.token === 'string' ? entry.token.trim() : '';
  if (!token) return [];
  const normalizedToken = token.toLowerCase();
  const contextKey = (context || '').slice(0, 96).toLowerCase();
  const cacheKey = `${normalizedToken}|${contextKey}`;

  if (!SYNTHETIC_BRANCH_CACHE.has(cacheKey)) {
    SYNTHETIC_BRANCH_CACHE.set(cacheKey, []);
  }

  const cached = SYNTHETIC_BRANCH_CACHE.get(cacheKey) || [];
  const available = cached.filter(item => !excludeSet.has(item.token.toLowerCase()));

  let remaining = needed - available.length;
  let generated = [];

  if (remaining > 0) {
    const llmGenerated = await requestSyntheticNeighbors(token, context, remaining, excludeSet, minWeight);
    if (llmGenerated.length) {
      cached.push(...llmGenerated);
      generated.push(...llmGenerated);
      remaining -= llmGenerated.length;
    }
  }

  if (remaining > 0) {
    const deterministic = deterministicSyntheticNeighbors(token, remaining, excludeSet, minWeight);
    if (deterministic.length) {
      cached.push(...deterministic);
      generated.push(...deterministic);
      remaining -= deterministic.length;
    }
  }

  const combined = cached.filter(item => !excludeSet.has(item.token.toLowerCase()))
    .slice(0, needed);

  return { neighbors: combined, generated };
}

async function enforceEntryBranching(entry, spawnLimit, context) {
  const limit = Math.max(2, Math.floor(spawnLimit || 2));
  const existingNeighbors = collectNeighborCandidates(entry);
  const minWeight = Number(activeSettings().pruneWeightThreshold) || 0.18;
  const exclude = new Set(existingNeighbors.map(item => item.token.toLowerCase()));
  const tokenKey = typeof entry.token === 'string' ? entry.token.toLowerCase() : '';
  if (tokenKey) exclude.add(tokenKey);

  let updatedEntry = entry;
  let syntheticNeighbors = [];

  if (existingNeighbors.length < limit) {
    const needed = limit - existingNeighbors.length;
    const { neighbors, generated } = await synthesizeBranchNeighbors(entry, needed, context, exclude, minWeight);
    syntheticNeighbors = generated;
    if (neighbors.length) {
      updatedEntry = mergeSyntheticRelationships(entry, neighbors, minWeight);
    }
  }

  const finalNeighbors = collectNeighborCandidates(updatedEntry);
  return {
    entry: updatedEntry,
    neighbors: finalNeighbors.slice(0, Math.max(limit, finalNeighbors.length ? limit : 0)),
    syntheticNeighbors,
  };
}

async function fetchRecursiveAdjacencies(tokens, context, label, options = {}) {
  CacheBatch.begin();
  try {
    const normalized = Array.isArray(options.normalizedSeeds)
      ? options.normalizedSeeds
      : normalizeAdjacencyInputs(tokens);
    const depth = Number.isFinite(options.depth) && options.depth > 0
      ? Math.floor(options.depth)
      : CONFIG.ADJACENCY_RECURSION_DEPTH;
    const edgesPerLevel = Number.isFinite(options.edgesPerLevel) && options.edgesPerLevel > 0
      ? Math.floor(options.edgesPerLevel)
      : CONFIG.ADJACENCY_EDGES_PER_LEVEL;
    const concurrency = Number.isFinite(options.concurrency) && options.concurrency > 0
      ? Math.max(1, Math.floor(options.concurrency))
      : resolveAdjacencyConcurrency(CONFIG.MAX_CONCURRENCY);
    const onTokenLoaded = typeof options.onTokenLoaded === 'function' ? options.onTokenLoaded : null;
    const preferDb = options.preferDb === true;
    const dbRecordIndex = preferDb && options.dbRecordIndex instanceof Map
      ? options.dbRecordIndex
      : null;
    const configuredSpawnLimit = Number.isFinite(options.spawnLimit) && options.spawnLimit > 0
      ? Math.floor(options.spawnLimit)
      : CONFIG.ADJACENCY_SPAWN_LIMIT;
    const spawnLimit = Math.max(
      1,
      Math.min(
        configuredSpawnLimit || CONFIG.ADJACENCY_SPAWN_LIMIT,
        Math.max(1, CONFIG.ADJACENCY_SPAWN_LIMIT),
      ),
    );
    const stopWhenConnected = options.stopWhenConnected === true;
    const requireCompleteGraph = options.requireCompleteGraph !== false;
    const remoteDbStore = window.HLSF?.remoteDb;
    const remoteDb = preferDb ? remoteDbStore : null;
    const settingsCaps = activeSettings();
    const nodeCap = Math.max(1, Math.floor(Number(settingsCaps?.maxNodes) || 1600));
    const edgeCap = Math.max(0, Math.floor(Number(settingsCaps?.maxEdges) || 0));
    const relationshipCapSetting = resolveHlsfRelationshipBudget(settingsCaps?.maxRelationships ?? null);
    const relationshipCap = relationshipCapSetting === Infinity
      ? Infinity
      : Math.max(0, Number(relationshipCapSetting) || 0);
    let totalEdgeCount = 0;
    let totalRelationTypes = 0;

    const seedTokensForPreload = normalized
      .map(entry => (entry && entry.token ? String(entry.token).trim() : ''))
      .filter(Boolean);
    if (seedTokensForPreload.length
      && remoteDbStore
      && typeof remoteDbStore.isReady === 'function'
      && remoteDbStore.isReady()
      && typeof remoteDbStore.preloadTokens === 'function') {
      try {
        await remoteDbStore.preloadTokens(seedTokensForPreload);
      } catch (err) {
        console.warn('Remote DB preload failed for seed tokens:', err);
      }
    }

    const queue = [];
    const enqueued = new Set();
    for (const entry of normalized) {
      const token = String(entry.token || '').trim();
      if (!token) continue;
      const key = token.toLowerCase();
      if (enqueued.has(key)) continue;
      queue.push({ entry, depthRemaining: depth });
      enqueued.add(key);
    }

    const visited = new Set();
    const results = new Map();
    const cacheHitTokens = new Set();
    const llmGeneratedTokens = new Set();
    const offlineTokens = new Set();
    const errorTokens = new Set();
    const syntheticNeighborsGenerated = new Set();
    const stats = {
      seedCount: queue.length,
      depth,
      edgesPerLevel,
      expansions: 0,
      apiCalls: 0,
      fetchCount: 0,
      visitedTokens: 0,
      syntheticExpansions: 0,
    };

    const checkConnectivity = stopWhenConnected;
    let lastConnectivitySnapshot = null;
    let lastConnectivitySize = 0;
    let connectivitySatisfied = false;

    const totalSteps = Math.max(1, queue.length);
    const progress = new ProgressTracker(totalSteps, label || 'adjacency recursion');

    const processEntry = async (item) => {
      if (!item || !item.entry) {
        return { item, result: null, fetchAttempted: false };
      }

      const token = item.token;

      if (item.entry.kind === 'sym') {
        return {
          item,
          result: {
            token,
            relationships: {},
            kind: item.entry.kind,
            offline: true,
            cache_hit: true,
            symbol: { cat: item.entry.cat || null },
          },
          fetchAttempted: false,
        };
      }

      if (preferDb && !isTokenCached(token)) {
        let staged = false;
        const normalizedKey = token.toLowerCase();
        if (!staged && dbRecordIndex && dbRecordIndex.has(normalizedKey)) {
          const record = dbRecordIndex.get(normalizedKey);
          if (record && record.relationships && Object.keys(record.relationships).length) {
            staged = stageDbRecordForCache(record) || staged;
          }
        }
        if (!staged && remoteDb && typeof remoteDb.isReady === 'function' && remoteDb.isReady()
          && typeof remoteDb.preloadTokens === 'function') {
          try {
            const preloadStats = await remoteDb.preloadTokens([token]);
            if (preloadStats && (Number(preloadStats.loaded) > 0 || Number(preloadStats.hits) > 0)) {
              staged = true;
            }
          } catch (err) {
            console.warn('Remote DB preload failed during recursion for', token, err);
          }
        }
      }

      try {
        const result = await fetchAdjacency(item.entry, context);
        return { item, result, fetchAttempted: true };
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        console.warn('Adjacency fetch failed during recursion for', token, err);
        return { item, result: null, error: err, fetchAttempted: true };
      }
    };

    while (queue.length) {
      if (currentAbortController?.signal.aborted) {
        progress.complete(`${label || 'adjacency recursion'} cancelled after ${visited.size} tokens`);
        break;
      }

      const batch = [];
      while (batch.length < concurrency && queue.length) {
        const current = queue.shift();
        if (!current || !current.entry) {
          progress.increment(1);
          continue;
        }

        const token = String(current.entry.token || '').trim();
        if (!token) {
          progress.increment(1);
          continue;
        }

        const key = token.toLowerCase();
        enqueued.delete(key);
        if (visited.has(key)) {
          progress.increment(1);
          continue;
        }
        visited.add(key);

        batch.push({ entry: current.entry, depthRemaining: current.depthRemaining, token, key });
      }

      if (!batch.length) continue;

      const responses = await Promise.all(batch.map(processEntry));

      for (const response of responses) {
        const item = response.item;
        if (!item) {
          progress.increment(1);
          continue;
        }

        if (response.fetchAttempted) {
          stats.fetchCount += 1;
        }

        const result = response.result;
        if (result && result.cache_hit === false && !result.offline) {
          stats.apiCalls += 1;
        }

        if (result && result.token) {
          if (result.cache_hit) {
            cacheHitTokens.add(result.token);
          } else if (result.offline) {
            offlineTokens.add(result.token);
          } else if (result.error) {
            errorTokens.add(result.token);
          } else {
            llmGeneratedTokens.add(result.token);
          }

          const limited = limitAdjacencyEntryEdges(result, edgesPerLevel, normalized);
          const enforced = await enforceEntryBranching(limited, spawnLimit, context);
          const entryRecord = enforced.entry;
          results.set(entryRecord.token, entryRecord);

          const counts = countEntryRelationships(entryRecord);
          totalEdgeCount += counts.edgeCount;
          totalRelationTypes += counts.relationTypes;

          if (enforced.syntheticNeighbors.length) {
            stats.syntheticExpansions += enforced.syntheticNeighbors.length;
            for (const synthetic of enforced.syntheticNeighbors) {
              if (!synthetic || !synthetic.token) continue;
              syntheticNeighborsGenerated.add(synthetic.token);
              llmGeneratedTokens.add(synthetic.token);
            }
          }

          if (onTokenLoaded) {
            try {
              onTokenLoaded(entryRecord);
            } catch (err) {
              console.warn('Adjacency listener failed:', err);
            }
          }

          const nextDepth = item.depthRemaining - 1;
          if (nextDepth > 0 && item.entry.kind !== 'sym') {
            const candidates = enforced.neighbors.length
              ? enforced.neighbors
              : selectHighAttentionNeighbors(entryRecord, spawnLimit);
            let enqueuedCount = 0;
            for (const candidate of candidates) {
              const nextKey = candidate.token.toLowerCase();
              if (visited.has(nextKey) || enqueued.has(nextKey)) continue;
              if (nodeCap > 0 && (results.size + queue.length + enqueuedCount) >= nodeCap) {
                break;
              }
              queue.push({ entry: { token: candidate.token, kind: 'word' }, depthRemaining: nextDepth });
              enqueued.add(nextKey);
              enqueuedCount += 1;
            }
            if (enqueuedCount > 0) {
              progress.addTotal(enqueuedCount);
              stats.expansions += enqueuedCount;
            }
          }

          if (edgeCap > 0 && totalEdgeCount >= edgeCap) {
            queue.length = 0;
          }
          if (relationshipCap !== Infinity && relationshipCap > 0 && totalEdgeCount >= relationshipCap) {
            queue.length = 0;
          }
        } else if (response.error && item.token) {
          errorTokens.add(item.token);
        }

        progress.increment(1);

        const resultsSize = results.size;
        if (checkConnectivity && resultsSize && resultsSize !== lastConnectivitySize) {
          lastConnectivitySnapshot = analyzeAdjacencyConnectivity(results, normalized);
          lastConnectivitySize = resultsSize;
        }

        if (stopWhenConnected && requireCompleteGraph && resultsSize) {
          if (isCompleteAdjacencyGraph(results)) {
            connectivitySatisfied = true;
            break;
          }
        } else if (stopWhenConnected && !requireCompleteGraph && lastConnectivitySnapshot?.allSeedsConnected) {
          connectivitySatisfied = true;
          break;
        }
      }

      if (connectivitySatisfied && stopWhenConnected) break;
    }

    const finalConnectivity = lastConnectivitySnapshot || analyzeAdjacencyConnectivity(results, normalized);
    const finalCompleteGraph = isCompleteAdjacencyGraph(results);

    if (connectivitySatisfied && (finalCompleteGraph || finalConnectivity?.allSeedsConnected)) {
      progress.complete(`${label || 'adjacency recursion'}: connected ${normalized.length} seed${normalized.length === 1 ? '' : 's'} across ${visited.size} token${visited.size === 1 ? '' : 's'}`);
    } else {
      progress.complete(`${label || 'adjacency recursion'}: explored ${visited.size} token${visited.size === 1 ? '' : 's'} to depth ${depth}`);
    }

    return {
      matrices: results,
      stats: {
        seedCount: stats.seedCount,
        depth: stats.depth,
        edgesPerLevel: stats.edgesPerLevel,
        expansions: stats.expansions,
        apiCalls: stats.apiCalls,
        fetchCount: stats.fetchCount,
        visitedTokens: visited.size,
        edgeCount: totalEdgeCount,
        relationTypes: totalRelationTypes,
        syntheticExpansions: stats.syntheticExpansions,
        connectivity: finalConnectivity,
        completeGraph: finalCompleteGraph,
      },
      connectivity: finalConnectivity,
      completeGraph: finalCompleteGraph,
      provenance: {
        cacheHits: Array.from(cacheHitTokens),
        llmGenerated: Array.from(llmGeneratedTokens),
        offline: Array.from(offlineTokens),
        errors: Array.from(errorTokens),
        synthetic: Array.from(syntheticNeighborsGenerated),
      },
    };
  } finally {
    CacheBatch.end();
  }
}

async function ensureSymbolicAdjacencyConnectivity(matrices, seedEntries, chunkLabel, context) {
  const normalizedSeeds = normalizeAdjacencyInputs(seedEntries);
  if (!normalizedSeeds.length) {
    return { updated: false, connectivity: null, stats: null, provenance: null };
  }

  const initialConnectivity = analyzeAdjacencyConnectivity(matrices, normalizedSeeds);
  if (initialConnectivity?.allSeedsConnected) {
    return { updated: false, connectivity: initialConnectivity, stats: null, provenance: null };
  }

  const expansion = await fetchRecursiveAdjacencies(
    normalizedSeeds,
    context,
    `${chunkLabel} symbolic connectivity`,
    {
      normalizedSeeds,
      depth: CONFIG.ADJACENCY_RECURSION_DEPTH,
      edgesPerLevel: CONFIG.ADJACENCY_EDGES_PER_LEVEL,
      stopWhenConnected: true,
      requireCompleteGraph: true,
      preferDb: true,
    },
  );

  if (expansion?.matrices instanceof Map && expansion.matrices.size) {
    mergeAdjacencyMaps(matrices, expansion.matrices);
    calculateAttention(matrices);
    const resolvedConnectivity = expansion.connectivity
      || analyzeAdjacencyConnectivity(matrices, normalizedSeeds);
    return {
      updated: true,
      connectivity: resolvedConnectivity,
      stats: expansion.stats || null,
      provenance: expansion.provenance || null,
    };
  }

  return {
    updated: false,
    connectivity: initialConnectivity,
    stats: expansion?.stats || null,
    provenance: expansion?.provenance || null,
  };
}

function collectHiddenAdjacencyTokens(options = {}) {
  const minAdjacencies = Number.isFinite(options.minAdjacencies) && options.minAdjacencies >= 0
    ? Math.floor(options.minAdjacencies)
    : 2;

  const stats = new Map();
  const neighborSources = new Map();

  const ingestEntry = (token, relationships, origin) => {
    const safeToken = (token == null ? '' : String(token)).trim();
    if (!safeToken) return;

    const rels = relationships && typeof relationships === 'object' ? relationships : {};
    let adjacencyCount = 0;
    let relationshipTypes = 0;

    for (const edges of Object.values(rels)) {
      if (!Array.isArray(edges) || edges.length === 0) continue;
      relationshipTypes += 1;
      for (const edge of edges) {
        if (!edge || !edge.token) continue;
        const neighborToken = String(edge.token).trim();
        if (!neighborToken) continue;
        adjacencyCount += 1;
        const neighborKey = neighborToken.toLowerCase();
        if (!neighborSources.has(neighborKey)) {
          neighborSources.set(neighborKey, { token: neighborToken, sources: new Set(), edgeCount: 0 });
        }
        const info = neighborSources.get(neighborKey);
        if (!info.token) info.token = neighborToken;
        info.sources.add(safeToken);
        info.edgeCount += 1;
      }
    }

    const key = safeToken.toLowerCase();
    if (!stats.has(key)) {
      stats.set(key, {
        token: safeToken,
        adjacencyCount,
        relationshipTypes,
        origins: new Set(origin ? [origin] : []),
      });
    } else {
      const existing = stats.get(key);
      if (adjacencyCount > existing.adjacencyCount) existing.adjacencyCount = adjacencyCount;
      if (relationshipTypes > existing.relationshipTypes) existing.relationshipTypes = relationshipTypes;
      if (origin) existing.origins.add(origin);
    }
  };

  const cacheKeys = safeStorageKeys(TOKEN_CACHE_PREFIX);
  for (const key of cacheKeys) {
    const stored = safeStorageGet(key, null);
    if (!stored) continue;
    try {
      const entry = typeof stored === 'string' ? JSON.parse(stored) : stored;
      if (!entry || typeof entry !== 'object') continue;
      ingestEntry(entry.token, entry.relationships, 'cache');
    } catch (err) {
      console.warn('Failed to inspect cached adjacency entry', key, err);
    }
  }

  const db = getDb();
  if (db?.full_token_data) {
    for (const record of db.full_token_data) {
      if (!record || typeof record !== 'object') continue;
      ingestEntry(record.token, record.relationships, 'db');
    }
  }

  const sparse = [];
  for (const info of stats.values()) {
    const count = Number.isFinite(info.adjacencyCount) ? info.adjacencyCount : 0;
    if (count < minAdjacencies) {
      sparse.push({
        token: info.token,
        adjacencyCount: count,
        relationshipTypes: Number.isFinite(info.relationshipTypes) ? info.relationshipTypes : 0,
        origins: info.origins instanceof Set ? Array.from(info.origins) : [],
      });
    }
  }

  const unmapped = [];
  for (const [neighborKey, info] of neighborSources.entries()) {
    if (stats.has(neighborKey)) continue;
    unmapped.push({
      token: info.token,
      sources: Array.from(info.sources || []),
      edgeCount: Number.isFinite(info.edgeCount) ? info.edgeCount : 0,
    });
  }

  return {
    minAdjacencies,
    stats,
    sparse,
    unmapped,
    neighborSources,
  };
}

function isCompleteAdjacencyGraph(matrices) {
  if (!(matrices instanceof Map)) {
    return false;
  }

  const adjacencyMap = new Map();
  const nodes = [];

  for (const [tokenKey, entry] of matrices.entries()) {
    const rawToken = entry?.token || tokenKey;
    const token = (rawToken == null ? '' : String(rawToken)).trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (!adjacencyMap.has(key)) {
      adjacencyMap.set(key, new Set());
      nodes.push(key);
    }
  }

  if (nodes.length <= 1) {
    return nodes.length === 1;
  }

  for (const [tokenKey, entry] of matrices.entries()) {
    const rawToken = entry?.token || tokenKey;
    const token = (rawToken == null ? '' : String(rawToken)).trim();
    if (!token) continue;
    const key = token.toLowerCase();
    const neighbors = adjacencyMap.get(key);
    if (!neighbors) continue;

    const relationships = entry?.relationships && typeof entry.relationships === 'object'
      ? entry.relationships
      : {};

    for (const edges of Object.values(relationships)) {
      if (!Array.isArray(edges)) continue;
      for (const edge of edges) {
        if (!edge || !edge.token) continue;
        const neighborToken = String(edge.token).trim();
        if (!neighborToken) continue;
        const neighborKey = neighborToken.toLowerCase();
        if (neighborKey === key) continue;
        if (adjacencyMap.has(neighborKey)) {
          neighbors.add(neighborKey);
        }
      }
    }
  }

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const aNeighbors = adjacencyMap.get(a) || new Set();
      const bNeighbors = adjacencyMap.get(b) || new Set();
      if (!(aNeighbors.has(b) && bNeighbors.has(a))) {
        return false;
      }
    }
  }

  return true;
}

function analyzeAdjacencyConnectivity(matrices, seeds) {
  if (!(matrices instanceof Map) || matrices.size === 0) {
    return null;
  }

  const graph = new Map();
  const tokenForKey = new Map();

  const ensureNode = (rawToken) => {
    const token = (rawToken == null ? '' : String(rawToken)).trim();
    if (!token) return null;
    const key = token.toLowerCase();
    if (!graph.has(key)) {
      graph.set(key, new Set());
    }
    if (!tokenForKey.has(key)) {
      tokenForKey.set(key, token);
    }
    return key;
  };

  for (const [mapToken, entry] of matrices.entries()) {
    const fallbackToken = entry?.token || mapToken;
    const nodeKey = ensureNode(fallbackToken);
    if (!nodeKey) continue;
    const rels = entry?.relationships && typeof entry.relationships === 'object' ? entry.relationships : {};
    for (const edges of Object.values(rels)) {
      if (!Array.isArray(edges)) continue;
      for (const edge of edges) {
        const neighborKey = ensureNode(edge?.token);
        if (!neighborKey) continue;
        graph.get(nodeKey).add(neighborKey);
        graph.get(neighborKey).add(nodeKey);
      }
    }
  }

  const seedEntries = Array.isArray(seeds) ? seeds : [];
  const seedKeys = new Set();
  for (const entry of seedEntries) {
    const token = typeof entry === 'string' ? entry : entry?.token;
    const key = ensureNode(token);
    if (key) seedKeys.add(key);
  }

  const components = [];
  const visited = new Set();
  for (const key of graph.keys()) {
    if (visited.has(key)) continue;
    const stack = [key];
    const componentNodes = new Set();
    const componentSeeds = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      componentNodes.add(current);
      if (seedKeys.has(current)) componentSeeds.add(current);
      const neighbors = graph.get(current) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
    components.push({ nodes: componentNodes, seeds: componentSeeds });
  }

  const componentSummaries = components.map(component => ({
    size: component.nodes.size,
    seedCount: component.seeds.size,
    tokens: Array.from(component.nodes).slice(0, 12).map(key => tokenForKey.get(key) || key),
    seedTokens: Array.from(component.seeds).map(key => tokenForKey.get(key) || key),
  })).sort((a, b) => {
    if (b.seedCount !== a.seedCount) return b.seedCount - a.seedCount;
    return b.size - a.size;
  });

  let primarySeedComponent = null;
  for (const component of components) {
    if (!primarySeedComponent) {
      primarySeedComponent = component;
      continue;
    }
    if (component.seeds.size > primarySeedComponent.seeds.size) {
      primarySeedComponent = component;
      continue;
    }
    if (component.seeds.size === primarySeedComponent.seeds.size && component.nodes.size > primarySeedComponent.nodes.size) {
      primarySeedComponent = component;
    }
  }

  const connectedSeedKeys = new Set(primarySeedComponent ? primarySeedComponent.seeds : []);
  const disconnectedSeedKeys = [];
  for (const key of seedKeys) {
    if (!connectedSeedKeys.has(key)) disconnectedSeedKeys.push(key);
  }

  const isolatedSeedKeys = disconnectedSeedKeys.filter(key => {
    const neighbors = graph.get(key);
    return !neighbors || neighbors.size === 0;
  });

  const allSeedsConnected = seedKeys.size === 0
    ? true
    : connectedSeedKeys.size === seedKeys.size && disconnectedSeedKeys.length === 0;

  const bidirectionalComplete = isCompleteAdjacencyGraph(matrices);

  return {
    componentCount: componentSummaries.length,
    components: componentSummaries,
    seedCount: seedKeys.size,
    connectedSeedCount: connectedSeedKeys.size,
    allSeedsConnected,
    disconnectedSeeds: disconnectedSeedKeys.map(key => tokenForKey.get(key) || key),
    isolatedSeeds: isolatedSeedKeys.map(key => tokenForKey.get(key) || key),
    bidirectionalComplete,
  };
}

function summarizeAdjacencyResults(map) {
  let hits = 0;
  let misses = 0;
  let total = 0;
  if (map instanceof Map) {
    for (const entry of map.values()) {
      if (!entry) continue;
      total++;
      if (entry.cache_hit === true) hits++;
      else misses++;
    }
  }
  return { hits, misses, total };
}

function hasNewAdjacencyData(matrices) {
  if (!(matrices instanceof Map)) return false;
  for (const entry of matrices.values()) {
    if (entry && entry.cache_hit === false && !entry.error && !entry.offline) {
      return true;
    }
  }
  return false;
}

window.CognitionEngine.processing = {
  fetchAdjacency,
  batchFetchAdjacencies,
  fetchRecursiveAdjacencies,
};

window.CognitionEngine.voiceModel = Object.assign(window.CognitionEngine.voiceModel || {}, {
  submitPrompt: (input, opts) => submitVoiceModelPrompt(input, opts),
  focusDock: () => {
    try {
      voiceDockController?.focus?.();
    } catch (err) {
      console.warn('Voice model dock focus failed:', err);
    }
  },
});

function recordLatestLocalVoiceOutputs(payload) {
  if (typeof window === 'undefined') return;
  const root = (window.CognitionEngine = window.CognitionEngine || {});
  const voice = (root.voice = root.voice || {});

  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  const localThought = typeof payload?.localThought === 'string' ? payload.localThought : '';
  const localResponse = typeof payload?.localResponse === 'string' ? payload.localResponse : '';
  if (!localThought && !localResponse) {
    return;
  }

  const data = {
    prompt,
    localThought,
    localResponse,
    source: typeof payload?.source === 'string' ? payload.source : 'prompt',
    updatedAt: Date.now(),
  };

  voice.latestLocalOutputs = data;
  voice.lastLocalOutputAt = data.updatedAt;
  voice.getLatestLocalOutputs = () => voice.latestLocalOutputs || null;

  if (typeof voice.onLocalOutputsUpdated === 'function') {
    try {
      voice.onLocalOutputsUpdated(data);
    } catch (error) {
      console.warn('Voice local output listener failed:', error);
    }
  }
}

function calculateAttention(matrices) {
  for (const entry of matrices.values()) {
    let weightSum = 0, totalEdges = 0;
    const rels = entry?.relationships || {};

    for (const [rel, edges] of Object.entries(rels)) {
      const priority = RELATIONSHIP_PRIORITIES.get(rel) || 0.3;
      if (Array.isArray(edges)) {
        edges.forEach(edge => {
          weightSum += (edge.weight || 0) * priority;
          totalEdges++;
        });
      }
    }

    entry.attention_score = totalEdges > 0 ? Number((weightSum / totalEdges).toFixed(3)) : 0;
    entry.total_relationships = totalEdges;
  }
  return matrices;
}

function summarizeAttention(matrices) {
  const summary = [];
  for (const [token, data] of matrices.entries()) {
    summary.push({ 
      token, 
      attention: data.attention_score || 0, 
      total: data.total_relationships || 0 
    });
  }
  return summary.sort((a, b) => b.attention - a.attention).slice(0, 10);
}

function formatTopTokens(topTokens) {
  const { ledger } = generateGlyphLedger();
  return topTokens.map(t => {
    const glyphEntry = ledger.get(t.token);
    const glyph = glyphEntry ? glyphEntry.glyph : '◌';
    return `<span class="token-highlight">${glyph} ${t.token}</span> (${t.attention.toFixed(2)})`;
  }).join(', ');
}

function extractKeyRelationships(matrices) {
  const relationships = [];
  let count = 0;
  for (const [token, data] of matrices.entries()) {
    if (count >= 5) break;
    const rels = data?.relationships || {};
    for (const [rel, edges] of Object.entries(rels)) {
      if (!Array.isArray(edges) || edges.length === 0) continue;
      const topEdge = edges.sort((a, b) => b.weight - a.weight)[0];
      const weight = Number(topEdge?.weight);
      const weightText = Number.isFinite(weight) ? weight.toFixed(2) : '0.00';
      const relEnglish = edgeLabel(rel);
      const details = relEnglish ? `${relEnglish}, ${weightText}` : weightText;
      relationships.push(`${token} ${rel} ${topEdge.token} (${details})`);
      count++;
      if (count >= 5) break;
    }
  }
  return relationships;
}

function gatherAdjacencyWalk(matrices, options = {}) {
  const steps = [];
  if (!(matrices instanceof Map) || matrices.size === 0) return steps;

  const opts = options || {};
  const maxSteps = Number.isFinite(opts.maxSteps) && opts.maxSteps > 0
    ? Math.floor(opts.maxSteps)
    : 12;

  const topTokens = summarizeAttention(matrices);
  const queue = topTokens.map(item => item.token).filter(Boolean);
  const visitedTokens = new Set();
  const seenPairs = new Set();

  while (queue.length && steps.length < maxSteps) {
    const current = queue.shift();
    if (!current) continue;
    const currentKey = current.toLowerCase();
    if (visitedTokens.has(currentKey)) continue;
    visitedTokens.add(currentKey);

    const entry = matrices.get(current)
      || matrices.get(currentKey)
      || null;
    if (!entry) continue;

    const rels = entry.relationships || {};
    const candidates = [];
    for (const [rel, edges] of Object.entries(rels)) {
      if (!Array.isArray(edges)) continue;
      for (const edge of edges) {
        if (!edge || !edge.token) continue;
        candidates.push({
          from: entry.token || current,
          to: edge.token,
          relation: rel,
          weight: Number(edge.weight) || 0,
        });
      }
    }

    candidates.sort((a, b) => b.weight - a.weight);
    for (const candidate of candidates) {
      const pairKey = `${candidate.from}→${candidate.relation}→${candidate.to}`.toLowerCase();
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      steps.push(candidate);
      queue.push(candidate.to);
      if (steps.length >= maxSteps) break;
    }
  }

  return steps;
}

function buildRecursiveAdjacencyWalk(matrices, options = {}) {
  const result = { sequences: [], steps: [], tokens: [] };
  if (!(matrices instanceof Map) || matrices.size === 0) return result;

  const opts = options || {};
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : null;
  const iterations = Number.isFinite(opts.iterations) && opts.iterations > 0
    ? Math.floor(opts.iterations)
    : 4;
  const maxSteps = Number.isFinite(opts.maxSteps) && opts.maxSteps > 0
    ? Math.floor(opts.maxSteps)
    : iterations * 4;

  const startTokens = Array.isArray(opts.startTokens) && opts.startTokens.length
    ? opts.startTokens
    : summarizeAttention(matrices).map(item => item.token).filter(Boolean);

  const seenStarts = new Set();
  const tokenMap = new Map();

  const getEntry = (token) => {
    if (!token) return null;
    return matrices.get(token) || matrices.get(token.toLowerCase()) || null;
  };

  const recordToken = (token) => {
    if (!token) return;
    const key = token.toLowerCase();
    if (!tokenMap.has(key)) tokenMap.set(key, token);
  };

  const gatherCandidates = (entry, fallback) => {
    if (!entry) return [];
    const rels = entry.relationships || {};
    const list = [];
    for (const [rel, edges] of Object.entries(rels)) {
      if (!Array.isArray(edges)) continue;
      for (const edge of edges) {
        if (!edge || !edge.token) continue;
        list.push({
          from: entry.token || fallback,
          to: edge.token,
          relation: rel,
          weight: Number(edge.weight) || 0,
        });
      }
    }
    list.sort((a, b) => b.weight - a.weight);
    return list;
  };

  const maxStartCount = Math.max(1, Math.min(startTokens.length, opts.seedLimit || 3));
  for (const token of startTokens.slice(0, maxStartCount)) {
    if (!token) continue;
    const startKey = token.toLowerCase();
    if (seenStarts.has(startKey)) continue;
    seenStarts.add(startKey);

    const sequenceSteps = [];
    const visitedTokens = new Set([startKey]);
    recordToken(token);

    const traverse = (currentToken, depthRemaining) => {
      if (depthRemaining <= 0 || sequenceSteps.length >= maxSteps || result.steps.length >= maxSteps) return;

      const entry = getEntry(currentToken);
      const candidates = gatherCandidates(entry, currentToken);
      if (!candidates.length) return;

      let advanced = false;
      for (const candidate of candidates) {
        if (threshold !== null && candidate.weight < threshold) continue;
        const targetKey = candidate.to.toLowerCase();
        if (visitedTokens.has(targetKey)) continue;
        visitedTokens.add(targetKey);
        recordToken(candidate.from);
        recordToken(candidate.to);
        sequenceSteps.push(candidate);
        result.steps.push(candidate);
        advanced = true;
        traverse(candidate.to, depthRemaining - 1);
        break;
      }

      if (!advanced && candidates.length) {
        const fallback = candidates[0];
        const targetKey = fallback.to.toLowerCase();
        if (!visitedTokens.has(targetKey)) {
          visitedTokens.add(targetKey);
          recordToken(fallback.from);
          recordToken(fallback.to);
          sequenceSteps.push(fallback);
          result.steps.push(fallback);
          traverse(fallback.to, depthRemaining - 1);
        }
      }
    };

    traverse(token, iterations);
    if (sequenceSteps.length || getEntry(token)) {
      result.sequences.push({ start: token, steps: sequenceSteps.slice() });
    }

    if (result.steps.length >= maxSteps) break;
  }

  result.tokens = Array.from(tokenMap.values());
  return result;
}

function generateLocalHlsfOutput(matrices, options = {}) {
  const opts = options || {};
  const inputWordCount = Number.isFinite(opts.inputWordCount) && opts.inputWordCount > 0
    ? Math.floor(opts.inputWordCount)
    : null;
  const desiredResponseWordCount = inputWordCount != null
    ? Math.max(0, inputWordCount * 2)
    : null;
  const baseWordLimit = Number.isFinite(opts.wordLimit) && opts.wordLimit > 0
    ? Math.floor(opts.wordLimit)
    : CONFIG.LOCAL_OUTPUT_WORD_LIMIT;
  const wordLimit = desiredResponseWordCount != null
    ? Math.max(baseWordLimit, desiredResponseWordCount)
    : baseWordLimit;

  const affinityThreshold = Number.isFinite(opts.threshold) ? opts.threshold : undefined;
  const affinityIterations = Number.isFinite(opts.iterations) && opts.iterations > 0
    ? Math.floor(opts.iterations)
    : undefined;
  const topTokens = Array.isArray(opts.topTokens) && opts.topTokens.length
    ? opts.topTokens
    : summarizeAttention(matrices);
  const keyRelationships = Array.isArray(opts.keyRelationships) && opts.keyRelationships.length
    ? opts.keyRelationships
    : extractKeyRelationships(matrices);

  const focusTokens = topTokens.map(t => t.token).filter(Boolean).slice(0, 6);
  const walkResult = buildRecursiveAdjacencyWalk(matrices, {
    threshold: affinityThreshold,
    iterations: affinityIterations,
    maxSteps: opts.maxSteps || Math.max(8, Math.min(24, Math.floor(wordLimit / 3) || 12)),
    startTokens: focusTokens,
    seedLimit: opts.seedLimit,
  });

  const sentences = [];

  const formatSequence = (sequence) => {
    if (!sequence || !Array.isArray(sequence.steps) || sequence.steps.length === 0) {
      return sequence?.start ? `No qualifying neighbors followed from ${sequence.start}.` : '';
    }

    const clauses = sequence.steps.map((step, index) => {
      const relationLabel = relDisplay(step.relation || '∼');
      const weight = Number.isFinite(step.weight) ? ` (${step.weight.toFixed(2)})` : '';
      const clause = `${step.from} ${relationLabel} ${step.to}${weight}`;
      if (index === 0) {
        return clause.charAt(0).toUpperCase() + clause.slice(1);
      }
      return clause;
    });

    if (clauses.length === 1) {
      return `${clauses[0]}.`;
    }
    return `${clauses[0]}, then ${clauses.slice(1).join(', then ')}.`;
  };

  if (walkResult.sequences.length) {
    for (const sequence of walkResult.sequences) {
      const formatted = formatSequence(sequence);
      if (formatted) sentences.push(formatted);
    }
  }

  const visitedTokens = walkResult.tokens.length ? walkResult.tokens : focusTokens;
  const orderedThoughtTokens = (() => {
    const seen = new Set();
    const ordered = [];
    const pushToken = (token) => {
      if (!token) return;
      const key = token.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      ordered.push(token);
    };
    (visitedTokens || []).forEach(pushToken);
    focusTokens.forEach(pushToken);
    return ordered;
  })();

  if (orderedThoughtTokens.length) {
    sentences.push(`Traversal touched: ${orderedThoughtTokens.slice(0, 8).join(', ')}.`);
  }

  if (!sentences.length) {
    sentences.push('Adjacency walk did not yield any qualifying tokens.');
  }

  const thoughtTextRaw = orderedThoughtTokens.join(', ').trim();
  const narrativeText = sentences.join(' ').replace(/\s+/g, ' ').trim();
  const baseThought = thoughtTextRaw || narrativeText;
  const thoughtLimited = limitWords(baseThought, wordLimit);

  const longestSequence = walkResult.sequences.reduce((max, sequence) => {
    if (!sequence || !Array.isArray(sequence.steps)) return max;
    const depth = sequence.steps.length + 1;
    return depth > max ? depth : max;
  }, 0);
  let responseTokenLimit = Number.isFinite(opts.responseTokenLimit) && opts.responseTokenLimit > 0
    ? Math.floor(opts.responseTokenLimit)
    : 4;
  if (desiredResponseWordCount != null) {
    responseTokenLimit = Math.max(responseTokenLimit, desiredResponseWordCount);
  }
  const responseTokenCount = Math.max(
    1,
    Math.min(
      orderedThoughtTokens.length || 1,
      Math.min(responseTokenLimit, longestSequence || 1),
    ),
  );
  const chosenTokens = orderedThoughtTokens.slice(0, responseTokenCount);
  const responseTextRaw = chosenTokens.join(' ').trim();
  let responseWordLimit = Math.max(
    responseTokenCount,
    Math.min(wordLimit, Number.isFinite(opts.responseWordLimit) && opts.responseWordLimit > 0
      ? Math.floor(opts.responseWordLimit)
      : 12),
  );
  if (desiredResponseWordCount != null) {
    responseWordLimit = Math.max(responseWordLimit, desiredResponseWordCount);
  }
  const responseLimited = limitWords(responseTextRaw || baseThought, responseWordLimit);
  let responseText = responseLimited.text;
  let responseWordCount = responseLimited.wordCount;
  let responseTokens = chosenTokens.slice();

  if (desiredResponseWordCount != null && desiredResponseWordCount > 0) {
    const initialTokens = (responseText.match(/\S+/g) || []).filter(Boolean);
    let workingTokens = initialTokens.length ? initialTokens.slice() : responseTokens.slice();
    if (!workingTokens.length) {
      workingTokens = orderedThoughtTokens.slice();
    }
    const fillerPool = orderedThoughtTokens.length
      ? orderedThoughtTokens
      : (focusTokens.length ? focusTokens : []);
    if (!workingTokens.length && fillerPool.length) {
      workingTokens = fillerPool.slice();
    }
    if (!workingTokens.length && baseThought) {
      workingTokens = (baseThought.match(/\S+/g) || []).slice();
    }
    if (!workingTokens.length && responseText) {
      workingTokens = [responseText];
    }

    let fillerIndex = 0;
    const safeFillerPool = fillerPool.length
      ? fillerPool
      : (workingTokens.length ? workingTokens : ['…']);
    while (workingTokens.length < desiredResponseWordCount) {
      const filler = safeFillerPool[fillerIndex % safeFillerPool.length] || '…';
      workingTokens.push(filler);
      fillerIndex += 1;
      if (fillerIndex > desiredResponseWordCount * 4) break;
    }

    if (workingTokens.length > desiredResponseWordCount) {
      workingTokens = workingTokens.slice(0, desiredResponseWordCount);
    }

    if (workingTokens.length) {
      responseText = workingTokens.join(' ');
      responseWordCount = workingTokens.length;
      responseTokens = workingTokens.slice();
    }
  }

  return {
    text: thoughtLimited.text,
    wordCount: thoughtLimited.wordCount,
    totalWords: thoughtLimited.totalWords,
    trimmed: thoughtLimited.trimmed,
    thoughtText: thoughtLimited.text,
    thoughtWordCount: thoughtLimited.wordCount,
    thoughtTrimmed: thoughtLimited.trimmed,
    thoughtTokens: orderedThoughtTokens,
    responseText,
    responseWordCount,
    responseTrimmed: responseLimited.trimmed,
    responseTokens,
    narrative: narrativeText,
    walk: walkResult.steps,
    focusTokens,
    keyRelationships,
    visitedTokens: orderedThoughtTokens,
  };
}

function cloneAdjacencyEntry(entry, fallbackToken) {
  if (!entry) return null;
  const relationships = {};
  for (const [rel, edges] of Object.entries(entry.relationships || {})) {
    if (!Array.isArray(edges)) continue;
    relationships[rel] = edges.map(edge => ({
      token: edge?.token || '',
      weight: Number(edge?.weight) || 0,
    }));
  }
  return {
    token: entry.token || fallbackToken || '',
    relationships,
    attention_score: Number(entry.attention_score) || 0,
    total_relationships: Number(entry.total_relationships) || 0,
  };
}

function mergeAdjacencyMaps(target, source) {
  const map = target instanceof Map ? target : new Map();
  if (!(source instanceof Map)) return map;
  for (const [token, entry] of source.entries()) {
    if (!token || !entry) continue;
    const key = (token || '').toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      const clone = cloneAdjacencyEntry(entry, key);
      if (clone) map.set(key, clone);
      continue;
    }
    const relationships = existing.relationships || (existing.relationships = {});
    const incoming = entry.relationships || {};
    for (const [rel, edges] of Object.entries(incoming)) {
      if (!Array.isArray(edges)) continue;
      if (!Array.isArray(relationships[rel])) relationships[rel] = [];
      const list = relationships[rel];
      for (const edge of edges) {
        if (!edge || !edge.token) continue;
        const weight = Number(edge.weight) || 0;
        const existingEdge = list.find(item => item.token === edge.token);
        if (existingEdge) {
          existingEdge.weight = Math.max(Number(existingEdge.weight) || 0, weight);
        } else {
          list.push({ token: edge.token, weight });
        }
      }
    }
    const attn = Number(entry.attention_score);
    if (Number.isFinite(attn)) {
      existing.attention_score = Math.max(Number(existing.attention_score) || 0, attn);
    }
    const total = Number(entry.total_relationships);
    if (Number.isFinite(total)) {
      existing.total_relationships = Math.max(Number(existing.total_relationships) || 0, total);
    }
    if (!existing.token) existing.token = key;
    map.set(key, existing);
  }
  return map;
}

function formatListForPrompt(list) {
  const tokens = normalizeTokenList(list);
  if (!tokens.length) return '';
  if (tokens.length === 1) return tokens[0];
  if (tokens.length === 2) return `${tokens[0]} and ${tokens[1]}`;
  return `${tokens.slice(0, -1).join(', ')} and ${tokens[tokens.length - 1]}`;
}

function buildAfterStatePrompt(matrices) {
  const graph = state.liveGraph || {};
  const nodes = graph.nodes instanceof Map ? graph.nodes : new Map();
  const nodeCount = nodes.size;
  const edgeCount = Array.isArray(graph.links) ? graph.links.length : 0;
  const cachedTokens = [];
  const newTokens = [];
  for (const token of state.tokenOrder) {
    const node = nodes.get(token);
    if (!node) continue;
    if (node.status === 'cached') cachedTokens.push(token);
    else newTokens.push(token);
  }

  const topTokens = summarizeAttention(matrices);
  const keyRels = extractKeyRelationships(matrices);
  const focus = [];
  if (cachedTokens.length) {
    focus.push(`leverage cached knowledge around ${formatListForPrompt(cachedTokens)}`);
  }
  if (newTokens.length) {
    focus.push(`establish context for new or uncached terms ${formatListForPrompt(newTokens)}`);
  }
  if (topTokens.length) {
    const attentionSummary = topTokens
      .slice(0, 5)
      .map(t => `${t.token} (${t.attention.toFixed(2)})`)
      .join(', ');
    focus.push(`prioritize attention hotspots ${attentionSummary}`);
  }
  if (keyRels.length) {
    focus.push(`highlight relationships such as ${keyRels.join('; ')}`);
  }
  focus.push(`maintain coherence across ${nodeCount} active nodes and ${edgeCount} live adjacencies`);

  const lines = [
    'Craft the next response by reasoning over the stabilized HLSF state.',
    'Goals:',
    ...focus.map(item => `- ${item}.`),
    'Keep explanations grounded in observed tokens and their relationships.'
  ];

  return {
    text: lines.join('\n'),
    cachedTokens,
    newTokens,
    topTokens,
    keyRels,
    nodeCount,
    edgeCount,
  };
}

// ============================================
// HLSF VISUALIZATION
// ============================================

function polygonVertices(center, radius, sides) {
  const vertices = [];
  const angleStep = (2 * Math.PI) / sides;
  for (let i = 0; i < sides; i++) {
    const angle = i * angleStep - Math.PI / 2;
    vertices.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle)
    ]);
  }
  return vertices;
}

function deriveAdjacencyPolygon(center, baseRadius, relationships) {
  const entries = Object.entries(relationships || {})
    .filter(([, edges]) => Array.isArray(edges) && edges.length > 0)
    .map(([relType, edges]) => {
      const weightSum = edges.reduce((sum, edge) => {
        const weight = typeof edge.weight === 'number' ? edge.weight : 0;
        return sum + weight;
      }, 0);
      const avgWeight = edges.length > 0 ? weightSum / edges.length : 0;
      return {
        relType,
        count: edges.length,
        avgWeight
      };
    })
    .sort((a, b) => a.relType.localeCompare(b.relType));

  if (entries.length === 0) {
    const fallbackVertices = polygonVertices(center, baseRadius * 0.8, 3);
    const fallbackLabels = fallbackVertices.map((_, idx) => (idx === 0 ? 'anchor' : ''));
    const fallbackWeights = fallbackVertices.map(() => 1);
    const fallbackRelations = fallbackVertices.map(() => null);
    return {
      vertices: fallbackVertices,
      anchorIndex: 0,
      adjacencyTypes: 0,
      vertexLabels: fallbackLabels,
      vertexWeights: fallbackWeights,
      vertexRelations: fallbackRelations,
      relationEntries: [],
    };
  }

  const vertexCount = Math.max(entries.length + 1, 3);
  const baseAngle = -Math.PI / 2;
  const angleStep = (2 * Math.PI) / vertexCount;
  const maxCount = Math.max(...entries.map(entry => entry.count));

  const vertices: Array<[number, number]> = [];
  const vertexLabels: string[] = ['anchor'];
  const vertexWeights: number[] = [1];
  const vertexRelations: Array<{ key: string | null; label: string; count: number; weight: number } | null> = [null];
  const relationEntries: Array<{ key: string | null; label: string; count: number; avgWeight: number }> = [];

  const anchor = [center[0], center[1] - baseRadius];
  vertices.push(anchor);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const normalizedWeight = Math.min(1, Math.max(0, entry.avgWeight));
    const countFactor = maxCount > 0 ? entry.count / maxCount : 0;
    const radialFactor = 0.85 + normalizedWeight * 0.35 + countFactor * 0.25;
    const radius = baseRadius * radialFactor;
    const angle = baseAngle + angleStep * (i + 1);
    vertices.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle)
    ]);

    const relKey = normRelKey(entry.relType) || entry.relType;
    const label = typeof relKey === 'string' && relKey
      ? relDisplay(relKey)
      : entry.relType;
    vertexLabels.push(label || entry.relType);
    vertexWeights.push(Math.max(0, Math.min(1, entry.avgWeight)));
    vertexRelations.push({
      key: typeof relKey === 'string' && relKey ? relKey : null,
      label: label || entry.relType,
      count: entry.count,
      weight: entry.avgWeight,
    });
    relationEntries.push({
      key: typeof relKey === 'string' && relKey ? relKey : null,
      label: label || entry.relType,
      count: entry.count,
      avgWeight: entry.avgWeight,
    });
  }

  let fillerIndex = entries.length;
  while (vertices.length < 3) {
    const angle = baseAngle + angleStep * (fillerIndex + 1);
    vertices.push([
      center[0] + baseRadius * 0.75 * Math.cos(angle),
      center[1] + baseRadius * 0.75 * Math.sin(angle)
    ]);
    fillerIndex++;
  }

  return {
    vertices,
    anchorIndex: 0,
    adjacencyTypes: entries.length,
    vertexLabels,
    vertexWeights,
    vertexRelations,
    relationEntries,
  };
}

function buildBaseTriangles(vertices, sides) {
  if (sides < 3) return [];
  const triangles = [];
  const center = vertices.reduce((acc, v) =>
    [acc[0] + v[0] / sides, acc[1] + v[1] / sides], [0, 0]);

  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    triangles.push([center, vertices[i], vertices[next]]);
  }
  return triangles;
}

function rotateTrianglesAround(triangles, center, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return triangles.map(tri => tri.map(vertex => {
    const dx = vertex[0] - center[0];
    const dy = vertex[1] - center[1];
    return [
      center[0] + dx * cos - dy * sin,
      center[1] + dx * sin + dy * cos
    ];
  }));
}

function rotatePointsAround(points, center, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return points.map(vertex => {
    const dx = vertex[0] - center[0];
    const dy = vertex[1] - center[1];
    return [
      center[0] + dx * cos - dy * sin,
      center[1] + dx * sin + dy * cos
    ];
  });
}

function scalePointsAround(points, center, scale) {
  if (!Array.isArray(points)) return [];
  return points.map(vertex => {
    const dx = vertex[0] - center[0];
    const dy = vertex[1] - center[1];
    return [
      center[0] + dx * scale,
      center[1] + dy * scale
    ];
  });
}

function scaleTrianglesAround(triangles, center, scale) {
  if (!Array.isArray(triangles)) return [];
  return triangles.map(tri => scalePointsAround(tri, center, scale));
}

window.HLSF.geometry = {
  polygonVertices,
  buildBaseTriangles,
  rotateTrianglesAround,
  rotatePointsAround,
  scalePointsAround,
  scaleTrianglesAround,
  deriveAdjacencyPolygon,
};

let hlsfNodes = [];

function buildHLSFNodes() {
  const graph = window.HLSF_GRAPH;
  let tokenRecords = [];

  if (graph?.tokens instanceof Map) {
    tokenRecords = Array.from(graph.tokens.values());
  } else if (graph?.tokens && typeof graph.tokens === 'object') {
    tokenRecords = Object.values(graph.tokens);
  }

  let sourceLabel = '';

  if (tokenRecords.length === 0) {
    const keys = safeStorageKeys(TOKEN_CACHE_PREFIX);
    console.log(`Scanning ${keys.length} cached tokens from storage for HLSF build`);

    for (const key of keys) {
      try {
        const tokenData = safeStorageGet(key);
        if (!tokenData?.token) {
          console.warn('Token missing from data:', key);
          continue;
        }
        tokenRecords.push(tokenData);
      } catch (err) {
        console.error('Failed to process token:', key, err);
      }
    }

    if (graph) {
      graph.tokens = new Map(tokenRecords.map(record => [record.token, record]));
    }

    sourceLabel = '(storage scan)';
  } else {
    sourceLabel = '(graph cache)';
  }

  console.log(`Building HLSF nodes from ${tokenRecords.length} cached tokens ${sourceLabel}`.trim());

  const nodes = [];

  for (const tokenData of tokenRecords) {
    try {
      const token = tokenData.token;

      if (!token) {
        console.warn('Token missing from data:', tokenData);
        continue;
      }

      const rels = tokenData.relationships || {};

      // Count adjacencies
      let adjacencyCount = 0;
      for (const edges of Object.values(rels)) {
        if (Array.isArray(edges)) adjacencyCount += edges.length;
      }
      const adjacencyTypes = Object.values(rels)
        .filter(edges => Array.isArray(edges) && edges.length > 0)
        .length;

      const attention = typeof tokenData.attention_score === 'number'
        ? tokenData.attention_score
        : 0.5;
      const complex = memoizedComplexNumber(token, { ...tokenData, attention_score: attention });
      const glyph = complexToGlyph(complex);

      // Position based on complex number
      const x = complex.real * 2;
      const y = complex.imaginary * 2;

      // Radius based on attention
      const radius = 0.3 + attention * 0.4;

      // Build polygon derived from adjacency structure
      const shape = deriveAdjacencyPolygon([x, y], radius, rels);
      const sides = shape.vertices.length;

      // Color based on attention
      let color;
      if (attention >= 0.8) color = [0, 255, 136];
      else if (attention >= 0.5) color = [255, 213, 79];
      else color = [255, 119, 119];

      nodes.push({
        token,
        glyph,
        center: [x, y],
        radius,
        sides,
        attention,
        adjacencyCount,
        adjacencyTypes,
        anchorIndex: shape.anchorIndex,
        color,
        vertices: shape.vertices,
        triangles: null, // Will be computed
        vertexLabels: Array.isArray(shape.vertexLabels) ? shape.vertexLabels : [],
        vertexWeights: Array.isArray(shape.vertexWeights) ? shape.vertexWeights : [],
        vertexRelations: Array.isArray(shape.vertexRelations) ? shape.vertexRelations : [],
        relationEntries: Array.isArray(shape.relationEntries) ? shape.relationEntries : [],
      });
    } catch (err) {
      console.error('Failed to process token for HLSF:', tokenData, err);
    }
  }

  console.log(`Built ${nodes.length} HLSF nodes`);

  // Generate triangles for each node
  for (const node of nodes) {
    try {
      node.triangles = buildBaseTriangles(node.vertices, node.sides);
    } catch (err) {
      console.error(`Failed to build triangles for ${node.token}:`, err);
      node.triangles = [];
    }
  }

  return nodes;
}

function initHLSFCanvas() {
  console.log('Initializing HLSF Canvas...');

  try {
    // Build nodes first to check if we have data
    hlsfNodes = buildHLSFNodes();
    window.HLSF = window.HLSF || {};
    window.HLSF.nodes = Array.isArray(hlsfNodes) ? hlsfNodes : [];

    if (!window.HLSF.nodes.length) {
      logWarning('No cached tokens found for HLSF. Process some queries first to populate the database.');
      return;
    }

    console.log(`Creating canvas UI for ${window.HLSF.nodes.length} nodes`);

    const container = document.createElement('div');
    container.className = 'hlsf-canvas-container';
  container.innerHTML = `
    <div style="margin-bottom: 1rem;">
      <div class="section-title">🌌 HLSF: Hierarchical-Level Semantic Framework</div>
      <div style="font-size: 0.9rem; opacity: 0.8; margin-top: 0.5rem;">
        Geometric token visualization. Each polygon fans outward from a primary corner based on
        adjacency types, forming unique base-level shapes per matrix. Triangular subdivisions show
        hierarchical structure.
      </div>
    </div>
    <canvas id="hlsf-canvas" width="1200" height="600"></canvas>
    <div class="hlsf-controls">
      <div class="hlsf-control-group">
        <label>Emergent Rotation Speed</label>
        <input type="range" id="hlsf-rotation-speed" min="-5" max="5" step="0.01" value="0.30">
        <span id="hlsf-speed-val">0.30</span>
      </div>

      <div class="hlsf-control-group">
        <label>Alpha Transparency</label>
        <input type="range" id="hlsf-alpha" min="0" max="0.99" step="0.01" value="0.67">
        <span id="hlsf-alpha-val">0.67</span>
      </div>

      <div class="hlsf-control-group">
        <label>View Controls</label>
        <div class="hlsf-button-row">
          <button id="hlsf-zoom-in" class="btn btn-secondary">Zoom +</button>
          <button id="hlsf-zoom-out" class="btn btn-secondary">Zoom −</button>
          <button id="hlsf-zoom-portal" class="btn btn-secondary">Portal</button>
          <button id="hlsf-reset-view" class="btn btn-secondary">Reset</button>
        </div>
      </div>

      <div class="hlsf-control-group">
        <label>Emergent Rotation</label>
        <div class="hlsf-button-row">
          <button id="hlsf-toggle-emergent" class="btn btn-success">Start Emergence</button>
        </div>
      </div>

      <div class="hlsf-control-group">
        <label>Display Options</label>
        <div class="hlsf-button-row">
          <button id="hlsf-toggle-edges" class="btn btn-neutral">Edges: On</button>
          <button id="hlsf-toggle-adjacency" class="btn btn-neutral">Adjacency: Compact</button>
          <button id="hlsf-toggle-labels" class="btn btn-neutral">Labels: On</button>
          <button id="hlsf-toggle-bg" class="btn btn-neutral">BG: Dark</button>
        </div>
      </div>
    </div>
    <div style="margin-top: 1rem; padding: 0.75rem; background: rgba(0,255,136,0.05); border-radius: 8px; font-size: 0.85rem;">
      <strong>Controls:</strong> Drag to pan • Scroll to zoom • Each polygon = token matrix •
      Fan vertices = adjacency types • Color = attention score<br>
      <strong>Modes:</strong> Emergent rotation = each polygon and its cluster rotate around their own centers

    </div>
  `;

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<div class="timestamp">${new Date().toLocaleTimeString()}</div>`;
  entry.appendChild(container);
  const logContainer = elements.log instanceof HTMLElement ? elements.log : null;
  if (logContainer) {
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // Initialize canvas
  window.HLSF.canvas = document.getElementById('hlsf-canvas');
  if (window.HLSF.canvas) {
    installClusterZoom(window.HLSF.canvas as HTMLCanvasElement);
    window.HLSF.ctx = window.HLSF.canvas.getContext('2d');
  } else {
    window.HLSF.ctx = null;
  }

  console.log('Canvas initialized:', window.HLSF.canvas ? 'success' : 'failed');

  // Setup controls
  const speedSlider = document.getElementById('hlsf-rotation-speed');
  const speedVal = document.getElementById('hlsf-speed-val');
  if (speedSlider && speedVal) {
    const omega = Number.isFinite(window.HLSF.config.rotationOmega)
      ? window.HLSF.config.rotationOmega
      : 0;
    speedSlider.value = omega.toFixed(2);
    speedVal.textContent = omega.toFixed(2);
    speedSlider.addEventListener('input', (e) => {
      const next = parseFloat(e.target.value);
      if (!Number.isFinite(next)) return;
      const clamped = Math.max(-5, Math.min(5, next));
      window.HLSF.config.rotationOmega = clamped;
      window.HLSF.state = window.HLSF.state || {};
      if (!window.HLSF.state.emergent || typeof window.HLSF.state.emergent !== 'object') {
        window.HLSF.state.emergent = { on: true, speed: clamped };
      } else {
        window.HLSF.state.emergent.speed = clamped;
      }
      if (Math.abs(clamped - next) > 1e-6) {
        speedSlider.value = clamped.toFixed(2);
      }
      speedVal.textContent = clamped.toFixed(2);
      if (window.HLSF.state.emergent.on) {
        requestRender();
      } else {
        debouncedLegacyRender();
      }
    });
  }

  const alphaSlider = document.getElementById('hlsf-alpha');
  const alphaVal = document.getElementById('hlsf-alpha-val');
  if (alphaSlider && alphaVal) {
    const alpha = baseAlpha();
    alphaSlider.value = alpha.toFixed(2);
    alphaVal.textContent = alpha.toFixed(2);
    window.HLSF.config.alpha = alpha;
    alphaSlider.addEventListener('input', (e) => {
      const raw = parseFloat(e.target.value);
      const next = clampAlpha(raw);
      if (!Number.isFinite(next)) {
        logError('Alpha value must be numeric.');
        return;
      }
      window.HLSF.config.alpha = next;
      alphaVal.textContent = next.toFixed(2);
      if (Math.abs(next - parseFloat(alphaSlider.value)) > 1e-6) {
        alphaSlider.value = next.toFixed(2);
      }
      debouncedLegacyRender();
    });
  }

  const globalZoomIn = document.getElementById('hlsf-zoom-in');
  if (globalZoomIn) {
    globalZoomIn.addEventListener('click', () => {
      const view = window.HLSF.view;
      const next = Math.min(12, Math.max(0.25, view.scale * 1.2));
      window.HLSF.view.scale = next;
      syncViewToConfig();
      requestRender();
    });
  }

  const globalZoomOut = document.getElementById('hlsf-zoom-out');
  if (globalZoomOut) {
    globalZoomOut.addEventListener('click', () => {
      const view = window.HLSF.view;
      const next = Math.min(12, Math.max(0.25, view.scale * 0.8));
      window.HLSF.view.scale = next;
      syncViewToConfig();
      requestRender();
    });
  }

  const globalReset = document.getElementById('hlsf-reset-view');
  if (globalReset) {
    globalReset.addEventListener('click', () => {
      window.HLSF.view.scale = 1;
      const canvasEl = window.HLSF.canvas;
      if (canvasEl) {
        const width = canvasEl.clientWidth || canvasEl.width;
        const height = canvasEl.clientHeight || canvasEl.height;
        window.HLSF.view.x = width / 2;
        window.HLSF.view.y = height / 2;
      } else {
        window.HLSF.view.x = 0;
        window.HLSF.view.y = 0;
      }
      syncViewToConfig();
      requestRender();
    });
  }

  const globalPortal = document.getElementById('hlsf-zoom-portal');
  if (globalPortal) {
    globalPortal.addEventListener('click', () => {
      const canvasEl = window.HLSF.canvas;
      if (!canvasEl) return;
      const width = canvasEl.clientWidth || canvasEl.width;
      const height = canvasEl.clientHeight || canvasEl.height;
      animateViewport({
        x: width / 2,
        y: height / 2,
        scale: Math.max(1.5, window.HLSF.view.scale * 2),
      }, 350);
    });
  }

  const emergentBtn = document.getElementById('hlsf-toggle-emergent');
  emergentBtn.addEventListener('click', () => {
    const state = window.HLSF.state.emergent;
    state.on = !state.on;
    window.HLSF.config.emergentActive = state.on;
    emergentBtn.textContent = state.on ? 'Stop Emergence' : 'Start Emergence';
    if (state.on && window.HLSF.currentGraph) {
      animateHLSF(window.HLSF.currentGraph, window.HLSF.currentGlyphOnly === true);
    } else if (!state.on && _anim) {
      cancelAnimationFrame(_anim);
      _anim = null;
    }
    requestRender();
  });

  const edgesBtn = document.getElementById('hlsf-toggle-edges');
  edgesBtn.addEventListener('click', () => {
    window.HLSF.config.showEdges = !window.HLSF.config.showEdges;
    edgesBtn.textContent = window.HLSF.config.showEdges ? 'Edges: On' : 'Edges: Off';
    debouncedLegacyRender();
  });

  const adjacencyBtn = document.getElementById('hlsf-toggle-adjacency');
  if (adjacencyBtn) {
    adjacencyBtn.addEventListener('click', () => {
      toggleAdjacencyExpansion({ root: document.getElementById('hlsf-canvas-container'), source: 'button' }).catch(err => {
        console.warn('Failed to toggle adjacency expansion:', err);
      });
    });
  }

  const labelsBtn = document.getElementById('hlsf-toggle-labels');
  labelsBtn.addEventListener('click', () => {
    window.HLSF.config.showLabels = !window.HLSF.config.showLabels;
    labelsBtn.textContent = window.HLSF.config.showLabels ? 'Labels: On' : 'Labels: Off';
    debouncedLegacyRender();
  });

  const bgBtn = document.getElementById('hlsf-toggle-bg');
  bgBtn.addEventListener('click', () => {
    window.HLSF.config.whiteBg = !window.HLSF.config.whiteBg;
    bgBtn.textContent = window.HLSF.config.whiteBg ? 'BG: Light' : 'BG: Dark';
    debouncedLegacyRender();
  });

  // Mouse interaction
  let isDragging = false;
  let lastX = 0;
  let lastY = 0;

  window.HLSF.canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.HLSF.canvas.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      window.HLSF.view.x += dx;
      window.HLSF.view.y += dy;
      syncViewToConfig();
      lastX = e.clientX;
      lastY = e.clientY;
      requestRender();
    }
  });

  window.HLSF.canvas.addEventListener('mouseup', () => {
    isDragging = false;
  });

  window.HLSF.canvas.addEventListener('mouseleave', () => {
    isDragging = false;
  });

  window.HLSF.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    window.HLSF.view.scale = Math.min(12, Math.max(0.25, window.HLSF.view.scale * factor));
    syncViewToConfig();
    requestRender();
  }, { passive: false });

  // Center view
  if (window.HLSF.canvas) {
    const width = window.HLSF.canvas.clientWidth || window.HLSF.canvas.width;
    const height = window.HLSF.canvas.clientHeight || window.HLSF.canvas.height;
    window.HLSF.view.x = width / 2;
    window.HLSF.view.y = height / 2;
  } else {
    window.HLSF.view.x = 0;
    window.HLSF.view.y = 0;
  }
  syncViewToConfig();

  // Build nodes
  window.HLSF.nodes = hlsfNodes;

  // Initial render
  renderLegacyHLSF();

  // Start animation
  animateLegacyHLSF();

  logOK(`HLSF visualization initialized with ${hlsfNodes.length} token matrices`);

  } catch (err) {
    logError(`Failed to initialize HLSF canvas: ${err.message}`);
    console.error('HLSF canvas error:', err);
    throw err;
  }
}

function strokePolygon(ctx, verts) {
  if (!verts || verts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(verts[0][0], verts[0][1]);
  for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i][0], verts[i][1]);
  ctx.closePath();
  ctx.stroke();
}

function strokeTriangles(ctx, tris) {
  if (!tris) return;
  for (const t of tris) strokePolygon(ctx, t);
}

function normalizeColorTuple(value: unknown): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b] = value;
    return [
      Math.max(0, Math.min(255, Number(r) || 0)),
      Math.max(0, Math.min(255, Number(g) || 0)),
      Math.max(0, Math.min(255, Number(b) || 0)),
    ];
  }
  return [0, 255, 136];
}

function mixRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped),
  ];
}

function rgbTupleToString(tuple: [number, number, number]): string {
  return `rgb(${tuple[0]}, ${tuple[1]}, ${tuple[2]})`;
}

function nodeEdgeStrokeColor(node, vertexIndex: number, mode: EdgeColorMode): string {
  const baseTuple = normalizeColorTuple(node?.color);
  if (vertexIndex === 0 || mode === 'theme') {
    return rgbTupleToString(baseTuple);
  }

  if (mode === 'weight') {
    const weights = Array.isArray(node?.vertexWeights) ? node.vertexWeights : null;
    const weight = Number(weights?.[vertexIndex]);
    const normalized = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0.5;
    const mix = mixRgb([200, 200, 200], baseTuple, normalized);
    return rgbTupleToString(mix);
  }

  if (mode === 'relation') {
    const relations = Array.isArray(node?.vertexRelations) ? node.vertexRelations : null;
    const relationEntry = relations?.[vertexIndex];
    const keyCandidate = relationEntry && typeof relationEntry === 'object' && relationEntry?.key
      ? relationEntry.key
      : node?.vertexLabels?.[vertexIndex] || node?.verticesLabels?.[vertexIndex];
    const palette = paletteColor(typeof keyCandidate === 'string' ? keyCandidate : '');
    return palette;
  }

  return rgbTupleToString(baseTuple);
}

function getHlsfScale(): number {
  const hlsf = (window as any)?.HLSF;
  const raw = Number(hlsf?.config?.scale);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  return raw;
}

function worldToScreen(x, y) {
  const scale = getHlsfScale();
  const hlsf = (window as any)?.HLSF;
  const config = (hlsf?.config ?? {}) as Record<string, unknown>;
  const txValue = Number((config as any).tx);
  const tyValue = Number((config as any).ty);
  const tx = Number.isFinite(txValue) ? txValue : 0;
  const ty = Number.isFinite(tyValue) ? tyValue : 0;
  const sx = x * (200 * scale) + tx;
  const sy = -y * (200 * scale) + ty;
  return [sx, sy];
}

function renderLegacyHLSF() {
  if (!window.HLSF.canvas || !window.HLSF.ctx) {
    console.warn('Canvas not initialized for renderHLSF');
    return;
  }

  try {
    const ctx = window.HLSF.ctx;
    const width = window.HLSF.canvas.width;
    const height = window.HLSF.canvas.height;
    const nodes = Array.isArray(window.HLSF?.nodes) ? window.HLSF.nodes : [];
    const scale = getHlsfScale();
    const theme = window.HLSF.config.whiteBg
      ? { bg: '#ffffff', fg: '#000000', grid: 'rgba(0, 0, 0, 0.05)' }
      : { bg: '#0a0a0a', fg: '#ffffff', grid: 'rgba(0, 255, 136, 0.05)' };
    const nodeScale = clampNodeSize(window.HLSF.config.nodeSize);
    const edgeColorMode = normalizeEdgeColorMode(window.HLSF.config.edgeColorMode);
    const edgeWidth = clampEdgeWidth(window.HLSF.config.edgeWidth);
    const effectiveEdgeWidth = edgeWidth * Math.max(0.6, scale || 1);
    const focusSet = window.HLSF?.state?.documentFocus instanceof Set
      ? window.HLSF.state.documentFocus
      : null;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = theme.bg;
    ctx.strokeStyle = theme.fg;
    ctx.lineWidth = 1;

    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = theme.grid;
    for (let x = 0; x < width; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = theme.fg;
    if (window.HLSF.config.fillFaces === true) {
      /* intentionally unused now */
    }

    for (const node of nodes) {
      let triangles = Array.isArray(node.triangles) ? node.triangles : [];
      let vertices = Array.isArray(node.vertices) ? node.vertices : [];
      const nodeColor = Array.isArray(node.color) ? node.color : [0, 255, 136];
      const [r, g, b] = nodeColor;
      const tokenKey = typeof node.token === 'string' ? node.token.toLowerCase() : '';
      const inFocus = focusSet && focusSet.has(tokenKey);

      if (window.HLSF.config.emergentActive) {
        const angle = window.HLSF.state?.emergentRot ?? 0;
        triangles = rotateTrianglesAround(triangles, node.center, angle);
        vertices = rotatePointsAround(vertices, node.center, angle);
      }

      const scalePivot = node.center;
      if (Math.abs(nodeScale - 1) > 1e-3) {
        triangles = scaleTrianglesAround(triangles, scalePivot, nodeScale);
        vertices = scalePointsAround(vertices, scalePivot, nodeScale);
      }

      triangles = Array.isArray(triangles) ? triangles : [];
      vertices = Array.isArray(vertices) ? vertices : [];

      const screenTriangles = triangles.map(tri => tri.map(([x, y]) => worldToScreen(x, y)));
      const screenVertices = vertices.map(([x, y]) => worldToScreen(x, y));

      ctx.globalAlpha = baseAlpha();
      ctx.strokeStyle = inFocus ? '#00ffcc' : theme.fg;
      ctx.lineWidth = effectiveEdgeWidth * (inFocus ? 1.6 : 1);
      ctx.save();
      if (window.HLSF.config.showNodeGlow) {
        const glowColor = inFocus ? `rgba(0, 255, 200, 0.65)` : `rgba(${r}, ${g}, ${b}, 0.35)`;
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = (inFocus ? 28 : 16) * Math.max(1, scale || 1);
      }

      strokePolygon(ctx, screenVertices);
      strokeTriangles(ctx, screenTriangles);
      ctx.restore();

      if (window.HLSF.config.showEdges && screenVertices.length > 1) {
        const anchorIndex = typeof node.anchorIndex === 'number' ? node.anchorIndex : 0;
        const anchor = screenVertices[anchorIndex];
        for (let i = 0; i < screenVertices.length; i++) {
          if (i === anchorIndex) continue;
          const [vx, vy] = screenVertices[i];
          const strokeColor = nodeEdgeStrokeColor(node, i, edgeColorMode) || theme.fg;
          const edgeFocus = inFocus && focusSet && focusSet.has((node.verticesLabels?.[i] || '').toLowerCase());
          ctx.strokeStyle = edgeFocus ? '#00ffcc' : strokeColor;
          ctx.lineWidth = effectiveEdgeWidth * (edgeFocus ? 1.5 : 1);
          ctx.beginPath();
          ctx.moveTo(anchor[0], anchor[1]);
          ctx.lineTo(vx, vy);
          ctx.stroke();
        }
        ctx.strokeStyle = theme.fg;
        ctx.lineWidth = effectiveEdgeWidth;
      }

      ctx.globalAlpha = 1.0;

      if (window.HLSF.config.showLabels) {
        const centerForLabel = node.center;
        const [sx, sy] = worldToScreen(centerForLabel[0], centerForLabel[1]);
        ctx.save();
        if (window.HLSF.config.showNodeGlow) {
          const glowColor = inFocus ? 'rgba(0, 255, 200, 0.75)' : `rgba(${r}, ${g}, ${b}, 0.45)`;
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = (inFocus ? 32 : 18) * Math.max(1, scale || 1);
        }
        ctx.globalAlpha = baseAlpha();
        ctx.fillStyle = inFocus ? 'rgba(0, 255, 204, 0.9)' : `rgba(${r}, ${g}, ${b}, 0.9)`;
        ctx.font = `${Math.max(12, 20 * scale)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.glyph, sx, sy);
        ctx.restore();

        ctx.fillStyle = inFocus
          ? (window.HLSF.config.whiteBg ? 'rgba(0, 128, 128, 0.8)' : 'rgba(0, 255, 204, 0.8)')
          : window.HLSF.config.whiteBg ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.7)';
        ctx.font = `${Math.max(9, 11 * scale)}px Fira Code, monospace`;
        ctx.fillText(node.token, sx, sy + 25 * scale);
        ctx.globalAlpha = 1.0;
      }
    }

    ctx.globalAlpha = 1.0;
    ctx.fillStyle = window.HLSF.config.whiteBg ? 'rgba(0, 0, 0, 0.8)' : 'rgba(0, 255, 136, 0.8)';
    ctx.font = '12px Fira Code, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Nodes: ${nodes.length} | Zoom: ${scale.toFixed(2)}x`, 10, 20);

  } catch (err) {
    console.error('Error rendering HLSF:', err);
  }
}

const debouncedLegacyRender = debounce(() => {
  if (window.HLSF?.currentGraph) {
    drawComposite(window.HLSF.currentGraph, { glyphOnly: window.HLSF.currentGlyphOnly === true });
  } else {
    renderLegacyHLSF();
  }
}, 16);

function requestRender() {
  debouncedLegacyRender();
}

function setDocumentFocusTokens(tokens) {
  const normalized = normalizeTokenList(tokens);
  window.HLSF = window.HLSF || {};
  window.HLSF.state = window.HLSF.state || {};
  window.HLSF.state.documentFocus = new Set(normalized);
  requestRender();
}

function animateViewport(target, ms = 300) {
  const view = window.HLSF.view;
  const start = performance.now();
  const s0 = { x: view.x, y: view.y, scale: view.scale };
  const duration = Number.isFinite(ms) ? Math.max(16, ms) : 300;
  function step(t) {
    const k = Math.min(1, (t - start) / duration);
    const eased = k * (2 - k);
    view.x = s0.x + eased * ((target?.x ?? s0.x) - s0.x);
    view.y = s0.y + eased * ((target?.y ?? s0.y) - s0.y);
    const targetScale = Number.isFinite(target?.scale) ? Math.max(0.1, target.scale) : s0.scale;
    view.scale = s0.scale + eased * (targetScale - s0.scale);
    syncViewToConfig();
    requestRender();
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

let _legacyLast = null;
function animateLegacyHLSF(now) {
  if (!window.HLSF.canvas || !window.HLSF.ctx) {
    console.warn('Canvas not ready for animation');
    return;
  }

  try {
    const timestamp = typeof now === 'number' ? now : performance.now();
    const last = _legacyLast ?? timestamp;
    const dt = (timestamp - last) / 1000;
    _legacyLast = timestamp;
    stepRotation(dt);

    if (window.HLSF.config.emergentActive) {
      renderLegacyHLSF();
    }
  } catch (err) {
    console.error('Error in HLSF animation:', err);
  }

  window.HLSF.animationFrame = requestAnimationFrame(animateLegacyHLSF);
}

function stopLegacyHLSFAnimation() {
  try {
    if (window.HLSF && window.HLSF.animationFrame) {
      cancelAnimationFrame(window.HLSF.animationFrame);
      window.HLSF.animationFrame = null;
    }
    if (window.HLSF && window.HLSF.config) {
      window.HLSF.config.emergentActive = false;
    }
    if (window.HLSF?.state?.emergent) {
      window.HLSF.state.emergent.on = false;
      window.HLSF.state.emergentRot = 0;
    }
    _legacyLast = null;
  } catch (err) {
    console.warn('Error stopping HLSF animation:', err);
  }
}

window.HLSF.rendering = {
  render: renderLegacyHLSF,
  animate: animateLegacyHLSF,
  stop: stopLegacyHLSFAnimation,
};
function computeRelHistogramEntries(db) {
  const hist = new Map();
  for (const rec of db.full_token_data || []) {
    const rels = rec?.relationships || {};
    for (const key of Object.keys(rels)) {
      const glyph = normalizeRelKeyForStats(key);
      if (!glyph) continue;
      const edges = Array.isArray(rels[key]) ? rels[key] : [];
      if (!edges.length) continue;
      hist.set(glyph, (hist.get(glyph) || 0) + edges.length);
    }
  }
  return [...hist.entries()].sort((a, b) => b[1] - a[1]);
}

function computeRelHistogram(db, entries){
  const base = Array.isArray(entries) ? entries : computeRelHistogramEntries(db);
  return base.map(([glyph, count]) => renderRelTypeRow(glyph, count));
}

function edgeSignatureForMerge(edge) {
  if (!edge || typeof edge !== 'object') return '';
  const token = edge.token ?? '';
  const relType = edge.type ?? edge.relationship ?? '';
  const weight = Number.isFinite(edge.weight)
    ? edge.weight
    : Number.isFinite(edge.w)
      ? edge.w
      : Number.isFinite(edge.attention)
        ? edge.attention
        : 0;
  return `${token}::${relType}::${weight}`;
}

function mergeRelationshipLists(existing, incoming) {
  const base = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(incoming) ? incoming : [];
  if (base.length === 0) return next.slice();
  if (next.length === 0) return base.slice();

  const merged = base.slice();
  const seen = new Set(base.map(edgeSignatureForMerge));
  for (const edge of next) {
    const sig = edgeSignatureForMerge(edge);
    if (!seen.has(sig)) {
      seen.add(sig);
      merged.push(edge);
    }
  }
  return merged;
}

function mergeTokenRecords(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged = Object.assign({}, existing, incoming);
  const baseRels = existing.relationships || {};
  const incomingRels = incoming.relationships || {};
  const relKeys = new Set([...Object.keys(baseRels), ...Object.keys(incomingRels)]);
  const outRels = {};
  for (const key of relKeys) {
    outRels[key] = mergeRelationshipLists(baseRels[key], incomingRels[key]);
  }
  merged.relationships = outRels;
  if (!merged.cached_at) {
    merged.cached_at = existing.cached_at || incoming.cached_at || null;
  }
  return merged;
}

function analyzeDatabaseMetadata() {
  const tokenFrequency = new Map();
  const index = new Map();
  let totalAttentionScore = 0;
  let oldestToken = null;
  let newestToken = null;

  const addRecord = (rec) => {
    const normalized = normalizeRecord(rec);
    if (!normalized) return;
    const existing = index.get(normalized.token);
    const merged = mergeTokenRecords(existing, normalized);
    index.set(normalized.token, merged);
  };

  const db = getDb();
  if (db?.full_token_data?.length) {
    for (const rec of db.full_token_data) addRecord(rec);
  }

  const keys = safeStorageKeys(TOKEN_CACHE_PREFIX);
  for (const key of keys) {
    try {
      const data = safeStorageGet(key);
      if (data && typeof data === 'object') {
        addRecord(data);
      }
    } catch (err) {
      console.error('Failed to parse token:', key, err);
    }
  }

  const tokens = Array.from(index.values());

  const relTypeMaxCache = new Map();
  let maxAdjacencyMatrixCount = 0;
  const maxAdjacencyMatrixTokens = new Set();

  const cachedTokenSet = new Set();
  for (const key of index.keys()) {
    if (key == null) continue;
    cachedTokenSet.add(String(key).toLowerCase());
  }

  const sessionTokenSet = window.Session?.tokens instanceof Set ? window.Session.tokens : new Set();
  let cachedSessionTokens = 0;
  for (const token of sessionTokenSet) {
    if (!token) continue;
    if (cachedTokenSet.has(String(token).toLowerCase())) {
      cachedSessionTokens += 1;
    }
  }
  const sessionTokenCount = sessionTokenSet instanceof Set ? sessionTokenSet.size : 0;
  const sessionCoverage = sessionTokenCount > 0 ? cachedSessionTokens / sessionTokenCount : 0;

  for (const data of tokens) {
    if (!data || typeof data !== 'object') continue;

    if (data.cached_at) {
      const timestamp = new Date(data.cached_at);
      if (!Number.isNaN(timestamp.getTime())) {
        if (!oldestToken || timestamp < new Date(oldestToken.cached_at)) {
          oldestToken = data;
        }
        if (!newestToken || timestamp > new Date(newestToken.cached_at)) {
          newestToken = data;
        }
      }
    }

    const rels = data.relationships || {};
    const adjacencyNeighbors = new Set();
    for (const [relType, edges] of Object.entries(rels)) {
      if (!Array.isArray(edges)) continue;
      const glyph = normalizeRelKeyForStats(relType);
      if (!glyph) continue;

      const uniqueTargets = new Set();

      for (const edge of edges) {
        const rawToken = edge?.token;
        const normalizedToken = typeof rawToken === 'string' ? rawToken.trim() : '';
        if (normalizedToken) {
          const freqKey = normalizedToken.toLowerCase();
          tokenFrequency.set(freqKey, (tokenFrequency.get(freqKey) || 0) + 1);
          adjacencyNeighbors.add(normalizedToken);
          uniqueTargets.add(normalizedToken);
        }
      }

      if (uniqueTargets.size > 0) {
        const entry = relTypeMaxCache.get(glyph);
        if (!entry || uniqueTargets.size > entry.count) {
          const tokensWithPeak = new Set();
          const sourceToken = typeof data.token === 'string' ? data.token.trim() : '';
          if (sourceToken) tokensWithPeak.add(sourceToken);
          relTypeMaxCache.set(glyph, { count: uniqueTargets.size, tokens: tokensWithPeak });
        } else if (uniqueTargets.size === entry.count) {
          const sourceToken = typeof data.token === 'string' ? data.token.trim() : '';
          if (sourceToken) entry.tokens.add(sourceToken);
        }
      }
    }

    if (adjacencyNeighbors.size > 0) {
      if (adjacencyNeighbors.size > maxAdjacencyMatrixCount) {
        maxAdjacencyMatrixCount = adjacencyNeighbors.size;
        maxAdjacencyMatrixTokens.clear();
        const sourceToken = typeof data.token === 'string' ? data.token.trim() : '';
        if (sourceToken) maxAdjacencyMatrixTokens.add(sourceToken);
      } else if (adjacencyNeighbors.size === maxAdjacencyMatrixCount) {
        const sourceToken = typeof data.token === 'string' ? data.token.trim() : '';
        if (sourceToken) maxAdjacencyMatrixTokens.add(sourceToken);
      }
    }

    if (data.attention_score) {
      totalAttentionScore += data.attention_score;
    }
  }

  const limitList = (collection, max = 10) => {
    const out = [];
    if (!collection) return out;
    if (Array.isArray(collection)) {
      for (const value of collection) {
        if (value == null || value === '') continue;
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    }
    if (typeof collection[Symbol.iterator] === 'function') {
      for (const value of collection) {
        if (value == null || value === '') continue;
        out.push(value);
        if (out.length >= max) break;
      }
    }
    return out;
  };

  let maxRelTypeCount = 0;
  const maxRelTypeEntries = [];
  for (const [glyph, info] of relTypeMaxCache.entries()) {
    if (!info || !Number.isFinite(info.count)) continue;
    if (info.count <= 0) continue;
    if (info.count > maxRelTypeCount) {
      maxRelTypeCount = info.count;
      maxRelTypeEntries.length = 0;
    }
    if (info.count === maxRelTypeCount) {
      maxRelTypeEntries.push({
        type: glyph,
        tokens: limitList(info.tokens, 10),
      });
    }
  }

  const maxAdjacencyMatrixSummary = {
    count: maxAdjacencyMatrixCount,
    tokens: limitList(maxAdjacencyMatrixTokens, 10),
  };

  const relHistogramEntries = computeRelHistogramEntries({ full_token_data: tokens });
  const relHistogramRows = computeRelHistogram(null, relHistogramEntries);
  const dbStats = computeDbStats(index);
  const totalRelationships = dbStats.relationships;
  const topRelationships = relHistogramEntries.slice(0, 10);
  const topRelationshipRows = relHistogramRows.slice(0, 10);

  const topTokens = Array.from(tokenFrequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const highAttentionTokens = tokens
    .filter(t => t?.attention_score)
    .sort((a, b) => (b.attention_score || 0) - (a.attention_score || 0))
    .slice(0, 10);

  const adjacencyCostPerToken = estimateCostUsd(
    CONFIG.ADJACENCY_TOKEN_ESTIMATES.prompt,
    CONFIG.ADJACENCY_TOKEN_ESTIMATES.completion
  );

  return {
    totalTokens: dbStats.tokens,
    totalRelationships,
    avgAttentionScore: tokens.length > 0 ? (totalAttentionScore / tokens.length).toFixed(3) : 0,
    topRelationships,
    topRelationshipRows,
    relHistogramRows,
    topTokens,
    highAttentionTokens,
    oldestToken,
    newestToken,
    estimatedValue: tokens.length * adjacencyCostPerToken,
    rawData: tokens,
    dbStats,
    sessionTokenCount,
    cachedSessionTokens,
    sessionCoverage,
    maxRelTypeTokens: {
      count: maxRelTypeCount,
      types: maxRelTypeEntries,
    },
    maxAdjacencyMatrixTokens: maxAdjacencyMatrixSummary,
  };
}

function snapshotConversationLog() {
  const logElement = elements?.log;
  if (!(logElement instanceof HTMLElement)) {
    return { html: '', entries: [] };
  }
  const entries = Array.from(logElement.querySelectorAll('.log-entry')).map((node: Element) => ({
    className: typeof (node as HTMLElement).className === 'string' ? (node as HTMLElement).className : '',
    html: (node as HTMLElement).innerHTML || '',
  }));
  return {
    html: logElement.innerHTML || '',
    entries,
  };
}

function restoreConversationLog(snapshot) {
  const logElement = elements?.log;
  if (!(logElement instanceof HTMLElement)) return;
  const html = snapshot && typeof snapshot.html === 'string' ? snapshot.html : '';
  if (html) {
    logElement.innerHTML = html;
  } else if (Array.isArray(snapshot?.entries) && snapshot.entries.length) {
    logElement.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const entry of snapshot.entries) {
      if (!entry || typeof entry.html !== 'string') continue;
      const div = document.createElement('div');
      div.className = typeof entry.className === 'string' ? entry.className : 'log-entry';
      div.innerHTML = entry.html;
      fragment.appendChild(div);
    }
    logElement.appendChild(fragment);
  } else {
    logElement.innerHTML = '';
  }
  logElement.scrollTop = logElement.scrollHeight;
}

function clearConversationLog(options: { resetBatchLog?: boolean } = {}) {
  const { resetBatchLog = false } = options;
  try {
    restoreConversationLog({ html: '', entries: [] });
  } catch (err) {
    const logElement = elements?.log;
    if (logElement instanceof HTMLElement) {
      logElement.innerHTML = '';
      logElement.scrollTop = logElement.scrollHeight;
    } else {
      console.warn('Unable to clear conversation log:', err);
    }
  }

  if (resetBatchLog) {
    try {
      BatchLog?.clear?.();
    } catch (batchErr) {
      console.warn('Batch log clear failed during reset:', batchErr);
    }
  }
}

function snapshotLocalHlsfMemory() {
  const memory = ensureLocalHlsfMemory();
  if (!memory) return null;

  const prompts = Array.isArray(memory.prompts)
    ? memory.prompts.map(entry => {
        if (!entry || typeof entry !== 'object') return null;
        const clone = Object.assign({}, entry);
        if (Array.isArray(clone.tokens)) clone.tokens = clone.tokens.filter(Boolean);
        if (Array.isArray(clone.adjacencySeeds)) clone.adjacencySeeds = clone.adjacencySeeds.filter(Boolean);
        return clone;
      }).filter(Boolean)
    : [];

  const adjacencySummaries = memory.adjacencySummaries instanceof Map
    ? Array.from(memory.adjacencySummaries.entries()).map(([key, value]) => [key, value])
    : [];

  return {
    prompts,
    adjacencySummaries,
    lastPrompt: memory.lastPrompt || null,
    lastAdjacency: memory.lastAdjacency || null,
  };
}

function restoreLocalHlsfMemory(snapshot) {
  const memory = ensureLocalHlsfMemory();
  if (!memory) return;

  const resolvedPrompts = Array.isArray(snapshot?.prompts)
    ? snapshot.prompts
        .map(entry => {
          if (!entry || typeof entry !== 'object') return null;
          const text = typeof entry.text === 'string' ? entry.text : '';
          if (!text) return null;
          const normalized = {
            id: typeof entry.id === 'string' ? entry.id : (entry.id != null ? String(entry.id) : undefined),
            text,
            tokens: Array.isArray(entry.tokens) ? entry.tokens.filter(Boolean) : [],
            adjacencySeeds: Array.isArray(entry.adjacencySeeds) ? entry.adjacencySeeds.filter(Boolean) : [],
            timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
          } as any;
          if (normalized.id == null || normalized.id === '') {
            normalized.id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          }
          if (entry.meta && typeof entry.meta === 'object') {
            normalized.meta = Object.assign({}, entry.meta);
          }
          return normalized;
        })
        .filter(Boolean)
    : [];

  const adjacency = new Map();
  if (Array.isArray(snapshot?.adjacencySummaries)) {
    for (const entry of snapshot.adjacencySummaries) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [key, value] = entry;
      if (typeof key !== 'string' || !key) continue;
      if (!value || typeof value !== 'object') continue;
      adjacency.set(key, value);
    }
  }

  memory.prompts = resolvedPrompts;
  memory.adjacencySummaries = adjacency;
  memory.lastPrompt = snapshot?.lastPrompt && typeof snapshot.lastPrompt === 'object'
    ? snapshot.lastPrompt
    : null;
  memory.lastAdjacency = snapshot?.lastAdjacency && typeof snapshot.lastAdjacency === 'object'
    ? snapshot.lastAdjacency
    : null;
}

function showDatabaseMetadata() {
  const metadata = analyzeDatabaseMetadata();
  const dbStats = Object.assign({
    tokens: metadata.totalTokens,
    relationships: metadata.totalRelationships,
    nodes: 0,
    edges: 0,
    anchors: 0,
    minEdges: { count: 0, tokens: [] },
    maxEdges: { count: 0, tokens: [] },
  }, metadata.dbStats || {});

  const formatEdgeTokens = (edgeInfo) => {
    if (!edgeInfo || !Array.isArray(edgeInfo.tokens) || edgeInfo.tokens.length === 0) {
      return '';
    }
    const maxDisplay = 5;
    const rendered = edgeInfo.tokens.slice(0, maxDisplay)
      .map(token => `<span class="token-highlight">${token}</span>`)
      .join(', ');
    const extraCount = edgeInfo.tokens.length - maxDisplay;
    const extra = extraCount > 0
      ? ` <small style="opacity: 0.65;">(+${extraCount} more)</small>`
      : '';
    return `${rendered}${extra}`;
  };

  const formatEdgeSummary = (edgeInfo) => {
    const count = Number.isFinite(edgeInfo?.count) ? edgeInfo.count : 0;
    const tokensDisplay = formatEdgeTokens(edgeInfo);
    if (tokensDisplay) {
      return `<strong>${count}</strong> (${tokensDisplay})`;
    }
    if ((dbStats.tokens || 0) === 0) {
      return `<strong>${count}</strong> <small style="opacity: 0.65;">(n/a)</small>`;
    }
    return `<strong>${count}</strong>`;
  };

  const minEdgeSummary = formatEdgeSummary(dbStats.minEdges);
  const maxEdgeSummary = formatEdgeSummary(dbStats.maxEdges);

  const sessionTokenCount = metadata.sessionTokenCount || 0;
  const coverageRatioRaw = (typeof metadata.sessionCoverage === 'number' && Number.isFinite(metadata.sessionCoverage))
    ? metadata.sessionCoverage
    : 0;
  const coverageRatio = Math.min(Math.max(coverageRatioRaw, 0), 1);
  const coverageDisplay = sessionTokenCount > 0 ? `${(coverageRatio * 100).toFixed(1)}%` : '0.0%';
  const coverageCountSummary = sessionTokenCount > 0
    ? `Coverage: <strong>${metadata.cachedSessionTokens || 0}</strong> / <strong>${sessionTokenCount}</strong> (${coverageDisplay})`
    : 'Coverage: No session tokens observed yet';

  const formatHighlightList = (tokens, maxDisplay = 5) => {
    if (!Array.isArray(tokens) || tokens.length === 0) return '';
    const rendered = tokens.slice(0, maxDisplay)
      .map(token => `<span class="token-highlight">${token}</span>`)
      .join(', ');
    const extraCount = tokens.length - maxDisplay;
    const extra = extraCount > 0
      ? ` <small style="opacity: 0.65;">(+${extraCount} more)</small>`
      : '';
    return `${rendered}${extra}`;
  };

  const maxRelTypeTokens = metadata.maxRelTypeTokens || { count: 0, types: [] };
  const maxRelTypeSummary = (() => {
    const count = Number.isFinite(maxRelTypeTokens?.count) ? maxRelTypeTokens.count : 0;
    if (count <= 0) {
      return `<strong>0</strong> <small style="opacity: 0.65;">(n/a)</small>`;
    }
    const entries = Array.isArray(maxRelTypeTokens.types) ? maxRelTypeTokens.types : [];
    if (entries.length === 0) {
      return `<strong>${count}</strong>`;
    }
    const [primary, ...rest] = entries;
    const typeLabel = primary?.type ? relDisplay(primary.type) : 'Unknown';
    const tokenDisplay = formatHighlightList(primary?.tokens || []);
    const extraTypes = rest.length;
    const extraTypeNote = extraTypes > 0
      ? ` <small style="opacity: 0.65;">(+${extraTypes} other type${extraTypes === 1 ? '' : 's'})</small>`
      : '';
    const tokenNote = tokenDisplay ? ` — ${tokenDisplay}` : '';
    return `<strong>${count}</strong> via <span class="token-highlight">${typeLabel}</span>${tokenNote}${extraTypeNote}`;
  })();

  const maxAdjacencyMatrixTokens = metadata.maxAdjacencyMatrixTokens || { count: 0, tokens: [] };
  const maxAdjacencySummary = (() => {
    const count = Number.isFinite(maxAdjacencyMatrixTokens?.count) ? maxAdjacencyMatrixTokens.count : 0;
    if (count <= 0) {
      return `<strong>0</strong> <small style="opacity: 0.65;">(n/a)</small>`;
    }
    const tokenDisplay = formatHighlightList(maxAdjacencyMatrixTokens.tokens || []);
    return tokenDisplay
      ? `<strong>${count}</strong> — ${tokenDisplay}`
      : `<strong>${count}</strong>`;
  })();

  let maturityLevel;
  let maturityColor;
  let maturityMessage;
  if (sessionTokenCount === 0) {
    maturityLevel = 'Early';
    maturityColor = 'var(--accent)';
    maturityMessage = 'No session tokens analyzed yet. Run a prompt to begin building cache coverage.';
  } else if (coverageRatio >= 0.95) {
    maturityLevel = 'Mature';
    maturityColor = 'var(--success)';
    maturityMessage = 'Cached knowledge covers 95%+ of observed inputs and outputs. Most queries reuse stored insights.';
  } else if (coverageRatio >= 0.6) {
    maturityLevel = 'Growing';
    maturityColor = 'var(--warning)';
    maturityMessage = 'Coverage is building. Many session tokens are cached but new ones still appear.';
  } else {
    maturityLevel = 'Early';
    maturityColor = 'var(--accent)';
    maturityMessage = 'Cache coverage is limited. Expect frequent new adjacency generation.';
  }

  addLog(`
    <div class="section-divider"></div>
    <div class="section-title">📊 Collective Database Metadata</div>

    <div class="adjacency-insight">
      <strong>🌐 Knowledge Base Status:</strong> <span style="color: ${maturityColor}; font-weight: bold;">${maturityLevel}</span><br>
      <small style="opacity: 0.8;">${maturityMessage}</small><br>
      <small style="opacity: 0.8; display: block; margin-top: 0.25rem;">${coverageCountSummary}</small>
    </div>

    <div class="adjacency-insight">
      <strong>💾 Database Size:</strong><br>
      • Total cached tokens: <strong>${metadata.totalTokens}</strong><br>
      • Total relationships: <strong>${metadata.totalRelationships}</strong><br>
      • Graph nodes (≥1 outgoing): <strong>${dbStats.nodes}</strong><br>
      • Edge types enumerated: <strong>${dbStats.edges}</strong><br>
      • Anchors (in ∩ out): <strong>${dbStats.anchors}</strong><br>
      • Minimum edges per token: ${minEdgeSummary}<br>
      • Maximum edges per token: ${maxEdgeSummary}<br>
      • Max tokens in a relationship type: ${maxRelTypeSummary}<br>
      • Max tokens per adjacency matrix: ${maxAdjacencySummary}<br>
      • Average attention score: <strong>${metadata.avgAttentionScore}</strong><br>
      • Network density: <strong>${(metadata.totalRelationships / Math.max(metadata.totalTokens, 1)).toFixed(2)}</strong> edges/token<br>
      • Estimated saved cost: <strong>${formatCurrency(metadata.estimatedValue || 0)}</strong>
    </div>

    <div class="adjacency-insight">
      <strong>📈 Most Common Relationship Types:</strong><br>
      ${metadata.topRelationshipRows.map(row =>
        `• <span class="token-highlight">${row}</span>`
      ).join('<br>')}
      ${metadata.topRelationshipRows.length === 0 ? '<em>No relationships cached yet</em>' : ''}
    </div>

    <div class="adjacency-insight">
      <strong>🔥 Most Referenced Tokens (Hub Concepts):</strong><br>
      <small style="opacity: 0.8;">These tokens appear most frequently across relationships - they represent core concepts in the knowledge graph.</small><br><br>
      ${metadata.topTokens.slice(0, 10).map(([token, count]) => 
        `• <span class="token-highlight">${token}</span>: ${count} references`
      ).join('<br>')}
      ${metadata.topTokens.length === 0 ? '<em>No hub concepts identified yet</em>' : ''}
    </div>

    <div class="adjacency-insight">
      <strong>⭐ Highest Attention Tokens:</strong><br>
      <small style="opacity: 0.8;">Tokens with the strongest weighted relationships - highly salient concepts.</small><br><br>
      ${metadata.highAttentionTokens.map(t => 
        `• <span class="token-highlight">${t.token}</span>: ${t.attention_score} (${t.total_relationships || 0} edges)`
      ).join('<br>')}
      ${metadata.highAttentionTokens.length === 0 ? '<em>No high-attention tokens yet</em>' : ''}
    </div>

    ${metadata.oldestToken ? `
    <div class="adjacency-insight">
      <strong>📅 Database Timeline:</strong><br>
      • Oldest entry: <strong>${metadata.oldestToken.token}</strong> (${new Date(metadata.oldestToken.cached_at).toLocaleString()})<br>
      • Newest entry: <strong>${metadata.newestToken.token}</strong> (${new Date(metadata.newestToken.cached_at).toLocaleString()})
    </div>
    ` : ''}

    <details>
      <summary>📊 View knowledge graph analytics</summary>
      <pre>${JSON.stringify({
        database_maturity: maturityLevel,
        network_density: (metadata.totalRelationships / Math.max(metadata.totalTokens, 1)).toFixed(2),
        top_5_relationship_types: metadata.topRelationships.slice(0, 5).map(([rel]) => relDisplay(rel)),
        relationship_histogram_named: metadata.relHistogramRows,
        top_5_hub_concepts: metadata.topTokens.slice(0, 5).map(([token]) => token),
        db_graph_metrics: dbStats,
        relationship_type_peaks: {
          max_tokens: metadata.maxRelTypeTokens?.count || 0,
          types: (metadata.maxRelTypeTokens?.types || []).map(entry => ({
            type: entry.type,
            type_display: relDisplay(entry.type),
            tokens: entry.tokens,
          })),
        },
        adjacency_matrix_peaks: {
          max_tokens: metadata.maxAdjacencyMatrixTokens?.count || 0,
          tokens: metadata.maxAdjacencyMatrixTokens?.tokens || [],
        },
        growth_metrics: {
          tokens_per_relationship: (metadata.totalTokens / Math.max(metadata.totalRelationships, 1)).toFixed(3),
          avg_edges_per_token: (metadata.totalRelationships / Math.max(metadata.totalTokens, 1)).toFixed(2)
        },
        session_cache_coverage: {
          observed_tokens: sessionTokenCount,
          cached_tokens: metadata.cachedSessionTokens || 0,
          coverage_ratio: Number(coverageRatio.toFixed(3)),
          coverage_percent: sessionTokenCount > 0 ? Number((coverageRatio * 100).toFixed(1)) : 0
        }
      }, null, 2)}</pre>
    </details>

    <div style="margin-top: 1rem; padding: 0.75rem; background: rgba(0,255,136,0.05); border-radius: 8px; font-size: 0.9rem;">
      💡 <strong>Insight:</strong> This metadata represents the collective intelligence being built. 
      In a server deployment, this would be shared across all users, with each query contributing 
      to a growing knowledge base that makes future queries faster and cheaper. The database also 
      powers the symbolic glyph encryption system for secure inter-system communication.
    </div>
  `);
}

function exportDatabaseMetadata(args = []) {
  const metadata = analyzeDatabaseMetadata();
  const dbStats = Object.assign({
    tokens: metadata.totalTokens,
    relationships: metadata.totalRelationships,
    nodes: 0,
    edges: 0,
    anchors: 0,
    minEdges: { count: 0, tokens: [] },
    maxEdges: { count: 0, tokens: [] },
  }, metadata.dbStats || {});

  const sessionTokenCount = metadata.sessionTokenCount || 0;
  const coverageRatioRaw = (typeof metadata.sessionCoverage === 'number' && Number.isFinite(metadata.sessionCoverage))
    ? metadata.sessionCoverage
    : 0;
  const coverageRatio = Math.min(Math.max(coverageRatioRaw, 0), 1);
  const coveragePercent = sessionTokenCount > 0 ? Number((coverageRatio * 100).toFixed(1)) : 0;
  const maturityLevel = sessionTokenCount === 0
    ? 'early'
    : (coverageRatio >= 0.95 ? 'mature' : coverageRatio >= 0.6 ? 'growing' : 'early');

  const sessionPromptLog = Array.isArray(Session?.prompts) ? Session.prompts : [];
  const promptsForExport = sessionPromptLog
    .map((entry, index) => {
      if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return null;
      const promptRecord = {
        order: index + 1,
        text: entry.text,
      };
      if (entry.timestamp) {
        promptRecord.timestamp = entry.timestamp;
      }
      if (entry.meta && typeof entry.meta === 'object' && Object.keys(entry.meta).length) {
        promptRecord.meta = entry.meta;
      }
      return promptRecord;
    })
    .filter(Boolean);

  const sessionTokens = Session?.tokens instanceof Set
    ? Array.from(Session.tokens).filter(token => typeof token === 'string' && token.trim())
    : [];
  const tokenOrderSnapshot = Array.isArray(state?.tokenOrder)
    ? state.tokenOrder.filter(token => typeof token === 'string' && token.trim())
    : [];
  const conversationSnapshot = snapshotConversationLog();
  const localMemorySnapshot = snapshotLocalHlsfMemory();

  let voiceProfileSnapshot = null;
  let voiceStoreSnapshot = null;
  try {
    const voiceApi = window.CognitionEngine?.voice;
    if (voiceApi) {
      if (typeof voiceApi.getProfileExport === 'function') {
        voiceProfileSnapshot = voiceApi.getProfileExport();
      }
      if (typeof voiceApi.getStore === 'function') {
        const storeSnapshot = voiceApi.getStore();
        if (storeSnapshot && typeof storeSnapshot === 'object') {
          voiceStoreSnapshot = storeSnapshot;
        }
      }
    }
  } catch (err) {
    console.warn('Unable to capture voice profile snapshot for export:', err);
  }

  const relationTypeCount = Array.isArray(metadata.relHistogramRows) ? metadata.relHistogramRows.length : null;
  const cliArgs = Array.isArray(args) ? args : [];
  const parseResult = resolveModelParamConfig(window.HLSF?.modelParamConfig || MODEL_PARAM_DEFAULTS, cliArgs, {
    relationTypeCount,
  });
  const layoutSnapshot = window.HLSF?.currentLayoutSnapshot || null;
  const resolvedConfig = Object.assign({}, parseResult.config);
  if (layoutSnapshot && typeof layoutSnapshot === 'object') {
    if (!parseResult.modified?.D && Number.isFinite(layoutSnapshot.dimension) && layoutSnapshot.dimension > 0) {
      resolvedConfig.D = Math.round(layoutSnapshot.dimension);
    }
    if (!parseResult.modified?.levels && Number.isFinite(layoutSnapshot.levelCount) && layoutSnapshot.levelCount >= 0) {
      resolvedConfig.levels = Math.round(layoutSnapshot.levelCount);
    }
    if (
      !parseResult.modified?.last_level_components &&
      Number.isFinite(layoutSnapshot.lastLevelComponents) &&
      layoutSnapshot.lastLevelComponents >= 0
    ) {
      resolvedConfig.last_level_components = Math.round(layoutSnapshot.lastLevelComponents);
    }
  }

  window.HLSF = window.HLSF || {};
  window.HLSF.modelParamConfig = resolvedConfig;

  const modelParams = computeModelParameters(
    {
      graph_nodes: dbStats.nodes,
      anchors: dbStats.anchors,
      edge_types_enumerated: dbStats.edges,
      total_relationships: dbStats.relationships,
      relation_types: relationTypeCount ?? undefined,
    },
    resolvedConfig,
    {
      fallbackRelationTypeCount: relationTypeCount ?? undefined,
      assumptions: parseResult.assumptions,
    }
  );

  if (parseResult.warnings && parseResult.warnings.length) {
    for (const msg of parseResult.warnings) {
      if (msg) logWarning(msg);
    }
  }
  if (parseResult.preset) {
    logStatus(`Model parameter preset: ${parseResult.preset}`);
  }

  const dimensionStats = {
    D: resolvedConfig.D,
    levels: resolvedConfig.levels,
    last_level_components: resolvedConfig.last_level_components,
  };

  const exportData = {
    export_timestamp: new Date().toISOString(),
    readme: {
      description: "HLSF Cognition Engine - Collective Database Metadata Export",
      purpose: "This export contains the complete adjacency token database and analytics. It represents the collective intelligence built through token relationship analysis.",
      usage: "This data can be imported into a server-side database to bootstrap a new deployment or shared for analysis.",
      version: "2.0"
    },
    database_stats: {
      total_tokens: metadata.totalTokens,
      total_relationships: metadata.totalRelationships,
      graph_nodes: dbStats.nodes,
      edge_types_enumerated: dbStats.edges,
      anchors: dbStats.anchors,
      min_edges_per_token: {
        count: Number.isFinite(dbStats.minEdges?.count) ? dbStats.minEdges.count : 0,
        tokens: Array.isArray(dbStats.minEdges?.tokens) ? dbStats.minEdges.tokens : [],
      },
      max_edges_per_token: {
        count: Number.isFinite(dbStats.maxEdges?.count) ? dbStats.maxEdges.count : 0,
        tokens: Array.isArray(dbStats.maxEdges?.tokens) ? dbStats.maxEdges.tokens : [],
      },
      max_tokens_per_relationship_type: {
        count: metadata.maxRelTypeTokens?.count || 0,
        types: (metadata.maxRelTypeTokens?.types || []).map(entry => ({
          type: entry.type,
          type_display: relDisplay(entry.type),
          tokens: entry.tokens,
        })),
      },
      max_tokens_per_adjacency_matrix: {
        count: metadata.maxAdjacencyMatrixTokens?.count || 0,
        tokens: metadata.maxAdjacencyMatrixTokens?.tokens || [],
      },
      avg_attention_score: metadata.avgAttentionScore,
      estimated_value_usd: metadata.estimatedValue.toFixed(2),
      maturity_level: maturityLevel,
      session_token_count: sessionTokenCount,
      session_tokens_cached: metadata.cachedSessionTokens || 0,
      session_token_coverage_ratio: Number(coverageRatio.toFixed(3)),
      session_token_coverage_percent: coveragePercent,
      D: dimensionStats.D,
      levels: dimensionStats.levels,
      last_level_components: dimensionStats.last_level_components,
    },
    relationship_distribution: Object.fromEntries(metadata.topRelationships),
    relationship_distribution_named: Object.fromEntries(metadata.topRelationships.map(([glyph, count]) => [relDisplay(glyph), count])),
    hub_concepts: Object.fromEntries(metadata.topTokens),
    high_attention_tokens: metadata.highAttentionTokens.map(t => ({
      token: t.token,
      attention_score: t.attention_score,
      total_relationships: t.total_relationships
    })),
    knowledge_graph_metrics: {
      network_density: (metadata.totalRelationships / Math.max(metadata.totalTokens, 1)).toFixed(3),
      avg_edges_per_token: (metadata.totalRelationships / Math.max(metadata.totalTokens, 1)).toFixed(2),
      tokens_per_relationship: (metadata.totalTokens / Math.max(metadata.totalRelationships, 1)).toFixed(3),
      oldest_entry: metadata.oldestToken?.cached_at,
      newest_entry: metadata.newestToken?.cached_at,
      date_range_days: metadata.oldestToken && metadata.newestToken ?
        Math.ceil((new Date(metadata.newestToken.cached_at) - new Date(metadata.oldestToken.cached_at)) / (1000 * 60 * 60 * 24)) : 0
    },
    full_token_data: metadata.rawData,
    user_prompts: promptsForExport,
    session_tokens: sessionTokens,
    token_order: tokenOrderSnapshot,
    conversation_log: conversationSnapshot,
    local_memory: localMemorySnapshot,
    voice_profile: voiceProfileSnapshot,
    voice_store: voiceStoreSnapshot,
  };

  exportData.model_params = modelParams;
  if (modelParams?.total_parameters != null) {
    logStatus(`Model parameter accounting → ${modelParams.total_parameters.toLocaleString()} parameters`);
  }

  try {
    const recorder = window.HLSF?.remoteDbRecorder;
    if (recorder && typeof recorder.hasData === 'function' && recorder.hasData()) {
      const remoteMetadata = typeof recorder.manifest === 'function'
        ? recorder.manifest()
        : null;
      const remoteChunks = typeof recorder.listChunks === 'function'
        ? recorder.listChunks()
        : [];
      const remoteIndex = typeof recorder.tokenIndex === 'function'
        ? recorder.tokenIndex()
        : [];
      if (remoteMetadata || (remoteChunks && remoteChunks.length)) {
        exportData.remote_db = {
          metadata: remoteMetadata,
          chunks: remoteChunks,
          token_index: remoteIndex,
        };
      }
    }
  } catch (err) {
    console.warn('Remote DB export snapshot failed:', err);
  }

  const serialized = JSON.stringify(exportData, null, 2);
  const originalSizeKb = (serialized.length / 1024).toFixed(1);
  const totalParamDisplay = modelParams?.total_parameters != null
    ? modelParams.total_parameters.toLocaleString()
    : '0';

  void (async () => {
    let url = null;
    try {
      const key = await ensureExportEncryptionKey();
      const { base64: compressedBase64, algorithm: compressionAlgorithm } = await compressStringToBase64(serialized);
      const { ciphertext, iv } = await encryptString(compressedBase64, key);
      const envelope = {
        format: EXPORT_PAYLOAD_FORMAT,
        version: EXPORT_PAYLOAD_VERSION,
        encryption: 'AES-256-GCM',
        compression: compressionAlgorithm,
        ciphertext,
        iv,
        metadata: {
          export_timestamp: exportData.export_timestamp,
          total_tokens: metadata.totalTokens,
          total_relationships: metadata.totalRelationships,
          model_parameters: modelParams?.total_parameters ?? null,
        },
      };

      const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `HLSF_Database_${new Date().toISOString().split('T')[0]}.hlsf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      const encryptedSizeKb = (blob.size / 1024).toFixed(1);
      logOK(`Database metadata exported securely: ${metadata.totalTokens} tokens, ${metadata.totalRelationships} relationships. Raw payload ${originalSizeKb}KB → encrypted package ${encryptedSizeKb}KB, model parameters ${totalParamDisplay}.`);
      logStatus(`Encryption key fingerprint: ${base64Preview(key)} (retain this to decrypt /import payloads).`);
      logStatus(`Compression: ${compressionAlgorithm.toUpperCase()}, Encryption: AES-256-GCM`);
    } catch (err) {
      logError(`Failed to finalize encrypted export: ${err?.message || err}`);
    } finally {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
  })();
}

async function decodeDatabaseExportPayload(rawText) {
  if (!rawText || typeof rawText !== 'string') return rawText;

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return rawText;
  }

  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed.format !== EXPORT_PAYLOAD_FORMAT) return parsed;

  if (typeof parsed.version === 'number' && Number.isFinite(parsed.version) && parsed.version > EXPORT_PAYLOAD_VERSION) {
    logWarning('Encrypted export was produced by a newer engine. Attempting import with legacy compatibility.');
  }

  if (!parsed.ciphertext || !parsed.iv) {
    throw new Error('Encrypted export payload is missing ciphertext metadata.');
  }

  const key = getStoredExportKey();
  if (!key) {
    throw new Error('Export encryption key not found. Import from the original device or restore your HLSF export key.');
  }

  let compressedBase64;
  try {
    compressedBase64 = await decryptString(parsed.ciphertext, parsed.iv, key);
  } catch (err) {
    console.warn('Encrypted export decryption failed:', err);
    throw new Error('Failed to decrypt export payload. Verify your encryption key.');
  }

  const compressionAlgorithm = typeof parsed.compression === 'string' ? parsed.compression : 'gzip';

  let jsonText;
  try {
    jsonText = await decompressBase64ToString(compressedBase64, compressionAlgorithm);
  } catch (err) {
    throw new Error(err?.message || 'Failed to decompress export payload.');
  }

  try {
    return JSON.parse(jsonText);
  } catch (err) {
    console.warn('Decrypted export JSON parse failed:', err);
    throw new Error('Decrypted export payload is corrupted.');
  }
}

async function importHLSFDBFromFile(file) {
  try {
    const txt = await file.text();
    const payload = await decodeDatabaseExportPayload(txt);
    if (payload && typeof payload === 'object') {
      await importDatabaseData(payload, 'file');
    } else {
      const count = await loadDbObject(txt);
      const db = getDb();
      if (!db) return;
      const seen = [];
      for (const rec of db.full_token_data || []) {
        safeStorageSet(TOKEN_CACHE_PREFIX + rec.token, JSON.stringify(rec));
        seen.push(rec.token);
      }
      safeStorageSet(DB_INDEX_KEY, JSON.stringify(seen));
      window.HLSF_GRAPH = null;
      updateStats();
      addLog(`📊 Import: ${seen.length} tokens (${count} normalized).`);
      updateHeaderCounts();
    }
  } catch (err) {
    logError(`Import failed: ${err?.message || err}`);
  }
}

async function importDatabaseData(data, source = 'file') {
  try {
    const normalizedCount = await loadDbObject(data);
    const db = getDb();
    if (!db) throw new Error('Failed to hydrate database');

    const totalTokens = Array.isArray(db.full_token_data)
      ? db.full_token_data.length
      : normalizedCount;

    const tokenData = Array.isArray(data.full_token_data) ? data.full_token_data : [];
    let imported = 0;
    let skipped = 0;
    let updated = 0;
    const seen = new Set();

    const concurrency = resolveDbImportConcurrency();
    const chunkSize = resolveDbImportChunkSize(tokenData.length, concurrency);

    for (let start = 0; start < tokenData.length; start += chunkSize) {
      const end = Math.min(tokenData.length, start + chunkSize);
      for (let i = start; i < end; i++) {
        const token = tokenData[i];
        if (!token?.token) continue;

        const key = getCacheKey(token.token);
        const existing = safeStorageGet(key);
        seen.add(token.token);

        if (existing) {
          const existingData = typeof existing === 'string' ? JSON.parse(existing) : existing;
          const importedDate = new Date(token.cached_at || 0);
          const existingDate = new Date(existingData?.cached_at || 0);

          if (importedDate > existingDate) {
            safeStorageSet(key, JSON.stringify(token));
            updated++;
          } else {
            skipped++;
          }
        } else {
          safeStorageSet(key, JSON.stringify(token));
          imported++;
        }
      }

      if (end < tokenData.length) {
        await yieldDbImport();
      }
    }

    if (!totalTokens) {
      safeStorageSet(DB_INDEX_KEY, JSON.stringify(Array.from(seen)));
    }
    updateStats();
    announceDatabaseReady('import-db');

    const summary = [];
    if (imported > 0) summary.push(`${imported} new tokens imported`);
    if (updated > 0) summary.push(`${updated} tokens updated`);
    if (skipped > 0) summary.push(`${skipped} existing tokens kept`);
    if (!summary.length) summary.push('no cache changes');

    if (Array.isArray(data?.session_tokens)) {
      if (!(Session.tokens instanceof Set)) {
        Session.tokens = new Set();
      } else {
        Session.tokens.clear();
      }
      for (const token of data.session_tokens) {
        if (typeof token !== 'string') continue;
        const trimmed = token.trim();
        if (!trimmed) continue;
        Session.tokens.add(trimmed);
      }
    }

    if (Array.isArray(data?.user_prompts)) {
      const promptLog = getSessionPromptLog();
      promptLog.length = 0;
      for (const record of data.user_prompts) {
        if (!record || typeof record !== 'object') continue;
        const text = typeof record.text === 'string' ? record.text : '';
        if (!text.trim()) continue;
        const entry: any = {
          text,
          timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
        };
        if (record.meta && typeof record.meta === 'object') {
          entry.meta = { ...record.meta };
        }
        promptLog.push(entry);
      }
    }

    if (data?.conversation_log) {
      restoreConversationLog(data.conversation_log);
    } else if (elements?.log instanceof HTMLElement) {
      elements.log.innerHTML = '';
    }

    if (data?.local_memory) {
      restoreLocalHlsfMemory(data.local_memory);
    } else {
      restoreLocalHlsfMemory({});
    }

    try {
      const voicePayload = data?.voice_store || data?.voice_profile;
      const voiceApi = window.CognitionEngine?.voice;
      if (voicePayload && voiceApi?.importProfile) {
        voiceApi.importProfile(voicePayload, { source: 'import', persist: true });
      } else if (voiceApi?.resetStore) {
        voiceApi.resetStore({ persist: true, notify: false });
      }
      if (voicePayload && window.Session && typeof window.Session === 'object') {
        if (data?.voice_profile) {
          window.Session.voiceProfile = data.voice_profile;
        } else if (voicePayload && typeof voicePayload === 'object') {
          window.Session.voiceProfile = voicePayload;
        }
        if (window.Session.voiceProfile && window.Session.voiceProfile.profileClone) {
          window.Session.voiceProfileClone = window.Session.voiceProfile.profileClone;
        } else if (voicePayload?.profileClone) {
          window.Session.voiceProfileClone = voicePayload.profileClone;
        } else {
          delete window.Session.voiceProfileClone;
        }
      } else if (window.Session && typeof window.Session === 'object') {
        delete window.Session.voiceProfile;
        delete window.Session.voiceProfileClone;
      }
    } catch (err) {
      console.warn('Voice profile import failed:', err);
    }

    updateStats();

    logOK(`Database imported from ${source}: ${summary.join(', ')}, normalized ${normalizedCount} tokens`);
    updateHeaderCounts();

    if (data?.database_stats) {
      addLog(`<div class="adjacency-insight">
        📊 <strong>Import Summary:</strong><br>
        • Source maturity: ${data.database_stats.maturity_level}<br>
        • Total tokens in source: ${data.database_stats.total_tokens}<br>
        • Total relationships: ${data.database_stats.total_relationships}<br>
        • Estimated value: ${data.database_stats.estimated_value_usd}
      </div>`);
    }

    return { imported, skipped, updated, seen: Array.from(seen), normalizedCount };
  } catch (err) {
    logError(`Import failed: ${err.message || err}`);
    return null;
  }
}

// ============================================
// COMMANDS
// ============================================
const COMMANDS = typeof window !== 'undefined'
  ? (window.COMMANDS = window.COMMANDS || Object.create(null))
  : Object.create(null);

function registerCommand(name, handler) {
  commandRegistry.register(name, handler);
}

async function fetchBootstrapText(href) {
  try {
    const res = await fetch(href, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    const isLocal = location.protocol === 'file:';
    const isNetworkErr = err && err.name === 'TypeError';
    if (!isLocal && !isNetworkErr) throw err;

    return await new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', href, true);
        xhr.overrideMimeType('application/json');
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 4) return;
          if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
            resolve(xhr.responseText);
          } else {
            reject(new Error(`XHR ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('XHR network error'));
        xhr.send();
      } catch (xhrErr) {
        reject(xhrErr);
      }
    });
  }
}

async function tryBootstrapDb() {
  if (window.HLSF?.remoteDb?.isReady?.()) return true;
  if (getDb()) return true;

  let href = null;
  try {
    const url = new URL(location.href);
    href = url.searchParams.get('db') || window.HLSF.config.bootstrapDbUrl;
  } catch (err) {
    console.warn('Failed to parse bootstrap URL:', err);
  }

  if (!href) return false;

  try {
    const meta = await window.HLSF.remoteDb.configure(href);
    window.HLSF.config.bootstrapDbUrl = href;
    const tokenCount = Number.isFinite(meta?.total_tokens) ? meta.total_tokens : null;
    const chunkCount = Array.isArray(meta?.chunks) ? meta.chunks.length : null;
    const parts = [];
    if (tokenCount != null) parts.push(`${tokenCount} tokens`);
    if (chunkCount != null) parts.push(`${chunkCount} chunks`);
    if (parts.length) logOK(`Remote DB ready: ${parts.join(', ')}`);
    return true;
  } catch (e) {
    const reason = e?.message || String(e) || 'Unknown error';
    logStatus(`Bootstrap DB fetch failed: ${reason}`);
    return false;
  }
}

function dbIndex() {
  const db = getDb();
  const idx = new Map();
  (db?.full_token_data || []).forEach(record => {
    if (record?.token) idx.set(record.token, record);
  });
  const remote = window.HLSF?.remoteDb;
  if (remote && typeof remote.isReady === 'function' && remote.isReady() && typeof remote.listTokens === 'function') {
    for (const token of remote.listTokens()) {
      if (!token || idx.has(token)) continue;
      idx.set(token, { token, relationships: {} });
    }
  }
  return idx;
}

function buildDbRecordIndexMap() {
  const map = new Map();
  const db = getDb();
  if (!db?.full_token_data) return map;
  for (const record of db.full_token_data) {
    if (!record || !record.token) continue;
    const token = String(record.token).trim();
    if (!token) continue;
    map.set(token.toLowerCase(), record);
  }
  return map;
}

function stageDbRecordForCache(record) {
  if (!record || !record.token) return false;
  try {
    const cacheKey = getCacheKey(record.token);
    if (isTokenCached(record.token) || memoryStorageFallback.has(cacheKey)) return true;
    const payload = JSON.stringify(Object.assign({ token: record.token }, record));
    memoryStorageFallback.set(cacheKey, payload);
    CacheBatch.record(record.token);
    knowledgeStore.markInMemory(record.token);
    void knowledgeStore.put({
      token: String(record.token).toLowerCase(),
      relationships: record.relationships,
      attention_score: record.attention_score,
      total_relationships: record.total_relationships,
    });
    return true;
  } catch (err) {
    console.warn('Failed to stage database record for cache:', err);
    return false;
  }
}

const DbLexicon = (() => {
  let cache = null;

  function buildLexicon() {
    const db = getDb();
    const idx = dbIndex();
    const tokens = Array.from(idx.keys());
    const buckets = new Map();
    for (const token of tokens) {
      const key = token.charAt(0) || '_';
      if (!buckets.has(key)) buckets.set(key, []);
      const bucket = buckets.get(key);
      if (bucket.length < 800) bucket.push(token);
    }
    return { db, idx, tokens, buckets };
  }

  function ensure() {
    const db = getDb();
    if (!db) {
      return { db: null, idx: new Map(), tokens: [], buckets: new Map() };
    }
    if (!cache || cache.db !== db) {
      cache = buildLexicon();
    }
    return cache;
  }

  function levenshtein(a, b) {
    const la = a.length;
    const lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;
    let previous = new Array(lb + 1);
    let current = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) previous[j] = j;
    for (let i = 1; i <= la; i++) {
      current[0] = i;
      const ai = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
        const deletion = previous[j] + 1;
        const insertion = current[j - 1] + 1;
        const substitution = previous[j - 1] + cost;
        current[j] = Math.min(deletion, insertion, substitution);
      }
      const temp = previous;
      previous = current;
      current = temp;
    }
    return previous[lb];
  }

  function matchCase(source, pattern) {
    if (!pattern) return source;
    if (pattern.toUpperCase() === pattern) return source.toUpperCase();
    if (pattern[0] && pattern[0] === pattern[0].toUpperCase()) {
      return source.charAt(0).toUpperCase() + source.slice(1);
    }
    return source;
  }

  function candidateList(token, lexicon) {
    if (!token) return lexicon.tokens.slice(0, 400);
    const key = token.charAt(0);
    const candidates = [];
    if (key && lexicon.buckets.has(key)) {
      candidates.push(...lexicon.buckets.get(key));
    }
    if (candidates.length < 200) {
      const fallback = lexicon.tokens.slice(0, 600);
      for (const cand of fallback) {
        if (!candidates.includes(cand)) candidates.push(cand);
        if (candidates.length >= 600) break;
      }
    }
    return candidates;
  }

  function findClosest(token, lexicon) {
    if (!token) return null;
    const candidates = candidateList(token, lexicon);
    let best = null;
    let bestScore = Infinity;
    const maxChecks = Math.min(candidates.length, 600);
    for (let i = 0; i < maxChecks; i++) {
      const candidate = candidates[i];
      const distance = levenshtein(token, candidate);
      const normalized = distance / Math.max(1, Math.max(candidate.length, token.length));
      if (normalized < bestScore) {
        bestScore = normalized;
        best = candidate;
        if (bestScore === 0) break;
      }
    }
    if (!best || bestScore > 0.6) return null;
    return best;
  }

  function alignTokens(tokens) {
    const lex = ensure();
    if (!Array.isArray(tokens)) return [];
    return tokens.map(token => {
      const lower = (token || '').toLowerCase();
      if (lex.idx.has(lower)) return lower;
      const replacement = findClosest(lower, lex);
      return replacement || lower;
    });
  }

  function rewriteText(text) {
    const lex = ensure();
    if (!text) return '';
    return text.replace(/[\p{L}][\p{L}\p{N}'-]*/gu, (match) => {
      const lower = match.toLowerCase();
      if (lex.idx.has(lower)) return match;
      const replacement = findClosest(lower, lex);
      if (!replacement) return match;
      return matchCase(replacement, match);
    });
  }

  function padToTokenCount(text, target) {
    const baseTokens = tokenize(text);
    if (baseTokens.length >= target) return text;

    const normalized = (text || '').trim();
    if (!normalized) return text;

    const sliceSentences = (value) => {
      return value
        .split(/[\n\r]+/)
        .flatMap((line) => {
          const trimmed = line.trim();
          if (!trimmed) return [];
          if (/^[\-*•]/.test(trimmed)) {
            return [trimmed.replace(/^[\-*•]\s*/, '').trim()];
          }
          return trimmed
            .split(/(?<=[.!?])\s+/)
            .map(part => part.trim())
            .filter(Boolean);
        })
        .filter(Boolean);
    };

    const fragments = Array.from(new Set(sliceSentences(normalized)));
    if (!fragments.length) return text;

    const fragmentTokens = fragments
      .map(fragment => ({ fragment, tokens: tokenize(fragment) }))
      .filter(entry => entry.tokens.length > 0);

    if (!fragmentTokens.length) return text;

    const filler = [];
    let remaining = target - baseTokens.length;
    let idx = 0;
    const maxIterations = fragmentTokens.length * 8;
    while (remaining > 0 && idx < maxIterations) {
      const current = fragmentTokens[idx % fragmentTokens.length];
      filler.push(current.fragment);
      remaining -= current.tokens.length;
      idx += 1;
    }

    if (!filler.length) return text;

    const fillerText = filler.join(' ');
    return normalized ? `${normalized}\n\n${fillerText}` : fillerText;
  }

  function uniqueTokens(limit = 120) {
    const lex = ensure();
    return lex.tokens.slice(0, limit);
  }

  return {
    ensure,
    alignTokens,
    rewriteText,
    padToTokenCount,
    uniqueTokens,
  };
})();

function tokenWeight(token, idx) {
  const rec = idx.get(token);
  if (!rec) return 0.5;
  const relationships = Object.values(rec.relationships || {});
  const weights = [];
  for (const arr of relationships) {
    if (!Array.isArray(arr)) continue;
    for (const rel of arr) {
      const w = rel?.weight;
      if (typeof w === 'number' && Number.isFinite(w)) weights.push(w);
    }
  }
  if (!weights.length) return 0.5;
  const maxW = Math.max(...weights);
  const meanW = weights.reduce((sum, value) => sum + value, 0) / weights.length;
  return Math.max(0.01, Math.min(1.0, 0.6 * maxW + 0.4 * meanW));
}

type GlyphLedgerEntry = { token: string; w: number; t: number };
interface GlyphLedger {
  version: number;
  updated_at: number;
  glyph_map: Record<string, GlyphLedgerEntry[]>;
}

function normalizeLedger(raw: unknown): GlyphLedger {
  const base: GlyphLedger = {
    version: 1,
    updated_at: Date.now(),
    glyph_map: {},
  };

  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const maybeVersion = Number((raw as any).version);
  if (Number.isFinite(maybeVersion)) {
    base.version = maybeVersion;
  }
  const maybeUpdated = Number((raw as any).updated_at ?? (raw as any).updatedAt);
  if (Number.isFinite(maybeUpdated)) {
    base.updated_at = maybeUpdated;
  }

  const glyphMap = (raw as Record<string, any>).glyph_map
    || (raw as Record<string, any>).glyphMap
    || {};
  if (glyphMap && typeof glyphMap === 'object') {
    for (const [glyph, entries] of Object.entries(glyphMap)) {
      if (!glyph) continue;
      const list = Array.isArray(entries) ? entries : [];
      const normalizedEntries: GlyphLedgerEntry[] = [];
      for (const entry of list) {
        if (typeof entry === 'string') {
          const trimmed = entry.trim();
          if (!trimmed) continue;
          normalizedEntries.push({ token: trimmed, w: 0.5, t: Date.now() });
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        const token = typeof entry.token === 'string' ? entry.token.trim() : '';
        if (!token) continue;
        const weight = Number(entry.w ?? entry.weight ?? entry.value);
        const timestamp = Number(entry.t ?? entry.timestamp ?? Date.now());
        normalizedEntries.push({
          token,
          w: Number.isFinite(weight) ? weight : 0.5,
          t: Number.isFinite(timestamp) ? timestamp : Date.now(),
        });
      }
      if (normalizedEntries.length) {
        base.glyph_map[glyph] = normalizedEntries;
      }
    }
  }

  return base;
}

function hydrateLedgerMaps(rawLedger: unknown): GlyphLedger {
  const ledger = normalizeLedger(rawLedger);
  TokenToGlyph.clear();
  GlyphToToken.clear();
  hydrateGlyphMappingsFromLedger(ledger.glyph_map);
  if (typeof window !== 'undefined') {
    const runtime = (window.HLSF = window.HLSF || {});
    runtime.glyphMaps = {
      tokenToGlyph: new Map(TokenToGlyph),
      glyphToToken: new Map(
        Array.from(GlyphToToken.entries()).map(([glyph, tokens]) => [glyph, new Set(tokens)]),
      ),
    };
    runtime.glyphMapsSource = null;
    runtime.glyphLedgerCache = ledger;
  }
  return ledger;
}

function loadLedger(): GlyphLedger {
  if (typeof window !== 'undefined') {
    const runtime = (window.HLSF = window.HLSF || {});
    if (runtime.glyphLedgerCache && typeof runtime.glyphLedgerCache === 'object') {
      return hydrateLedgerMaps(runtime.glyphLedgerCache);
    }
  }

  const stored = safeStorageGet(GLYPH_LEDGER_STORAGE_KEY, null);
  const ledger = hydrateLedgerMaps(stored);
  if (typeof window !== 'undefined') {
    const runtime = (window.HLSF = window.HLSF || {});
    runtime.glyphLedgerCache = ledger;
  }
  return ledger;
}

function saveLedger(nextLedger: unknown): GlyphLedger {
  const ledger = hydrateLedgerMaps(nextLedger);
  try {
    const serialized = JSON.stringify(ledger);
    safeStorageSet(GLYPH_LEDGER_STORAGE_KEY, serialized);
  } catch (err) {
    console.warn('Failed to persist glyph ledger:', err);
  }
  if (typeof window !== 'undefined') {
    const runtime = (window.HLSF = window.HLSF || {});
    runtime.glyphLedgerCache = ledger;
  }
  return ledger;
}

function hashGlyphForToken(token) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return GLYPH_SET[h % GLYPH_SET.length];
}

function glyphForToken(token) {
  if (!TokenToGlyph.has(token)) {
    // Ensure existing ledger mappings are available before hashing
    if (!TokenToGlyph.size) loadLedger();
  }
  return TokenToGlyph.get(token) || hashGlyphForToken(token);
}

function ledgerAdd(ledger, glyph, token, weight) {
  if (!ledger.glyph_map[glyph]) ledger.glyph_map[glyph] = [];
  const arr = ledger.glyph_map[glyph];
  const numericWeight = Number(weight);
  const now = Date.now();
  const found = arr.find(entry => entry.token === token);
  if (found) {
    found.w = numericWeight;
    found.t = now;
  } else {
    arr.push({ token, w: numericWeight, t: now });
  }
  TokenToGlyph.set(token, glyph);
  if (!GlyphToToken.has(glyph)) GlyphToToken.set(glyph, new Set());
  GlyphToToken.get(glyph).add(token);
  return ledger;
}

function ledgerBestToken(ledger, glyph, weight) {
  const arr = Array.isArray(ledger.glyph_map[glyph]) ? ledger.glyph_map[glyph] : [];
  if (!arr.length) return null;
  let best = arr[0];
  let bestDistance = Math.abs((best?.w ?? 0) - weight);
  for (let i = 1; i < arr.length; i++) {
    const candidate = arr[i];
    const distance = Math.abs((candidate?.w ?? 0) - weight);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best?.token || null;
}

function parseGlyphFloatSequence(input) {
  const tokens = [];
  if (!input) return tokens;
  const segments = input.trim().split(/\s+/);
  for (const segment of segments) {
    if (!segment) continue;
    let cursor = 0;
    while (cursor < segment.length) {
      let glyph = null;
      for (const candidate of GLYPH_SET) {
        if (segment.startsWith(candidate, cursor)) {
          if (!glyph || candidate.length > glyph.length) glyph = candidate;
        }
      }
      if (!glyph) break;
      cursor += glyph.length;
      let nextGlyphIndex = segment.length;
      for (const candidate of GLYPH_SET) {
        const idx = segment.indexOf(candidate, cursor);
        if (idx !== -1 && idx < nextGlyphIndex) nextGlyphIndex = idx;
      }
      const numberPortion = segment.slice(cursor, nextGlyphIndex);
      cursor = nextGlyphIndex;
      let weight = parseFloat(numberPortion);
      if (!Number.isFinite(weight)) weight = 0.5;
      tokens.push({ glyph, weightStr: numberPortion, weight });
    }
  }
  return tokens;
}

function encryptTextToGlyphs(plain, options = {}) {
  const { persistUnknown = true } = options || {};
  const idx = dbIndex();
  const ledger = loadLedger();
  const words = (plain || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  const unknown = [];
  let covered = 0;
  let mutated = false;

  for (const word of words) {
    const glyph = glyphForToken(word);
    const weight = tokenWeight(word, idx);
    if (persistUnknown || idx.has(word)) {
      ledgerAdd(ledger, glyph, word, weight);
      mutated = true;
    }
    out.push(glyph + NUM_FMT(weight));
    if (idx.has(word)) covered++;
    else unknown.push(word);
  }

  if (mutated) saveLedger(ledger);
  const encrypted = out.join(GLYPH_SEP);
  const coverage = words.length ? (100 * covered / words.length).toFixed(1) : '0.0';
  return { encrypted, coverage, unknown };
}

function decryptGlyphsToText(cipher) {
  const ledger = loadLedger();
  const pairs = parseGlyphFloatSequence(cipher || '');
  const out = [];
  const unresolved = [];
  let resolved = 0;

  for (const pair of pairs) {
    const token = ledgerBestToken(ledger, pair.glyph, pair.weight);
    if (token) {
      out.push(token);
      resolved++;
    } else {
      out.push('<?>');
      unresolved.push({ glyph: pair.glyph, weight: pair.weight });
    }
  }

  const coverage = pairs.length ? (100 * resolved / pairs.length).toFixed(1) : '0.0';
  return { decrypted: out.join(' '), coverage, unresolved };
}

function cmdLedger(arg) {
  const ledger = loadLedger();
  const [sub] = (arg || '').trim().split(/\s+/);
  if (sub === 'export') {
    const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `glyph_ledger_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    return logFinal('Ledger exported.');
  }
  if (sub === 'import') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async e => {
      try {
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        const imported = JSON.parse(text);
        hydrateLedgerMaps(imported);
        saveLedger(imported);
        logFinal('Ledger imported.');
      } catch (err) {
        logError(`Ledger import failed: ${err.message}`);
      }
    };
    input.click();
    return;
  }

  const lines = [];
  const map = ledger.glyph_map || {};
  const glyphs = Object.keys(map).sort();
  for (const glyph of glyphs) {
    const arr = Array.isArray(map[glyph]) ? map[glyph] : [];
    if (!arr.length) continue;
    const latest = [...arr].sort((a, b) => (b?.t ?? 0) - (a?.t ?? 0))[0];
    const weightStr = NUM_FMT(latest?.w ?? 0);
    lines.push(`${glyph} ${weightStr} → ${latest?.token || ''}`.trim());
  }
  return logFinal(lines.length ? lines.join('\n') : 'Ledger empty.');
}

function cmdGlyph(argsStr) {
  const idx = dbIndex();
  const tokens = (argsStr || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    logError('Usage: /glyph <token1 token2 ...>');
    return;
  }
  const ledger = loadLedger();
  const outputs = [];
  for (const token of tokens) {
    const glyph = glyphForToken(token);
    const weight = tokenWeight(token, idx);
    ledgerAdd(ledger, glyph, token, weight);
    outputs.push(glyph + NUM_FMT(weight));
  }
  saveLedger(ledger);
  logFinal(outputs.join(GLYPH_SEP));
}

function cmdEncrypt(rest) {
  const text = (rest || '').trim();
  if (!text) {
    logError('Usage: /encrypt <text>');
    return;
  }
  const { encrypted, coverage } = encryptTextToGlyphs(text, { persistUnknown: true });
  logFinal(`🔐 ${encrypted}\nCoverage: ${coverage}%`);
}

function cmdDecrypt(rest) {
  const text = (rest || '').trim();
  if (!text) {
    logError('Usage: /decrypt <glyph+float sequence>');
    return;
  }
  const { decrypted, coverage } = decryptGlyphsToText(text);
  logFinal(`🔓 ${decrypted}\nCoverage: ${coverage}%`);
}

function selectVoiceTokenForPlayback(store) {
  if (!store || typeof store !== 'object') return '';
  const assignments = store.assignments && typeof store.assignments === 'object'
    ? Object.keys(store.assignments).filter(Boolean)
    : [];
  if (assignments.length) return assignments[0];
  if (Array.isArray(store.recordings) && store.recordings.length) {
    const first = store.recordings[0];
    if (first && typeof first.token === 'string' && first.token.trim()) {
      return first.token.trim();
    }
  }
  return '';
}


async function cmdSaveAvatar(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
  const requestedName = args.map(part => String(part || '')).join(' ').trim();
  if (requestedName) {
    userAvatarStore.updateProfile({ name: requestedName }, { notify: true });
  }

  let avatarState = userAvatarStore.getState();
  if (!avatarState.profile.name) {
    try {
      const inputName = typeof window.prompt === 'function'
        ? window.prompt('Name this avatar archive:', '')
        : '';
      if (inputName && inputName.trim()) {
        userAvatarStore.updateProfile({ name: inputName.trim() }, { notify: true });
        avatarState = userAvatarStore.getState();
      }
    } catch (err) {
      console.warn('Avatar naming prompt failed:', err);
    }
  }

  const avatarName = avatarState.profile.name || 'Avatar';
  let JSZipLib = null;
  try {
    JSZipLib = await ExternalLoaders.loadJsZip();
  } catch (err) {
    logError(`Avatar save failed: ${err?.message || err}`);
    return;
  }
  if (!JSZipLib || typeof JSZipLib !== 'function') {
    logError('Avatar save failed: compression library unavailable.');
    return;
  }

  const zip = new JSZipLib();
  const nowIso = new Date().toISOString();
  const conversationSnapshot = snapshotConversationLog();
  const voiceApi = window.CognitionEngine?.voice;
  const voiceStore = voiceApi?.getStore?.();
  const dbSnapshot = getDb();
  const consciousnessSnapshot = state?.symbolMetrics?.lastPipeline?.consciousness ?? null;

  const avatarFolder = zip.folder('avatar');
  if (avatarFolder) {
    avatarFolder.file('profile.json', JSON.stringify(avatarState.profile, null, 2));
    avatarFolder.file('interactions.json', JSON.stringify(avatarState.entries, null, 2));
    avatarFolder.file('metrics.json', JSON.stringify(avatarState.metrics, null, 2));
    avatarFolder.file('meta.json', JSON.stringify({
      version: '1.0',
      name: avatarName,
      savedAt: nowIso,
      conversationEntryCount: Array.isArray(conversationSnapshot?.entries) ? conversationSnapshot.entries.length : 0,
      voiceRecordingCount: Array.isArray(voiceStore?.recordings) ? voiceStore.recordings.length : 0,
    }, null, 2));
  }

  const conversationFolder = zip.folder('conversation');
  if (conversationFolder) {
    conversationFolder.file('log.json', JSON.stringify(conversationSnapshot, null, 2));
    conversationFolder.file('log.html', conversationSnapshot?.html || '');
  }

  if (voiceStore) {
    const recordingsFolder = zip.folder('voice/recordings');
    if (recordingsFolder && Array.isArray(voiceStore.recordings)) {
      voiceStore.recordings.forEach((recording, index) => {
        if (!recording || typeof recording !== 'object') return;
        const audioType = typeof recording.audioType === 'string' && recording.audioType ? recording.audioType : 'audio/webm';
        const rawAudio = stripBase64Prefix(recording.audioBase64 || '');
        if (!rawAudio) return;
        const tokenSlug = slugifyName(recording.token || `sample-${index + 1}`) || `sample-${index + 1}`;
        const ext = audioExtensionForMime(audioType);
        const fileName = `${tokenSlug}-${index + 1}.${ext}`;
        try {
          recordingsFolder.file(fileName, rawAudio, { base64: true });
          recording.file = `voice/recordings/${fileName}`;
          recording.audioBase64 = ensureDataUrl(rawAudio, audioType);
        } catch (err) {
          console.warn('Failed to attach voice recording to archive:', err);
        }
      });
    }
    zip.folder('voice')?.file('store.json', JSON.stringify(voiceStore, null, 2));
  }

  if (dbSnapshot && typeof dbSnapshot === 'object') {
    zip.folder('hlsf')?.file('database.json', JSON.stringify(dbSnapshot, null, 2));
  }
  zip.folder('hlsf')?.file('consciousness.json', JSON.stringify(consciousnessSnapshot ?? null, null, 2));

  const slug = slugifyName(avatarName) || 'avatar';
  const timestamp = nowIso.replace(/[:]/g, '-');
  const downloadName = `${slug}_${timestamp}_avatar.zip`;

  try {
    const blob = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 4000);
    logOK(`Avatar archive saved as ${sanitize(downloadName)}.`);
  } catch (err) {
    logError(`Avatar save failed: ${err?.message || err}`);
  }
}


async function cmdLoadAvatar() {
  const input = elements.avatarBundleInput;
  if (!input) {
    logError('Avatar loader unavailable.');
    return;
  }
  input.value = '';
  input.accept = '.zip,application/zip';
  input.onchange = async event => {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
      const JSZipLib = await ExternalLoaders.loadJsZip();
      if (!JSZipLib || typeof JSZipLib.loadAsync !== 'function') {
        throw new Error('Compression library unavailable');
      }
      const zip = await JSZipLib.loadAsync(file);
      const readJson = async (path, fallback = null) => {
        try {
          const entry = zip.file(path);
          if (!entry) return fallback;
          const text = await entry.async('string');
          return JSON.parse(text);
        } catch (err) {
          console.warn(`Failed to read ${path} from avatar archive:`, err);
          return fallback;
        }
      };

      const meta = await readJson('avatar/meta.json', {});
      const profile = await readJson('avatar/profile.json', {});
      const interactions = await readJson('avatar/interactions.json', []);
      const metrics = await readJson('avatar/metrics.json', null);
      const conversationSnapshot = await readJson('conversation/log.json', null);
      const voiceStore = await readJson('voice/store.json', null);
      const dbSnapshot = await readJson('hlsf/database.json', null);
      const consciousnessSnapshot = await readJson('hlsf/consciousness.json', null);

      if (Array.isArray(voiceStore?.recordings)) {
        await Promise.all(voiceStore.recordings.map(async recording => {
          if (!recording || typeof recording !== 'object') return;
          if (typeof recording.audioBase64 === 'string' && recording.audioBase64.trim()) {
            recording.audioBase64 = ensureDataUrl(recording.audioBase64, recording.audioType || 'audio/webm');
            return;
          }
          const reference = typeof recording.file === 'string' ? recording.file : null;
          if (!reference) return;
          const entry = zip.file(reference) || zip.file(reference.replace(/^\//, ''));
          if (!entry) return;
          try {
            const base64 = await entry.async('base64');
            recording.audioBase64 = ensureDataUrl(base64, recording.audioType || 'audio/webm');
          } catch (err) {
            console.warn('Failed to restore audio for recording:', err);
          }
        }));
      }

      if (voiceStore && typeof voiceStore === 'object') {
        voiceStore.metrics = voiceStore.metrics || metrics || undefined;
        const voiceApi = window.CognitionEngine?.voice;
        if (voiceApi?.replaceStore) {
          voiceApi.replaceStore(voiceStore, {
            persist: true,
            notify: true,
            reason: 'avatar-loaded',
            status: 'success',
            message: 'Voice profile restored from avatar archive.',
          });
        } else if (voiceApi?.resetStore) {
          voiceApi.resetStore({ persist: true, notify: true });
        }
        if (window.Session && typeof window.Session === 'object') {
          window.Session.voiceProfile = voiceStore;
          if (voiceStore?.profileClone) {
            window.Session.voiceProfileClone = voiceStore.profileClone;
          } else {
            delete window.Session.voiceProfileClone;
          }
        }
      }

      if (conversationSnapshot) {
        restoreConversationLog(conversationSnapshot);
      }

      const resolvedName = typeof profile?.name === 'string' && profile.name.trim()
        ? profile.name.trim()
        : (typeof meta?.name === 'string' ? meta.name : '');
      userAvatarStore.replace({
        entries: Array.isArray(interactions) ? interactions : [],
        profile: { name: resolvedName },
      }, { notify: true });

      if (dbSnapshot && typeof dbSnapshot === 'object') {
        await loadDbObject(dbSnapshot, { replace: true });
        loadGlyphMaps(getDb());
        updateStats();
        updateHeaderCounts();
      }

      if (consciousnessSnapshot && typeof consciousnessSnapshot === 'object') {
        state.symbolMetrics = state.symbolMetrics || { history: [], last: null, lastRunGraph: null, topNodes: [], lastTokens: [], lastPipeline: null };
        state.symbolMetrics.lastPipeline = state.symbolMetrics.lastPipeline || {};
        state.symbolMetrics.lastPipeline.consciousness = consciousnessSnapshot;
      }

      try {
        cmdSpin('on');
        if (window.HLSF?.currentGraph) {
          animateHLSF(window.HLSF.currentGraph, window.HLSF.currentGlyphOnly === true);
        } else {
          requestRender();
        }
      } catch (err) {
        console.warn('Failed to activate emergent rotation after avatar load:', err);
      }

      const voiceApi = window.CognitionEngine?.voice;
      let voiceAcknowledged = false;
      if (voiceApi?.getStore) {
        const storeState = voiceApi.getStore();
        const token = selectVoiceTokenForPlayback(storeState);
        if (token) {
          if (storeState?.profileSynthesis?.available && typeof voiceApi.playTts === 'function') {
            try {
              voiceApi.playTts(token);
              voiceAcknowledged = true;
            } catch (err) {
              console.warn('Synthesized playback failed:', err);
            }
          }
          if (!voiceAcknowledged && typeof voiceApi.playToken === 'function') {
            try {
              voiceApi.playToken(token);
              voiceAcknowledged = true;
            } catch (err) {
              console.warn('Voice playback failed:', err);
            }
          }
        }
      }
      if (!voiceAcknowledged && typeof window !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function') {
        try {
          const utterance = new window.SpeechSynthesisUtterance(`Avatar ${resolvedName || ''} restored.`.trim());
          window.speechSynthesis?.speak?.(utterance);
        } catch (err) {
          console.warn('Fallback speech synthesis failed:', err);
        }
      }

      logOK(`Avatar ${sanitize(resolvedName || 'archive')} loaded from ${sanitize(file.name)}.`);
    } catch (err) {
      logError(`Avatar load failed: ${err?.message || err}`);
    } finally {
      event.target.value = '';
      input.onchange = null;
    }
  };
  input.click();
}

function cmdDeleteAvatar() {
  const confirmed = window.confirm?.('Delete avatar conversation log and voice samples? This cannot be undone.');
  if (!confirmed) {
    logStatus('Avatar deletion cancelled.');
    return;
  }

  clearConversationLog({ resetBatchLog: true });
  try {
    userAvatarStore.reset({ notify: true, clearProfile: true });
  } catch (err) {
    console.warn('User avatar reset failed during deletion:', err);
  }

  try {
    const voiceApi = window.CognitionEngine?.voice;
    if (voiceApi?.replaceStore) {
      voiceApi.replaceStore({}, {
        persist: true,
        notify: true,
        reason: 'avatar-deleted',
        status: 'warning',
        message: 'Voice profile cleared.',
      });
    } else if (voiceApi?.resetStore) {
      voiceApi.resetStore({ persist: true, notify: true });
    }
  } catch (err) {
    console.warn('Voice store reset failed during avatar deletion:', err);
  }

  if (window.Session && typeof window.Session === 'object') {
    delete window.Session.voiceProfile;
    delete window.Session.voiceProfileClone;
  }

  logOK('Avatar conversation history and voice samples deleted.');
}

async function cmdImport() {
  const input = document.getElementById('db-file');
  if (!input) {
    logError('File input unavailable');
    return;
  }
  input.value = '';
  input.onchange = async e => {
    try {
      const f = e.target.files?.[0];
      if (!f) return;
      const text = await f.text();
      let payload;
      try {
        payload = await decodeDatabaseExportPayload(text);
      } catch (err) {
        logError(err?.message || String(err));
        return;
      }

      if (payload && typeof payload === 'object') {
        await importDatabaseData(payload, 'file');
      } else {
        const normalized = await loadDbObject(text, { skipVisualization: true });
        logFinal(`DB loaded. Tokens: ${normalized}`);
      }
      await handleCommand('/db');
    } catch (err) {
      logError(String(err.message || err));
    } finally {
      e.target.value = '';
      input.onchange = null;
    }
  };
  input.click();
}

async function cmdRead() {
  if (state.isProcessing) {
    logWarning('Processing already in progress');
    return;
  }
  try {
    await DocumentReaders.preload({ silent: true });
  } catch (err) {
    console.warn('Document reader preload failed:', err);
  }
  const input = elements.readFileInput;
  if (!input) {
    logError('Reader input unavailable');
    return;
  }
  const cachedSnapshot = getCachedTokenCount();
  if (Number.isFinite(cachedSnapshot)) {
    const existingBaseline = getDocumentCacheBaseline();
    const snapshotValue = Math.max(0, cachedSnapshot);
    setDocumentCacheBaseline(Math.max(existingBaseline, snapshotValue));
    updateStats();
  }
  input.value = '';
  input.onchange = async (event) => {
    try {
      const file = event.target.files?.[0];
      if (!file) {
        logWarning('No file selected');
        return;
      }
      await processDocumentFile(file);
    } finally {
      event.target.value = '';
      input.onchange = null;
    }
  };
  input.click();
}

async function cmdLoadDb(arg): Promise<boolean> {
  try {
    const href = (arg || '').trim() || window.HLSF.config.bootstrapDbUrl;
    if (!href) throw new Error('Usage: /loaddb <metadata-url>');
    const meta = await window.HLSF.remoteDb.configure(href);
    window.HLSF.config.bootstrapDbUrl = href;
    const tokenCount = Number.isFinite(meta?.total_tokens) ? meta.total_tokens : null;
    const chunkCount = Array.isArray(meta?.chunks) ? meta.chunks.length : null;
    const parts = [];
    if (tokenCount != null) parts.push(`${tokenCount} tokens`);
    if (chunkCount != null) parts.push(`${chunkCount} chunks`);
    logFinal(`Remote DB ready${parts.length ? `: ${parts.join(', ')}` : ''}.`);
    announceDatabaseReady('force');
    return true;
  } catch (e) {
    logError(`load failed: ${String(e.message || e)}`);
    return false;
  }
}

async function cmdHlsf(rawArgs) {
  if (!getDb()) {
    const ok = await tryBootstrapDb();
    if (!ok) {
      logError('No DB loaded. Use /loaddb or /import.');
      return;
    }
  }

  HlsfLoading.show('Preparing HLSF visualization…');

  const originalArgs = (rawArgs || '').trim();
  const { text: sanitizedArgs, flags } = extractHlsfFlags(originalArgs);
  const args = parseHlsfArgs(sanitizedArgs);
  const prevBatchLogging = window.HLSF.config.batchLogging;
  const prevDeferred = window.HLSF.config.deferredRender;
  const runOptions = {
    batchLogging: flags.batchLogging ?? (prevBatchLogging !== false),
    deferredRender: flags.deferredRender ?? (prevDeferred !== false),
  };
  window.HLSF.config.batchLogging = runOptions.batchLogging;
  window.HLSF.config.deferredRender = runOptions.deferredRender;

  if (flags.metricScope) {
    window.HLSF.config.metricScope = normalizeMetricScope(flags.metricScope);
  }
  if (Object.prototype.hasOwnProperty.call(flags, 'relationTypeCap')) {
    window.HLSF.config.relationTypeCap = flags.relationTypeCap === Infinity
      ? Infinity
      : clampRelationTypeCap(flags.relationTypeCap);
  }
  if (Object.prototype.hasOwnProperty.call(flags, 'edgesPerType')) {
    window.HLSF.config.edgesPerType = flags.edgesPerType === Infinity
      ? Infinity
      : clampEdgesPerType(flags.edgesPerType);
  }

  BatchLog.clear();

  const canvas = ensureHLSFCanvas();
  if (!canvas) {
    window.HLSF.config.batchLogging = prevBatchLogging;
    window.HLSF.config.deferredRender = prevDeferred;
    logError('Unable to initialize canvas for HLSF rendering.');
    HlsfLoading.hide(0);
    return;
  }

  if (runOptions.deferredRender) hideVisualizer();
  else showVisualizer();

  const loggingActive = window.HLSF.config.batchLogging !== false;
  const start = performance.now();

  const stageMessages = {
    index: { label: 'Indexing cached tokens…', detail: 'Hydrating adjacency index.' },
    anchors: { label: 'Selecting anchor tokens…', detail: 'Evaluating entry points for the graph.' },
    graph: { label: 'Assembling semantic graph…', detail: 'Expanding neighborhoods and edges.' },
    cluster: { label: 'Clustering adjacency…', detail: 'Balancing affinity across layers.' },
    layout: { label: 'Computing spatial layout…', detail: 'Solving multi-layer projection.' },
    stage: { label: 'Preparing visualization buffers…', detail: 'Uploading geometry to renderer.' },
    render: { label: 'Rendering HLSF visualization…', detail: 'Finalizing canvas output.' },
  };

  const time = async (name, fn) => {
    const phaseStart = performance.now();
    const phaseMeta = stageMessages[name];
    if (phaseMeta) {
      HlsfLoading.update(phaseMeta.label, phaseMeta.detail);
    }
    if (loggingActive) BatchLog.phase(name, 'start');
    try {
      const result = await fn();
      if (loggingActive) {
        BatchLog.phase(name, 'end', { dt: (performance.now() - phaseStart) | 0 });
      }
      return result;
    } catch (err) {
      if (loggingActive) BatchLog.phase(name, 'error', { err: String(err) });
      throw err;
    }
  };

  try {
    if (loggingActive) {
      BatchLog.phase('hlsf', 'start', {
        args: originalArgs || '',
        resolved: sanitizedArgs || '',
        flags: runOptions,
        scope: window.HLSF.config.metricScope,
      });
    }

    const index = await time('index', async () => loadOrGetIndex());
    const { anchors, idx, glyphOnly, focusTokens } = await time('anchors', async () => anchorsForMode(args, index));
    const effectiveIndex = idx || index;
    const metricScope = window.HLSF.config.metricScope || METRIC_SCOPE.RUN;
    let anchorsToUse = Array.isArray(anchors) ? [...anchors] : [];
    if (metricScope === METRIC_SCOPE.DB) {
      anchorsToUse = effectiveIndex instanceof Map ? Array.from(effectiveIndex.keys()) : anchorsToUse;
    }

    if (!Array.isArray(anchorsToUse) || !anchorsToUse.length) {
      logError('DB is empty. Use /loaddb or /import.');
      return;
    }

    let depth = Number.isFinite(args.depth) ? args.depth : getRecursionDepthSetting();
    if (Number.isFinite(flags.depth)) depth = flags.depth;
    if (metricScope === METRIC_SCOPE.DB) depth = 0;
    else depth = applyRecursionDepthSetting(depth);

    let graph = null;
    let runMetrics = { nodes: 0, edges: 0, relationships: 0, anchors: 0 };
    let layoutResult = null;

    if (metricScope === METRIC_SCOPE.RUN) {
      graph = await time('graph', async () => assembleGraphFromAnchorsLogged(anchorsToUse, depth, effectiveIndex));
      await time('cluster', async () => { applyAffinityClusters(graph, effectiveIndex); });
      layoutResult = await time('layout', async () => computeLayout(graph, effectiveIndex, { scope: window.HLSF?.config?.hlsfScope, focusTokens }));
      await time('stage', async () => prepareBuffers(graph, layoutResult, { glyphOnly: glyphOnly === true }));
      await time('render', async () => {
        showVisualizer();
        drawComposite(graph, { glyphOnly: glyphOnly === true });
        animateComposite(graph, glyphOnly === true);
      });
      runMetrics = graph?._metrics || ensureGraphMetrics(graph);
    } else {
      HlsfLoading.update('Computing database metrics…', 'Visualization skipped for DB scope.');
      HlsfLoading.progress(1, 1);
      if (loggingActive) BatchLog.phase('graph', 'skip', { scope: METRIC_SCOPE.DB });
      stopHLSFAnimation();
      hideVisualizer();
      window.HLSF.currentGraph = null;
      window.HLSF.currentGlyphOnly = false;
      runMetrics = computeDbStats(effectiveIndex);
    }

    const dbStats = metricScope === METRIC_SCOPE.RUN
      ? computeDbStats(effectiveIndex)
      : runMetrics;

    window.HLSF.metrics = Object.assign({}, window.HLSF.metrics || {}, { db: dbStats });

    const suffix = originalArgs ? ` ${originalArgs}` : '';
    const layoutInfo = layoutResult?.layout || graph?.dimensionLayout || null;
    const dimVal = layoutInfo ? layoutInfo.dimension || 0 : 0;
    const levelCount = layoutInfo ? layoutInfo.levelCount || 0 : 0;
    const lastComponents = layoutInfo ? layoutInfo.lastLevelComponents || 0 : 0;
    const scopeUsed = (layoutInfo?.scope || window.HLSF?.config?.hlsfScope || 'db').toString().toLowerCase();
    logOK(`/hlsf${suffix} → nodes ${runMetrics.nodes} / ${dbStats.nodes}, edges ${runMetrics.edges} / ${dbStats.edges}, relationships ${runMetrics.relationships} / ${dbStats.relationships}, anchors ${runMetrics.anchors} / ${dbStats.anchors} D=${dimVal}, levels=${levelCount}, last_level_components=${lastComponents}, scope=${scopeUsed}`);
    addLog(`ⓘ run / db • tokens(db) ${dbStats.tokens}`);

    if (runMetrics.relationships < runMetrics.edges) {
      addLog('⚠ run relationships < run edge-types; check dedupe or caps.');
    }
    if (window.HLSF.config.metricScope === METRIC_SCOPE.RUN && runMetrics.nodes > dbStats.tokens) {
      addLog('⚠ run nodes > db tokens; index inconsistency.');
    }

    window.HLSF.lastCommand = {
      rawArgs: originalArgs,
      resolvedArgs: sanitizedArgs,
      args,
      anchors: [...anchorsToUse],
      idx: effectiveIndex,
      glyphOnly: glyphOnly === true,
      depth,
      flags: runOptions,
      metricScope,
      focusTokens,
    };
    syncHlsfControls(document.getElementById('hlsf-canvas-container'));

    if (loggingActive) {
      BatchLog.phase('hlsf', 'end', {
        total_ms: (performance.now() - start) | 0,
        nodes: runMetrics.nodes,
        edges: runMetrics.edges,
        relationships: runMetrics.relationships,
        anchors: runMetrics.anchors,
        metric_scope: metricScope,
        db_nodes: dbStats.nodes,
        db_edges: dbStats.edges,
        db_relationships: dbStats.relationships,
        db_tokens: dbStats.tokens,
        dimension: dimVal,
        levels: levelCount,
        last_level_components: lastComponents,
        scope: scopeUsed,
      });
    }
  } finally {
    HlsfLoading.hide(400);
    window.HLSF.config.batchLogging = prevBatchLogging;
    window.HLSF.config.deferredRender = prevDeferred;
  }
}

async function runHlsfSafely(args) {
  try {
    await cmdHlsf(args);
  } catch (err) {
    if (window.HLSF?.config?.batchLogging !== false) {
      BatchLog.phase('hlsf', 'fatal', { err: String(err) });
    }
    HlsfLoading.hide(0);
    showVisualizer();
    logError(String(err?.message || err));
  }
}

async function rebuildHlsfFromLastCommand(logUpdate = false) {
  const last = window.HLSF?.lastCommand;
  if (!last || !Array.isArray(last.anchors) || !last.anchors.length) return null;
  if (last.metricScope === METRIC_SCOPE.DB) {
    if (logUpdate) {
      const suffix = last.rawArgs ? ` ${last.rawArgs}` : '';
      logStatus(`↻ /hlsf${suffix} (scope=db) → metrics-only run; nothing to rebuild.`);
    }
    return null;
  }
  try {
    let index = last.idx;
    try {
      const refreshed = await loadOrGetIndex();
      if (refreshed) {
        index = refreshed;
      }
    } catch (err) {
      if (!index) {
        console.warn('Failed to refresh HLSF index for rebuild:', err);
        return null;
      }
      console.warn('Falling back to cached HLSF index for rebuild:', err);
    }

    if (!index) return null;

    const overlay = applyConversationOverlay(index);
    index = overlay.index instanceof Map ? overlay.index : index;
    const focusTokens = Array.isArray(overlay.focusTokens)
      ? overlay.focusTokens
      : Array.isArray(last.focusTokens)
        ? last.focusTokens
        : [];

    last.idx = index;
    last.focusTokens = focusTokens;

    const anchorCandidates = Array.isArray(last.anchors) ? last.anchors : [];
    let anchors = anchorCandidates;
    if (index instanceof Map) {
      const existing = anchorCandidates.filter(token => index.has(token));
      if (existing.length) {
        anchors = existing;
      } else if (index.size) {
        const fallback = defaultAnchors(index, getAnchorCap(index));
        if (fallback.length) anchors = fallback;
      }
    }

    if (!anchors.length) return null;

    last.anchors = anchors.slice();

    const depth = applyRecursionDepthSetting(Number.isFinite(last.depth) ? last.depth : getRecursionDepthSetting());
    last.depth = depth;
    const graph = await assembleGraphFromAnchorsLogged(anchors, depth, index, { silent: true });
    applyAffinityClusters(graph, index);
    const layout = computeLayout(graph, index, { scope: window.HLSF?.config?.hlsfScope, focusTokens });
    prepareBuffers(graph, layout, { glyphOnly: last.glyphOnly === true });
    showVisualizer();
    drawComposite(graph, { glyphOnly: last.glyphOnly === true });
    animateComposite(graph, last.glyphOnly === true);
    syncHlsfControls(document.getElementById('hlsf-canvas-container'));
    if (logUpdate) {
      const suffix = last.rawArgs ? ` ${last.rawArgs}` : '';
      const m = graph?._metrics || ensureGraphMetrics(graph);
      logStatus(`↻ /hlsf${suffix} → nodes ${m.nodes}, edges ${m.edges}, relationships ${m.relationships}, anchors ${m.anchors}`);
    }
    return graph;
  } catch (err) {
    console.warn('Failed to rebuild HLSF command:', err);
    return null;
  }
}

function cmdScheme(arg) {
  const mode = (arg || '').toLowerCase();
  window.HLSF.config.whiteBg = mode === 'white';
  if (window.HLSF.currentGraph) {
    animateHLSF(window.HLSF.currentGraph, window.HLSF.currentGlyphOnly === true);
  }
  logStatus(`Scheme: ${window.HLSF.config.whiteBg ? 'Black lines on white' : 'White lines on black'}`);
}

function cmdSpin(arg) {
  const value = (arg || '').toLowerCase();
  const enable = value ? /^(on|true|1)$/i.test(value) : true;
  window.HLSF.state = window.HLSF.state || {};
  if (!window.HLSF.state.emergent || typeof window.HLSF.state.emergent !== 'object') {
    window.HLSF.state.emergent = { on: enable, speed: window.HLSF.config.rotationOmega || 0 };
  } else {
    window.HLSF.state.emergent.on = enable;
  }
  window.HLSF.config.emergentActive = enable;
  if (window.HLSF.currentGraph && !_anim) {
    animateHLSF(window.HLSF.currentGraph, window.HLSF.currentGlyphOnly === true);
  }
  logStatus(`Emergent rotation: ${enable ? 'on' : 'off'}`);
}

function cmdOmega(arg) {
  const w = parseFloat(arg);
  if (!Number.isFinite(w)) {
    logError('Usage: /omega <rad/s>');
    return;
  }
  const clamped = Math.max(-5, Math.min(5, w));
  window.HLSF.config.rotationOmega = clamped;
  window.HLSF.state = window.HLSF.state || {};
  if (!window.HLSF.state.emergent || typeof window.HLSF.state.emergent !== 'object') {
    window.HLSF.state.emergent = { on: true, speed: clamped };
  } else {
    window.HLSF.state.emergent.speed = clamped;
  }
  const slider = document.getElementById('hlsf-rotation-speed');
  const speedVal = document.getElementById('hlsf-speed-val');
  if (slider) slider.value = clamped.toFixed(2);
  if (speedVal) speedVal.textContent = clamped.toFixed(2);
  if (window.HLSF.state.emergent.on) {
    requestRender();
  } else {
    debouncedLegacyRender();
  }
  logFinal(`Emergent rotation ω = ${clamped.toFixed(2)} rad/s`);
}

function cmdAlpha(arg) {
  const parsed = parseFloat(arg);
  if (!Number.isFinite(parsed)) {
    logError('Usage: /alpha <0.00..0.99>');
    return;
  }
  const a = clampAlpha(parsed);
  if (!Number.isFinite(a)) {
    logError('Usage: /alpha <0.00..0.99>');
    return;
  }
  window.HLSF.config.alpha = a;
  const slider = document.getElementById('hlsf-alpha');
  const alphaVal = document.getElementById('hlsf-alpha-val');
  if (slider) slider.value = a.toFixed(2);
  if (alphaVal) alphaVal.textContent = a.toFixed(2);
  debouncedLegacyRender();
  logFinal(`Alpha = ${a.toFixed(2)}`);
}

function collectActiveClusterInsights() {
  const graph = window.HLSF?.currentGraph;
  const idx = window.HLSF?.lastCommand?.idx;
  if (graph && graph.nodes instanceof Map && graph.nodes.size) {
    if (idx) applyAffinityClusters(graph, idx);
    const bucket = new Map();
    for (const [token, node] of graph.nodes) {
      if (!token || !node) continue;
      const clusterId = Number.isFinite(node.cluster) ? node.cluster : -1;
      if (!bucket.has(clusterId)) {
        bucket.set(clusterId, {
          id: clusterId,
          nodes: [],
          attentionSum: 0,
          layers: new Set(),
        });
      }
      const entry = bucket.get(clusterId);
      const layerVal = Number.isFinite(node.layer) ? node.layer : null;
      if (Number.isFinite(layerVal)) entry.layers.add(layerVal);
      const candidates = [node.attention, node.f, node.degree];
      let attention = 0;
      for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric)) { attention = numeric; break; }
      }
      entry.nodes.push({ token: String(token), attention });
      if (Number.isFinite(attention)) entry.attentionSum += attention;
    }

    const summaries = [...bucket.values()]
      .map(entry => {
        entry.nodes.sort((a, b) => {
          const attA = Number.isFinite(a.attention) ? a.attention : -Infinity;
          const attB = Number.isFinite(b.attention) ? b.attention : -Infinity;
          if (attB !== attA) return attB - attA;
          return a.token.localeCompare(b.token);
        });
        const avgAttention = entry.nodes.length
          ? entry.attentionSum / entry.nodes.length
          : 0;
        return {
          id: entry.id,
          size: entry.nodes.length,
          avgAttention: Number.isFinite(avgAttention) ? avgAttention : 0,
          topTokens: entry.nodes.slice(0, 3).map(n => n.token),
          layerSpan: entry.layers.size || 0,
        };
      })
      .filter(entry => entry.size > 0)
      .sort((a, b) => {
        if (b.size !== a.size) return b.size - a.size;
        return b.avgAttention - a.avgAttention;
      });

    return {
      summaries,
      totalNodes: graph.nodes.size || 0,
      clusterCount: summaries.length,
      anchorCount: Array.isArray(graph.anchors) ? graph.anchors.length : 0,
    };
  }

  const fallback = buildHLSF();
  if (fallback && Array.isArray(fallback.nodes) && fallback.nodes.length) {
    const fallbackTop = fallback.nodes
      .filter(n => n && typeof n.id === 'string')
      .sort((a, b) => (Number(b.attention) || 0) - (Number(a.attention) || 0))
      .slice(0, 5)
      .map(n => n.id);

    return {
      summaries: [],
      totalNodes: fallback.nodes.length,
      clusterCount: 0,
      anchorCount: 0,
      fallbackTop,
    };
  }

  return null;
}

function resolveCachedAdjacencyEntries(limit = 0) {
  const memory = ensureLocalHlsfMemory();
  if (!memory) {
    return { record: null, entries: [] };
  }

  const candidates: LocalHlsfAdjacencySummary[] = [];
  if (memory.lastAdjacency) {
    candidates.push(memory.lastAdjacency);
  }
  if (memory.adjacencySummaries instanceof Map) {
    for (const entry of memory.adjacencySummaries.values()) {
      candidates.push(entry);
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const record = candidates[i];
    if (!record || !Array.isArray(record.summary) || !record.summary.length) continue;

    const seen = new Set();
    const entries: LocalHlsfAdjacencyTokenSummary[] = [];
    for (const summaryEntry of record.summary) {
      if (!summaryEntry || typeof summaryEntry.token !== 'string') continue;
      const token = summaryEntry.token.trim();
      if (!token || !isTokenCached(token)) continue;
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(summaryEntry);
      if (limit > 0 && entries.length >= limit) break;
    }

    if (entries.length) {
      return { record, entries };
    }
  }

  return { record: null, entries: [] };
}

function summarizeCachedAdjacency(entries: LocalHlsfAdjacencyTokenSummary[], options = {}) {
  const { neighborLimit = 4, connectionLimit = 20 } = options as {
    neighborLimit?: number;
    connectionLimit?: number;
  };

  const sortedEntries = entries.slice().sort((a, b) => {
    const attA = Number.isFinite(a.attention) ? a.attention : 0;
    const attB = Number.isFinite(b.attention) ? b.attention : 0;
    return attB - attA;
  });

  const tokenHighlights = [];
  const relationStats = new Map<string, { type: string; count: number; weight: number }>();
  const connectionStats = new Map<string, { source: string; target: string; type: string; weight: number; baseWeight: number | null }>();
  const pri = RELATIONSHIP_PRIORITIES || {};
  const neighborCap = Number.isFinite(neighborLimit) && neighborLimit > 0 ? Math.floor(neighborLimit) : 0;
  const connectionCap = Number.isFinite(connectionLimit) && connectionLimit > 0 ? Math.floor(connectionLimit) : 0;

  let totalEdges = 0;
  let totalWeighted = 0;
  let attentionSum = 0;

  for (const entry of sortedEntries) {
    if (!entry || typeof entry.token !== 'string') continue;
    const token = entry.token.trim();
    if (!token) continue;

    const score = Number.isFinite(entry.attention) ? entry.attention : 0;
    attentionSum += score;

    const neighborCandidates = collectNeighborCandidates(entry).slice(0, neighborCap);
    const neighborLabels = neighborCandidates.map(candidate => {
      const weightLabel = Number.isFinite(candidate.weight) ? candidate.weight.toFixed(2) : '0.00';
      return `${candidate.token} (${weightLabel})`;
    });
    tokenHighlights.push({ token, score, neighbors: neighborLabels });

    const relationships = entry.relationships && typeof entry.relationships === 'object'
      ? entry.relationships
      : {};

    for (const [rawType, edges] of Object.entries(relationships)) {
      const normalizedType = normRelKey(rawType) || rawType;
      const list = Array.isArray(edges) ? edges : [];
      if (!list.length) continue;

      let relationWeight = 0;
      const priority = (pri[normalizedType] ?? pri.get?.(normalizedType)) ?? 1;

      for (const edge of list) {
        if (!edge || typeof edge.token !== 'string') continue;
        const neighborToken = edge.token.trim();
        if (!neighborToken || !isTokenCached(neighborToken)) continue;
        const baseWeight = Number(edge.weight) || 0;
        relationWeight += baseWeight;
        totalWeighted += baseWeight;
        totalEdges += 1;

        const ordered = token < neighborToken ? [token, neighborToken] : [neighborToken, token];
        const key = `${ordered[0]}↔${ordered[1]}|${normalizedType}`;
        const weighted = baseWeight * priority;
        const existing = connectionStats.get(key);
        if (!existing || weighted > existing.weight) {
          connectionStats.set(key, {
            source: ordered[0],
            target: ordered[1],
            type: normalizedType,
            weight: weighted,
            baseWeight,
          });
        }
      }

      const stats = relationStats.get(normalizedType) || { type: normalizedType, count: 0, weight: 0 };
      stats.count += list.filter(edge => edge && typeof edge.token === 'string' && isTokenCached(edge.token)).length;
      stats.weight += relationWeight;
      relationStats.set(normalizedType, stats);
    }
  }

  const relationTypes = Array.from(relationStats.values())
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));

  const topConnections = connectionCap
    ? Array.from(connectionStats.values())
        .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
        .slice(0, connectionCap)
    : Array.from(connectionStats.values()).sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));

  return {
    sortedEntries,
    tokenHighlights,
    relationTypes,
    topConnections,
    totals: {
      totalTokens: entries.length,
      totalEdges,
      totalWeighted,
      attentionSum,
    },
  };
}

function buildCachedAdjacencyExcerpt(entries: LocalHlsfAdjacencyTokenSummary[], options = {}) {
  const { maxRelations = 4, maxNeighbors = 4 } = options as { maxRelations?: number; maxNeighbors?: number };
  const lines: string[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry.token !== 'string') continue;
    const token = entry.token.trim();
    if (!token) continue;

    lines.push(`Token: ${token}`);
    const relationships = entry.relationships && typeof entry.relationships === 'object'
      ? Object.entries(entry.relationships)
      : [];

    const sortedRelations = relationships
      .map(([relType, edges]) => {
        const list = Array.isArray(edges) ? edges : [];
        const weight = list.reduce((sum, edge) => sum + (Number(edge?.weight) || 0), 0);
        return { relType, edges: list, weight };
      })
      .filter(item => item.edges.length)
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
      .slice(0, Math.max(0, Number.isFinite(maxRelations) ? Math.floor(maxRelations) : 0));

    for (const relation of sortedRelations) {
      const neighbors = relation.edges
        .filter(edge => edge && typeof edge.token === 'string' && isTokenCached(edge.token))
        .slice(0, Math.max(0, Number.isFinite(maxNeighbors) ? Math.floor(maxNeighbors) : 0))
        .map(edge => `${edge.token} (${Number(edge.weight || 0).toFixed(2)})`)
        .join(', ');
      if (neighbors) {
        lines.push(`  ${relDisplay(relation.relType)} -> ${neighbors}`);
      }
    }
  }

  if (!lines.length) {
    lines.push('No cached adjacency data available.');
  }

  return lines.join('\n');
}

function buildCachedClusterInfo(entries: LocalHlsfAdjacencyTokenSummary[]) {
  const tokens = entries
    .map(entry => (entry && typeof entry.token === 'string' ? entry.token.trim() : ''))
    .filter(Boolean);

  return {
    summaries: [],
    totalNodes: tokens.length,
    clusterCount: 0,
    anchorCount: 0,
    fallbackTop: tokens.slice(0, 5),
  };
}

function gatherSelfTokenPool(clusterInfo, dbStats, limit = 18, cachedEntries: LocalHlsfAdjacencyTokenSummary[] | null = null) {
  const source = Array.isArray(cachedEntries) && cachedEntries.length
    ? cachedEntries
    : resolveCachedAdjacencyEntries(Math.max(limit * 3, 0)).entries;

  if (!Array.isArray(source) || !source.length) {
    return [];
  }

  const sorted = source.slice().sort((a, b) => {
    const attA = Number.isFinite(a.attention) ? a.attention : 0;
    const attB = Number.isFinite(b.attention) ? b.attention : 0;
    return attB - attA;
  });

  const tokenSet = new Set<string>();
  const pushToken = (value) => {
    if (typeof value !== 'string') return;
    const token = value.trim();
    if (!token || !isTokenCached(token)) return;
    const key = token.toLowerCase();
    if (tokenSet.has(key)) return;
    tokenSet.add(key);
  };

  for (const entry of sorted) {
    if (!entry || typeof entry.token !== 'string') continue;
    pushToken(entry.token);
    const neighbors = collectNeighborCandidates(entry).slice(0, 2);
    for (const neighbor of neighbors) {
      pushToken(neighbor.token);
      if (tokenSet.size >= limit) break;
    }
    if (tokenSet.size >= limit) break;
  }

  return Array.from(tokenSet)
    .slice(0, limit);
}

function craftSelfThoughtStream(options) {
  const {
    moodName,
    threshold,
    iterations,
    mentalState,
    mechanics,
    tokenPool,
    dbStats,
    clusterInfo,
  } = options || {};

  const moodLabel = typeof moodName === 'string' && moodName.trim()
    ? moodName.trim()
    : 'Adaptive clustering';
  const moodLower = moodLabel.toLowerCase();
  const focusTokens = Array.isArray(tokenPool) ? tokenPool.filter(Boolean) : [];
  const primaryFocus = focusTokens.slice(0, 6);
  const secondaryFocus = focusTokens.slice(6, 10);

  const segments: string[] = [];
  segments.push(`Deep-diving the remote-db, I settle into ${moodLower} currents calibrated to ${threshold.toFixed(2)} after ${iterations} iteration${iterations === 1 ? '' : 's'}.`);

  if (mentalState?.desc) {
    segments.push(mentalState.desc.trim());
  }

  if (mechanics) {
    const mechanicsText = mechanics.trim().replace(/\.$/, '');
    if (mechanicsText) {
      const normalized = mechanicsText.charAt(0).toLowerCase() + mechanicsText.slice(1);
      segments.push(`Mechanics surface as ${normalized} during the dive.`);
    }
  }

  if (primaryFocus.length) {
    segments.push(`Primary strata reveal ${joinWithAnd(primaryFocus)}.`);
  }

  if (secondaryFocus.length) {
    segments.push(`Secondary traces echo ${joinWithAnd(secondaryFocus)}.`);
  }

  if (!primaryFocus.length && !secondaryFocus.length) {
    segments.push('Remote adjacency remains sparse, so I sweep archival layers for signals.');
  }

  if (Number.isFinite(dbStats?.anchors) && dbStats.anchors > 0) {
    segments.push(`${dbStats.anchors} anchors mark the descent path.`);
  }

  if (Number.isFinite(clusterInfo?.clusterCount) && clusterInfo.clusterCount > 0) {
    segments.push(`${clusterInfo.clusterCount} clusters pulse within the repository frame.`);
  }

  const narrative = segments.join(' ').replace(/\s+/g, ' ').trim();
  return limitWords(narrative, 100).text;
}

function joinWithAnd(items) {
  if (!Array.isArray(items)) return '';
  const filtered = items.filter(Boolean);
  if (!filtered.length) return '';
  if (filtered.length === 1) return filtered[0];
  if (filtered.length === 2) return `${filtered[0]} and ${filtered[1]}`;
  return `${filtered.slice(0, -1).join(', ')}, and ${filtered[filtered.length - 1]}`;
}

function craftMentalStateStream(options = {}) {
  const {
    mentalState = {},
    threshold = 0.35,
    iterations = 8,
    focusTokens = [],
    tokenHighlights = [],
    relationTypes = [],
    topConnections = [],
    clusterInfo = {},
    adjacencyExcerpt = '',
    dbSummary = 'unavailable',
    computedSummary = 'unavailable',
    clusterSummaryText = '',
    tokenHighlightSummary = '',
    relationTypeSummary = '',
    requestedTokens = [],
  } = options;

  const moodName = mentalState.name || 'undefined mental state';
  const focusList = Array.isArray(focusTokens) ? focusTokens.filter(Boolean) : [];
  const requestedList = Array.isArray(requestedTokens) ? requestedTokens.filter(Boolean) : [];
  const highlightTokens = Array.isArray(tokenHighlights)
    ? tokenHighlights.map(entry => entry?.token).filter(Boolean)
    : [];

  const relationSamples = Array.isArray(relationTypes)
    ? relationTypes.slice(0, 2).map(rel => {
      const label = relDisplay(rel?.type);
      const count = Number.isFinite(rel?.count) ? rel.count : 0;
      return `${label}×${count}`;
    }).filter(Boolean)
    : [];

  const connectionSamples = Array.isArray(topConnections)
    ? topConnections.slice(0, 2).map(conn => `${conn?.source}↔${conn?.target}`).filter(Boolean)
    : [];

  const adjacencyLines = typeof adjacencyExcerpt === 'string'
    ? adjacencyExcerpt.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 2)
    : [];

  const clusterHighlights: string[] = [];
  if (Number.isFinite(clusterInfo?.clusterCount)) {
    clusterHighlights.push(`${clusterInfo.clusterCount} clusters`);
  }
  if (Number.isFinite(clusterInfo?.anchorCount)) {
    clusterHighlights.push(`${clusterInfo.anchorCount} anchors`);
  }

  const segments: string[] = [];
  segments.push(`Affinities in emergent rotation steady the ${moodName} frame at threshold ${threshold.toFixed(2)} after ${iterations} iteration${iterations === 1 ? '' : 's'}.`);

  if (mentalState.desc) {
    segments.push(mentalState.desc.trim());
  }

  if (mentalState.mechanics) {
    const mechanicsText = mentalState.mechanics.trim().replace(/\.$/, '');
    if (mechanicsText) {
      const normalized = mechanicsText.charAt(0).toLowerCase() + mechanicsText.slice(1);
      segments.push(`Mechanics circulate as ${normalized}.`);
    }
  }

  if (focusList.length) {
    segments.push(`Primary affinities: ${joinWithAnd(focusList.slice(0, 5))}.`);
  } else if (requestedList.length) {
    segments.push(`Requested affinities: ${joinWithAnd(requestedList.slice(0, 5))}.`);
  }

  if (highlightTokens.length) {
    segments.push(`Highlights gravitate toward ${joinWithAnd(highlightTokens.slice(0, 4))}.`);
  } else if (tokenHighlightSummary) {
    segments.push(`Highlight scan: ${tokenHighlightSummary.split('\n')[0]}.`);
  }

  if (relationSamples.length) {
    segments.push(`Relations balance ${joinWithAnd(relationSamples)}.`);
  } else if (relationTypeSummary) {
    segments.push(`Relation ledger notes ${relationTypeSummary.split('\n')[0]}.`);
  }

  if (connectionSamples.length) {
    segments.push(`Edges pulse through ${joinWithAnd(connectionSamples)}.`);
  }

  if (clusterHighlights.length) {
    segments.push(`Clusters report ${joinWithAnd(clusterHighlights)}.`);
  }

  if (clusterSummaryText) {
    const summaryLine = clusterSummaryText.split('\n').map(line => line.trim()).filter(Boolean)[0];
    if (summaryLine) {
      segments.push(`Cluster synopsis: ${summaryLine}.`);
    }
  }

  if (adjacencyLines.length) {
    segments.push(`Adjacency excerpt: ${joinWithAnd(adjacencyLines)}.`);
  }

  segments.push(`Cached metrics: ${dbSummary}; computed: ${computedSummary}.`);

  const narrative = segments.join(' ').replace(/\s+/g, ' ').trim();
  return limitWords(narrative, 50).text;
}

function craftMentalStateStructure(options = {}) {
  const {
    mentalState = {},
    threshold = 0.35,
    iterations = 8,
    focusTokens = [],
    tokenHighlights = [],
    relationTypes = [],
    topConnections = [],
    clusterInfo = {},
    dbSummary = 'unavailable',
    computedSummary = 'unavailable',
    clusterSummaryText = '',
    relationTypeSummary = '',
    tokenHighlightSummary = '',
    adjacencyExcerpt = '',
    requestedTokens = [],
  } = options;

  const sentences = [];
  const moodName = mentalState.name || 'Undefined mental state';
  sentences.push(`Structural reading of ${moodName}: threshold ${threshold.toFixed(2)}, iterations ${iterations}, reported stats ${dbSummary}, computed stats ${computedSummary}.`);

  const focusList = Array.isArray(focusTokens) ? focusTokens.filter(Boolean) : [];
  const requestedList = Array.isArray(requestedTokens) ? requestedTokens.filter(Boolean) : [];
  if (focusList.length || requestedList.length) {
    const segments = [];
    if (focusList.length) {
      segments.push(`Focus tokens (${focusList.length}) include ${joinWithAnd(focusList.slice(0, 10))}`);
    }
    if (requestedList.length) {
      segments.push(`Requested inputs (${requestedList.length}) cover ${joinWithAnd(requestedList.slice(0, 8))}`);
    }
    sentences.push(`${segments.join('; ')}.`);
  }

  if (Array.isArray(tokenHighlights) && tokenHighlights.length) {
    const highlightDetails = tokenHighlights.slice(0, 4).map(entry => {
      if (!entry?.token) return '';
      const score = Number.isFinite(entry?.score) ? entry.score.toFixed(3) : '0.000';
      return `${entry.token} (${score})`;
    }).filter(Boolean);
    if (highlightDetails.length) {
      sentences.push(`Top weighted highlights: ${joinWithAnd(highlightDetails)}.`);
    }
  } else if (tokenHighlightSummary) {
    sentences.push(`Highlight summary: ${tokenHighlightSummary.replace(/\n+/g, '; ')}.`);
  }

  if (Array.isArray(relationTypes) && relationTypes.length) {
    const relationDetails = relationTypes.slice(0, 4).map(rel => {
      const label = relDisplay(rel?.type);
      const count = Number.isFinite(rel?.count) ? rel.count : 0;
      const weight = Number.isFinite(rel?.weight) ? rel.weight.toFixed(3) : '0.000';
      return `${label} (${count} edges, Σ=${weight})`;
    }).filter(Boolean);
    if (relationDetails.length) {
      sentences.push(`Relation weighting emphasizes ${joinWithAnd(relationDetails)}.`);
    }
  } else if (relationTypeSummary) {
    sentences.push(`Relation summary: ${relationTypeSummary.replace(/\n+/g, '; ')}.`);
  }

  if (Array.isArray(topConnections) && topConnections.length) {
    const connectionDetails = topConnections.slice(0, 3).map(conn => {
      const label = relDisplay(conn?.type);
      const weight = Number.isFinite(conn?.weight) ? conn.weight.toFixed(3) : '0.000';
      return `${conn?.source} ↔ ${conn?.target} (${label}, ${weight})`;
    }).filter(Boolean);
    if (connectionDetails.length) {
      sentences.push(`Peak connections: ${joinWithAnd(connectionDetails)}.`);
    }
  }

  const clusterSegments = [];
  if (Number.isFinite(clusterInfo?.clusterCount)) {
    clusterSegments.push(`Clusters=${clusterInfo.clusterCount}`);
  }
  if (Number.isFinite(clusterInfo?.anchorCount)) {
    clusterSegments.push(`Anchors=${clusterInfo.anchorCount}`);
  }
  if (Number.isFinite(clusterInfo?.totalNodes)) {
    clusterSegments.push(`Nodes=${clusterInfo.totalNodes}`);
  }
  if (clusterSegments.length) {
    sentences.push(`Cluster frame: ${clusterSegments.join(', ')}.`);
  }

  if (clusterSummaryText) {
    const summaryLines = clusterSummaryText.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 2);
    if (summaryLines.length) {
      sentences.push(`Cluster detail: ${summaryLines.join('; ')}.`);
    }
  }

  if (adjacencyExcerpt) {
    const adjacencyLines = adjacencyExcerpt.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 2);
    if (adjacencyLines.length) {
      sentences.push(`Adjacency notes: ${adjacencyLines.join('; ')}.`);
    }
  }

  sentences.push('Structure synthesis prepared for export to the live adjacency graph.');

  let structureText = sentences.join(' ');

  const filler = [];
  if (Array.isArray(tokenHighlights) && tokenHighlights.length > 4) {
    const more = tokenHighlights.slice(4, 8).map(entry => entry?.token).filter(Boolean);
    if (more.length) {
      filler.push(`Additional highlight tokens: ${joinWithAnd(more)}.`);
    }
  }
  if (Array.isArray(relationTypes) && relationTypes.length > 4) {
    const moreRel = relationTypes.slice(4, 7).map(rel => relDisplay(rel?.type)).filter(Boolean);
    if (moreRel.length) {
      filler.push(`Supplementary relation modes: ${joinWithAnd(moreRel)}.`);
    }
  }
  if (!filler.length && tokenHighlightSummary) {
    filler.push(`Full highlight register: ${tokenHighlightSummary.replace(/\n+/g, '; ')}.`);
  }
  if (!filler.length && relationTypeSummary) {
    filler.push(`Full relation register: ${relationTypeSummary.replace(/\n+/g, '; ')}.`);
  }

  let fillerIdx = 0;
  while (countWords(structureText) < 90 && fillerIdx < filler.length) {
    structureText = `${structureText} ${filler[fillerIdx]}`;
    fillerIdx += 1;
  }

  if (countWords(structureText) < 90) {
    structureText = `${structureText} Offline synthesis confirms stability across weighted adjacency memory.`;
  }

  const limited = limitWords(structureText, 130);
  return limited.text;
}

function parseStateTokens(args) {
  if (!Array.isArray(args)) return [];
  const tokens = [];
  for (const segment of args) {
    if (!segment) continue;
    const parts = segment.split(',');
    for (const raw of parts) {
      const cleaned = raw.trim();
      if (cleaned) tokens.push(cleaned);
    }
  }
  return tokens;
}

function selectFocusTokens(primary, secondary, idx, idxLower, limit = 8) {
  const selected = [];
  const missing = [];
  const seen = new Set();

  const pushRecord = (record) => {
    if (!record?.token) return;
    const token = String(record.token);
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(token);
  };

  const tryCandidates = (candidates, trackMissing = false) => {
    if (!Array.isArray(candidates)) return;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const normalized = String(candidate).trim();
      if (!normalized) continue;
      const lower = normalized.toLowerCase();
      const record = idx.get(normalized) || idxLower.get(lower) || null;
      if (record) {
        pushRecord(record);
      } else if (trackMissing) {
        missing.push(normalized);
      }
      if (selected.length >= limit) break;
    }
  };

  tryCandidates(primary, true);
  if (selected.length < limit) tryCandidates(secondary, false);
  if (selected.length < limit) {
    for (const record of idx.values()) {
      pushRecord(record);
      if (selected.length >= limit) break;
    }
  }

  return { tokens: selected.slice(0, limit), missing };
}

function buildAdjacencyPromptSummary(tokens, idx, idxLower, options = {}) {
  const opts = options || {};
  const maxRelations = Number.isFinite(opts.maxRelations) ? opts.maxRelations : 4;
  const maxNeighbors = Number.isFinite(opts.maxNeighbors) ? opts.maxNeighbors : 4;
  const lines = [];

  for (const token of tokens) {
    if (!token) continue;
    const normalized = String(token);
    const record = idx.get(normalized) || idxLower.get(normalized.toLowerCase());
    if (!record || !record.relationships) continue;
    lines.push(`Token: ${record.token}`);
    const relations = Object.entries(record.relationships)
      .filter(([, edges]) => Array.isArray(edges) && edges.length)
      .map(([relType, edges]) => ({
        relType,
        edges: edges.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
      }))
      .sort((a, b) => b.edges.length - a.edges.length)
      .slice(0, maxRelations);

    for (const entry of relations) {
      const neighbors = entry.edges.slice(0, maxNeighbors)
        .map(edge => `${edge.token} (${Number(edge.weight || 0).toFixed(2)})`)
        .join(', ');
      if (neighbors) {
        lines.push(`  ${relDisplay(entry.relType)} -> ${neighbors}`);
      }
    }
  }

  if (!lines.length) lines.push('No adjacency data available.');
  return lines.join('\n');
}

function formatClusterSummaryForPrompt(clusterInfo, options = {}) {
  if (!clusterInfo) return 'No active cluster summary available.';
  const limit = Number.isFinite(options.limit) ? options.limit : 5;
  const lines = [];

  if (Number.isFinite(clusterInfo.totalNodes)) {
    lines.push(`Total nodes: ${clusterInfo.totalNodes}`);
  }
  if (Number.isFinite(clusterInfo.clusterCount)) {
    lines.push(`Cluster count: ${clusterInfo.clusterCount}`);
  }
  if (Number.isFinite(clusterInfo.anchorCount)) {
    lines.push(`Anchors: ${clusterInfo.anchorCount}`);
  }

  if (Array.isArray(clusterInfo.summaries) && clusterInfo.summaries.length) {
    clusterInfo.summaries.slice(0, limit).forEach(summary => {
      const tops = Array.isArray(summary.topTokens) && summary.topTokens.length
        ? summary.topTokens.slice(0, 4).join(', ')
        : '—';
      const att = Number.isFinite(summary.avgAttention)
        ? summary.avgAttention.toFixed(3)
        : '—';
      lines.push(`Cluster ${summary.id}: size=${summary.size}, avgAttention=${att}, top=${tops}`);
    });
  } else if (Array.isArray(clusterInfo.fallbackTop) && clusterInfo.fallbackTop.length) {
    lines.push(`Fallback top tokens: ${clusterInfo.fallbackTop.slice(0, 8).join(', ')}`);
  }

  return lines.length ? lines.join('\n') : 'No active cluster summary available.';
}

function collectTopConnections(limit = 10) {
  const pri = RELATIONSHIP_PRIORITIES || {};
  const capped = Math.max(0, Number.isFinite(limit) ? limit : 0);
  if (!capped) return [];

  const aggregated = new Map();
  for (const rec of iterTokenRecords()) {
    const source = rec?.token;
    const rels = rec?.relationships;
    if (!source || !rels) continue;

    for (const rawKey of Object.keys(rels)) {
      const type = normRelKey(rawKey);
      if (!type) continue;
      const priority = (pri[type] ?? pri.get?.(type)) ?? 1;
      const edges = Array.isArray(rels[rawKey]) ? rels[rawKey] : [];
      for (const rel of edges) {
        const target = rel?.token;
        if (!target) continue;
        const baseWeight = Number(rel?.weight);
        const weighted = Number.isFinite(baseWeight) ? baseWeight * priority : priority;
        const ordered = source < target ? [source, target] : [target, source];
        const key = `${ordered[0]}↔${ordered[1]}|${type}`;
        const existing = aggregated.get(key);
        if (!existing || weighted > existing.weight) {
          aggregated.set(key, {
            source: ordered[0],
            target: ordered[1],
            type,
            weight: weighted,
            baseWeight: Number.isFinite(baseWeight) ? baseWeight : null,
          });
        }
      }
    }
  }

  return Array.from(aggregated.values())
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .slice(0, capped);
}

function formatTopConnectionsForPrompt(connections) {
  if (!Array.isArray(connections) || !connections.length) {
    return 'No connection data available.';
  }

  return connections.map((conn, idx) => {
    const rank = String(idx + 1).padStart(2, '0');
    const total = Number.isFinite(conn.weight) ? conn.weight.toFixed(3) : '—';
    const raw = Number.isFinite(conn.baseWeight) ? conn.baseWeight.toFixed(3) : '—';
    return `${rank}. ${conn.source} ↔ ${conn.target} [${relDisplay(conn.type)}] weight=${total} (raw=${raw})`;
  }).join('\n');
}

function analyzeGlobalDatabase(options = {}) {
  const tokenLimit = Number.isFinite(options.tokenLimit) ? options.tokenLimit : 16;
  const neighborLimit = Number.isFinite(options.neighborLimit) ? options.neighborLimit : 4;
  const relationLimit = Number.isFinite(options.relationLimit) ? options.relationLimit : 8;

  const highlights = [];
  const relationStats = new Map();
  let totalTokens = 0;
  let totalEdges = 0;
  let totalWeighted = 0;

  for (const rec of iterTokenRecords()) {
    if (!rec?.token) continue;
    totalTokens += 1;

    const neighborWeights = new Map();
    let tokenScore = 0;
    const relationships = rec.relationships && typeof rec.relationships === 'object'
      ? rec.relationships
      : {};

    for (const rawType of Object.keys(relationships)) {
      const edges = Array.isArray(relationships[rawType]) ? relationships[rawType] : [];
      if (!edges.length) continue;

      const normalizedType = normRelKey(rawType) || rawType;
      const priority = getRelationshipPriority(normalizedType);
      let typeWeight = 0;

      for (const rel of edges) {
        const weight = Number(rel?.weight) || 0;
        const weighted = weight * priority;
        tokenScore += weighted;
        typeWeight += weighted;
        totalWeighted += weighted;

        if (rel?.token) {
          const prev = neighborWeights.get(rel.token) || 0;
          neighborWeights.set(rel.token, prev + weighted);
        }
      }

      const stats = relationStats.get(normalizedType) || { count: 0, weight: 0 };
      stats.count += edges.length;
      stats.weight += typeWeight;
      relationStats.set(normalizedType, stats);
      totalEdges += edges.length;
    }

    const neighbors = Array.from(neighborWeights.entries())
      .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
      .slice(0, neighborLimit)
      .map(([token, score]) => `${token} (${(Number(score) || 0).toFixed(2)})`);

    highlights.push({
      token: rec.token,
      score: tokenScore,
      neighbors,
    });
  }

  highlights.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const topHighlights = highlights.slice(0, Math.max(0, tokenLimit)).map((entry, idx) => ({
    rank: idx + 1,
    token: entry.token,
    score: entry.score,
    neighbors: entry.neighbors,
  }));

  const relationSummary = Array.from(relationStats.entries())
    .map(([type, stats]) => ({
      type,
      count: stats.count,
      weight: stats.weight,
    }))
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .slice(0, Math.max(0, relationLimit));

  return {
    tokenHighlights: topHighlights,
    relationTypes: relationSummary,
    totals: {
      totalTokens,
      totalEdges,
      totalWeighted,
    },
  };
}

function formatTokenHighlightsForPrompt(highlights) {
  if (!Array.isArray(highlights) || !highlights.length) {
    return 'No token highlights available.';
  }

  return highlights.map(entry => {
    const rank = String(entry.rank).padStart(2, '0');
    const score = Number.isFinite(entry.score) ? entry.score.toFixed(3) : '0.000';
    const neighbors = Array.isArray(entry.neighbors) && entry.neighbors.length
      ? ` · neighbors: ${entry.neighbors.join(', ')}`
      : '';
    return `${rank}. ${entry.token} · weighted_attention=${score}${neighbors}`;
  }).join('\n');
}

function formatRelationTypeSummaryForPrompt(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return 'No relationship data available.';
  }

  return entries.map((entry, idx) => {
    const rank = String(idx + 1).padStart(2, '0');
    const label = relDisplay(entry.type);
    const count = Number.isFinite(entry.count) ? entry.count : 0;
    const weight = Number.isFinite(entry.weight) ? entry.weight.toFixed(3) : '0.000';
    return `${rank}. ${label} · edges=${count} · weighted_sum=${weight}`;
  }).join('\n');
}

function cmd_self() {
  const { entries } = resolveCachedAdjacencyEntries();
  if (!entries.length) {
    logError('No cached adjacency tokens available for self-reflection. Run a prompt to populate the AGI cache.');
    return;
  }

  const clusterInfo = buildCachedClusterInfo(entries);
  const dbStats = { anchors: 0 };
  const tokenPool = gatherSelfTokenPool(clusterInfo, dbStats, 18, entries);

  if (!tokenPool.length) {
    logError('Cached adjacency snapshot did not yield any tokens for self-reflection.');
    return;
  }

  const uniqueTokens = Array.from(new Set(
    tokenPool
      .map(token => (typeof token === 'string' ? token.trim() : ''))
      .filter(Boolean),
  ));
  if (!uniqueTokens.length) {
    logError('Cached adjacency snapshot did not yield any usable tokens for self-reflection.');
    return;
  }

  const safeTokens = sanitize(uniqueTokens.join('\n'));
  addLog(`<div class="section-divider"></div><div class="section-title">🪞 HLSF Self Tokens</div><pre>${safeTokens}</pre>`);
}

async function cmd_import() {
  await cmdImport();
}

async function cmd_loaddb(args) {
  const joined = Array.isArray(args) ? args.join(' ') : args;
  await cmdLoadDb(joined);
}

async function cmd_remotestats(): Promise<boolean> {
  const remote = window.HLSF?.remoteDb;
  if (!remote || typeof remote.isReady !== 'function' || !remote.isReady()) {
    logWarning('Remote database not configured. Use /loaddb or /load to connect a manifest first.');
    return false;
  }

  let metadata = null;
  try {
    metadata = typeof remote.metadata === 'function' ? remote.metadata() : null;
  } catch (err) {
    console.warn('Remote metadata access failed:', err);
  }

  if (!metadata || typeof metadata !== 'object') {
    logWarning('Remote database metadata unavailable. Try reloading with /loaddb.');
    return false;
  }

  let reposedStats: RemoteDbDirectoryStats | null = null;
  if (typeof remoteDbFileWriter?.getDirectoryStats === 'function') {
    try {
      reposedStats = await remoteDbFileWriter.getDirectoryStats();
    } catch (err) {
      console.warn('Remote directory stats unavailable:', err);
    }
  }

  const safeText = (value) => sanitize(value == null ? '' : String(value));
  const formatCount = (value) => (Number.isFinite(value) ? Number(value).toLocaleString() : '—');
  const formatDecimal = (value, digits = 1) => (Number.isFinite(value) ? Number(value).toFixed(digits) : '—');
  const formatDateTime = (value) => {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString();
    }
    return String(value);
  };
  const formatDelta = (value) => {
    if (!Number.isFinite(value) || value === 0) return '0';
    const sign = value > 0 ? '+' : '−';
    return `${sign}${Math.abs(Number(value)).toLocaleString()}`;
  };
  const describeChunk = (chunk) => {
    if (!chunk || !Number.isFinite(chunk.count)) return '—';
    return `${chunk.prefix} (${formatCount(chunk.count)} tokens)`;
  };

  const chunkEntries = Array.isArray(metadata.chunks) ? metadata.chunks : [];
  let totalChunkTokens = 0;
  let largestChunk = null;
  let smallestChunk = null;

  for (const entry of chunkEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const prefix = typeof entry.prefix === 'string' && entry.prefix ? entry.prefix : '_';
    const count = Number(entry.token_count);
    const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    totalChunkTokens += normalizedCount;
    if (!largestChunk || normalizedCount > largestChunk.count) {
      largestChunk = { prefix, count: normalizedCount };
    }
    if (!smallestChunk || normalizedCount < smallestChunk.count) {
      smallestChunk = { prefix, count: normalizedCount };
    }
  }

  const chunkCount = chunkEntries.length;
  const averageChunkSize = chunkCount > 0 ? totalChunkTokens / chunkCount : 0;
  const chunkPrefixLengthRaw = metadata.chunk_prefix_length ?? metadata.chunkPrefixLength;
  const chunkPrefixLength = Number(chunkPrefixLengthRaw);

  let tokenIndexCount = null;
  try {
    if (typeof remote.listTokens === 'function') {
      const tokens = remote.listTokens();
      if (Array.isArray(tokens)) {
        tokenIndexCount = tokens.length;
      }
    }
  } catch (err) {
    console.warn('Remote token index access failed:', err);
  }

  const declaredTokensRaw = metadata.total_tokens ?? metadata.totalTokens;
  const declaredRelationshipsRaw = metadata.total_relationships ?? metadata.totalRelationships;
  const declaredTokens = Number(declaredTokensRaw);
  const declaredRelationships = Number(declaredRelationshipsRaw);
  const derivedTokenTotal = Number.isFinite(declaredTokens) && declaredTokens > 0
    ? declaredTokens
    : (totalChunkTokens > 0 ? totalChunkTokens : null);
  const derivedRelationships = Number.isFinite(declaredRelationships) && declaredRelationships >= 0
    ? declaredRelationships
    : null;
  const averageDegree = Number.isFinite(derivedTokenTotal) && Number.isFinite(derivedRelationships) && derivedTokenTotal > 0
    ? derivedRelationships / derivedTokenTotal
    : null;
  const declaredTokenTotal = typeof derivedTokenTotal === 'number' ? derivedTokenTotal : null;
  const declaredRelationshipTotal = typeof derivedRelationships === 'number' ? derivedRelationships : null;

  const version = typeof metadata.version === 'string'
    ? metadata.version
    : (typeof metadata.db_version === 'string' ? metadata.db_version : '');
  const source = typeof metadata.source === 'string'
    ? metadata.source
    : (typeof metadata.dataset === 'string' ? metadata.dataset : '');
  const generatedAt = metadata.generated_at || metadata.generatedAt || metadata.generated;

  const remoteCacheEstimate = estimateRemoteTokenCount();
  const remoteStateParts = [];
  if (remotedir) remoteStateParts.push('auto-save ready');
  if (Number.isFinite(remoteCacheEstimate) && remoteCacheEstimate > 0) {
    remoteStateParts.push(`${remoteCacheEstimate.toLocaleString()} cached tokens detected`);
  }
  if (!remoteStateParts.length) {
    remoteStateParts.push('cache warming pending');
  }
  const cacheStatus = remoteStateParts.join('; ');

  const coverageRatio = Number.isFinite(tokenIndexCount) && Number.isFinite(derivedTokenTotal) && derivedTokenTotal > 0
    ? tokenIndexCount / derivedTokenTotal
    : null;
  const coverageDisplay = Number.isFinite(coverageRatio)
    ? `${(coverageRatio * 100).toFixed(1)}%`
    : null;

  const chunkSummary = chunkCount > 0
    ? `${formatCount(chunkCount)} chunks · avg ${formatDecimal(averageChunkSize, 1)} tokens/chunk`
    : 'No chunk manifest entries found';
  const largestChunkDisplay = largestChunk
    ? `${largestChunk.prefix} (${formatCount(largestChunk.count)} tokens)`
    : '—';
  const smallestChunkDisplay = smallestChunk
    ? `${smallestChunk.prefix} (${formatCount(smallestChunk.count)} tokens)`
    : '—';

  const reposedConnected = Boolean(reposedStats?.connected);
  const reposedTokenTotal = reposedStats?.totalTokens ?? null;
  const reposedRelationships = reposedStats?.totalRelationships ?? null;
  const reposedTokenIndexCount = reposedStats?.tokenIndexCount ?? null;
  const reposedChunkCount = reposedStats?.chunkCount ?? null;
  const reposedChunkPrefixLength = reposedStats?.chunkPrefixLength ?? null;
  const reposedGeneratedAt = reposedStats?.generatedAt ?? null;
  const reposedLargestDisplay = describeChunk(reposedStats?.largestChunk ?? null);
  const reposedSmallestDisplay = describeChunk(reposedStats?.smallestChunk ?? null);
  const reposedTokenDelta = (reposedTokenTotal != null && declaredTokenTotal != null)
    ? reposedTokenTotal - declaredTokenTotal
    : null;
  const reposedRelationshipDelta = (reposedRelationships != null && declaredRelationshipTotal != null)
    ? reposedRelationships - declaredRelationshipTotal
    : null;

  const dbStats = metadata.database_stats && typeof metadata.database_stats === 'object'
    ? metadata.database_stats
    : null;
  const estimatedValueRaw = Number(dbStats?.estimated_value_usd ?? metadata.estimated_value_usd);
  const estimatedValue = Number.isFinite(estimatedValueRaw) ? estimatedValueRaw : null;

  const manifestSummaryLines = [
    `• Manifest version: <strong>${safeText(version || '—')}</strong>`,
    `• Generated at: <strong>${safeText(formatDateTime(generatedAt))}</strong>`,
  ];
  if (source) {
    manifestSummaryLines.push(`• Source: <strong>${safeText(source)}</strong>`);
  }
  manifestSummaryLines.push(`• Auto-save directory: <strong>${safeText(remotedir ? 'Connected' : 'Not connected')}</strong>`);

  const scaleLines = [
    `• Declared tokens: <strong>${safeText(formatCount(derivedTokenTotal))}</strong>`,
    `• Declared relationships: <strong>${safeText(formatCount(derivedRelationships))}</strong>`,
    `• Token index entries: <strong>${safeText(formatCount(tokenIndexCount))}</strong>`,
    `• Average degree: <strong>${safeText(formatDecimal(averageDegree, 2))}</strong>`,
    `• Chunk prefix length: <strong>${safeText(formatCount(chunkPrefixLength))}</strong>`,
    `• Chunk manifest: <strong>${safeText(chunkSummary)}</strong>`,
    `• Largest chunk: <strong>${safeText(largestChunkDisplay)}</strong>`,
    `• Smallest chunk: <strong>${safeText(smallestChunkDisplay)}</strong>`,
  ];
  if (coverageDisplay) {
    scaleLines.push(`• Token index coverage: <strong>${safeText(coverageDisplay)}</strong>`);
  }
  scaleLines.push(`• Cache status: <strong>${safeText(cacheStatus)}</strong>`);

  const reposedLines: string[] = [];
  if (reposedConnected) {
    reposedLines.push(`• Reposed tokens: <strong>${safeText(formatCount(reposedTokenTotal))}</strong>`);
    reposedLines.push(`• Reposed relationships: <strong>${safeText(formatCount(reposedRelationships))}</strong>`);
    if (reposedTokenDelta != null) {
      reposedLines.push(`• Token delta (reposed − declared): <strong>${safeText(formatDelta(reposedTokenDelta))}</strong>`);
    }
    if (reposedRelationshipDelta != null) {
      reposedLines.push(`• Relationship delta: <strong>${safeText(formatDelta(reposedRelationshipDelta))}</strong>`);
    }
    reposedLines.push(`• Stored token index entries: <strong>${safeText(formatCount(reposedTokenIndexCount))}</strong>`);
    reposedLines.push(`• Stored chunks: <strong>${safeText(formatCount(reposedChunkCount))}</strong>`);
    reposedLines.push(`• Stored chunk prefix length: <strong>${safeText(formatCount(reposedChunkPrefixLength))}</strong>`);
    reposedLines.push(`• Largest stored chunk: <strong>${safeText(reposedLargestDisplay)}</strong>`);
    reposedLines.push(`• Smallest stored chunk: <strong>${safeText(reposedSmallestDisplay)}</strong>`);
    if (reposedGeneratedAt) {
      reposedLines.push(`• Stored manifest generated: <strong>${safeText(formatDateTime(reposedGeneratedAt))}</strong>`);
    }
  } else if (reposedStats?.error) {
    reposedLines.push(`• Reposed totals unavailable: ${safeText(reposedStats.error)}`);
  } else {
    reposedLines.push('• Reposed totals unavailable. Connect with <strong>/remotedir</strong>.');
  }

  const reposedSection = reposedLines.length
    ? `<div class="adjacency-insight">
        <strong>🏛️ Reposed Repository Totals:</strong><br>
        ${reposedLines.join('<br>')}
      </div>`
    : '';

  const dbStatsLines = [];
  if (dbStats) {
    if (typeof dbStats.maturity_level === 'string' && dbStats.maturity_level) {
      dbStatsLines.push(`• Maturity: <strong>${safeText(dbStats.maturity_level)}</strong>`);
    }
    if (Number.isFinite(dbStats.total_tokens)) {
      dbStatsLines.push(`• Source total tokens: <strong>${safeText(formatCount(dbStats.total_tokens))}</strong>`);
    }
    if (Number.isFinite(dbStats.total_relationships)) {
      dbStatsLines.push(`• Source relationships: <strong>${safeText(formatCount(dbStats.total_relationships))}</strong>`);
    }
    if (estimatedValue !== null) {
      dbStatsLines.push(`• Estimated value: <strong>${safeText(formatCurrency(estimatedValue))}</strong>`);
    }
    if (typeof dbStats.maturity_message === 'string' && dbStats.maturity_message) {
      dbStatsLines.push(`• Note: ${safeText(dbStats.maturity_message)}`);
    }
  }

  const dbStatsSection = dbStatsLines.length
    ? `<div class="adjacency-insight">
      <strong>🧭 Declared Dataset Insights:</strong><br>
      ${dbStatsLines.join('<br>')}
    </div>`
    : '';

  const manifestJson = safeText(JSON.stringify(metadata, null, 2));

  addLog(`
    <div class="section-divider"></div>
    <div class="section-title">🌐 Remote Database Statistics</div>

    <div class="adjacency-insight">
      <strong>🔌 Connection Details:</strong><br>
      ${manifestSummaryLines.join('<br>')}
    </div>

    <div class="adjacency-insight">
      <strong>📦 Scale & Topology:</strong><br>
      ${scaleLines.join('<br>')}
    </div>

    ${reposedSection}

    ${dbStatsSection}

    <details>
      <summary>🗂️ View raw manifest</summary>
      <pre>${manifestJson}</pre>
    </details>
  `);

  return true;
}

async function cmd_remotedir(): Promise<boolean> {
  const writer = remoteDbFileWriter;
  if (!writer || typeof writer.isSupported !== 'function' || !writer.isSupported()) {
    logWarning('Remote DB auto-save is unavailable in this browser. Use /export to capture updates manually.');
    setRemotedirFlag(false);
    return false;
  }
  try {
    const connected = await writer.chooseDirectory();
    if (connected) {
      setRemotedirFlag(true);
      logOK('Remote DB save directory connected. Future adjacency updates will sync automatically.');
      return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarning(`Remote DB directory selection failed: ${sanitize(message)}`);
  }
  const hasDirectory = typeof writer.hasDirectory === 'function' && writer.hasDirectory();
  setRemotedirFlag(hasDirectory);
  return hasDirectory;
}

async function cmd_load(
  args: string[] | string = [],
  options: { interactive?: boolean } = {},
): Promise<boolean> {
  const interactive = options.interactive !== false;
  const rawArgs = Array.isArray(args)
    ? args
    : typeof args === 'string'
      ? args.split(/\s+/)
      : [];
  const filtered: string[] = [];
  let requireRemotedir = false;

  for (const raw of rawArgs) {
    if (!raw) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower === '-remotedir' || lower === '--remotedir') {
      requireRemotedir = true;
      continue;
    }
    filtered.push(trimmed);
  }

  if (requireRemotedir) {
    const writer = remoteDbFileWriter;
    if (typeof writer?.hasDirectory === 'function' && writer.hasDirectory()) {
      setRemotedirFlag(true);
    }
    if (!remotedir) {
      if (interactive) {
        await cmd_remotedir();
      } else {
        logWarning('Remote DB auto-save directory not connected. Run /remotedir to select a location when ready.');
      }
    }
  }

  if (filtered.length > 0) {
    return await cmdLoadDb(filtered.join(' '));
  }

  return await tryBootstrapDb();
}

function parseHiddenSweepArgs(args = []) {
  const options = {
    minAdjacencies: 2,
    depth: null,
    edgesPerLevel: null,
    limit: null,
    concurrency: null,
  };

  const manualTokens = [];

  const setNumericOption = (key, value) => {
    if (value == null) return;
    const num = Number(value);
    if (!Number.isFinite(num)) return;
    options[key] = num;
  };

  const handleNumericFlag = (flag, key, raw, index) => {
    const lower = raw.toLowerCase();
    if (lower === flag) {
      const next = args[index + 1];
      if (next != null && !next.startsWith('--')) {
        setNumericOption(key, next);
        return { consumedNext: true, handled: true };
      }
      return { consumedNext: false, handled: true };
    }
    if (lower.startsWith(`${flag}=`)) {
      setNumericOption(key, raw.slice(flag.length + 1));
      return { consumedNext: false, handled: true };
    }
    return { consumedNext: false, handled: false };
  };

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;

    const flags = [
      { flag: '--min', key: 'minAdjacencies' },
      { flag: '--depth', key: 'depth' },
      { flag: '--edges', key: 'edgesPerLevel' },
      { flag: '--limit', key: 'limit' },
      { flag: '--concurrency', key: 'concurrency' },
    ];

    let handled = false;
    for (const { flag, key } of flags) {
      const result = handleNumericFlag(flag, key, trimmed, i);
      if (result.handled) {
        if (result.consumedNext) i += 1;
        handled = true;
        break;
      }
    }

    if (handled) continue;

    manualTokens.push(trimmed);
  }

  return { options, manualTokens };
}

async function cmd_hidden(args = []) {
  if (!enterProcessingState()) return;

  const start = performance.now();

  try {
    const { options, manualTokens } = parseHiddenSweepArgs(Array.isArray(args) ? args : []);
    const minAdjacencies = Number.isFinite(options.minAdjacencies) && options.minAdjacencies >= 0
      ? Math.floor(options.minAdjacencies)
      : 2;

    const analysis = collectHiddenAdjacencyTokens({ minAdjacencies });

    const reasonPriority = new Map([
      ['unmapped', 0],
      ['sparse', 1],
      ['manual', 2],
    ]);

    const hiddenMap = new Map();
    const ensureEntry = (token) => {
      const safeToken = (token == null ? '' : String(token)).trim();
      if (!safeToken) return null;
      const key = safeToken.toLowerCase();
      if (!hiddenMap.has(key)) {
        const stat = analysis.stats.get(key) || { adjacencyCount: 0, relationshipTypes: 0, origins: [] };
        const initialOrigins = stat.origins instanceof Set
          ? Array.from(stat.origins)
          : Array.isArray(stat.origins)
            ? stat.origins
            : [];
        hiddenMap.set(key, {
          token: safeToken,
          adjacencyCount: Number.isFinite(stat.adjacencyCount) ? stat.adjacencyCount : 0,
          relationshipTypes: Number.isFinite(stat.relationshipTypes) ? stat.relationshipTypes : 0,
          reasons: new Set(),
          sources: new Set(initialOrigins),
        });
      }
      return hiddenMap.get(key);
    };

    for (const record of analysis.unmapped) {
      const entry = ensureEntry(record.token);
      if (!entry) continue;
      entry.reasons.add('unmapped');
      if (Array.isArray(record.sources)) {
        for (const source of record.sources) {
          if (source) entry.sources.add(source);
        }
      }
    }

    for (const record of analysis.sparse) {
      const entry = ensureEntry(record.token);
      if (!entry) continue;
      entry.reasons.add('sparse');
      entry.adjacencyCount = Number.isFinite(record.adjacencyCount) ? record.adjacencyCount : entry.adjacencyCount;
      entry.relationshipTypes = Number.isFinite(record.relationshipTypes) ? record.relationshipTypes : entry.relationshipTypes;
      if (Array.isArray(record.origins)) {
        for (const origin of record.origins) {
          if (origin) entry.sources.add(origin);
        }
      }
    }

    for (const token of manualTokens) {
      const entry = ensureEntry(token);
      if (!entry) continue;
      entry.reasons.add('manual');
    }

    const entries = Array.from(hiddenMap.values());
    if (!entries.length) {
      logOK('No hidden tokens require adjacency mapping.');
      return;
    }

    entries.sort((a, b) => {
      const aPriority = Math.min(...Array.from(a.reasons).map(reason => reasonPriority.get(reason) ?? 3));
      const bPriority = Math.min(...Array.from(b.reasons).map(reason => reasonPriority.get(reason) ?? 3));
      if (aPriority !== bPriority) return aPriority - bPriority;
      if ((a.adjacencyCount || 0) !== (b.adjacencyCount || 0)) {
        return (a.adjacencyCount || 0) - (b.adjacencyCount || 0);
      }
      return a.token.localeCompare(b.token, undefined, { sensitivity: 'base' });
    });

    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : null;
    const limitedEntries = limit && entries.length > limit ? entries.slice(0, limit) : entries;
    if (limit && entries.length > limit) {
      logWarning(`Processing limited to ${limit} hidden tokens (of ${entries.length}).`);
    }

    const seeds = limitedEntries.map(entry => ({ token: entry.token, kind: 'word' }));
    const normalizedSeeds = normalizeAdjacencyInputs(seeds);

    const seedPreview = formatTokenList(seeds.map(entry => entry.token));
    const unmappedCount = analysis.unmapped.length;
    const sparseCount = analysis.sparse.length;
    const manualCount = manualTokens.length;
    const summaryParts = [
      `${unmappedCount} unmapped`,
      `${sparseCount} sparse (<${minAdjacencies})`,
    ];
    if (manualCount > 0) summaryParts.push(`${manualCount} manual`);

    addLog(`<div class="adjacency-insight">
      <strong>🕵️ Hidden token sweep:</strong> ${sanitize(summaryParts.join(' · '))}.<br>
      <em>Seeds:</em> ${sanitize(seedPreview || 'n/a')}
    </div>`);

    const contextPieces = [
      'Hidden token adjacency sweep to reveal unmapped or sparse relationship tokens.',
      `Minimum adjacency threshold: ${minAdjacencies}.`,
    ];
    if (seedPreview) {
      contextPieces.push(`Focus tokens: ${seedPreview}.`);
    }
    const context = contextPieces.join(' ');

    const depth = Number.isFinite(options.depth) && options.depth > 0
      ? Math.floor(options.depth)
      : CONFIG.ADJACENCY_RECURSION_DEPTH;
    const edgesPerLevel = Number.isFinite(options.edgesPerLevel) && options.edgesPerLevel > 0
      ? Math.floor(options.edgesPerLevel)
      : CONFIG.ADJACENCY_EDGES_PER_LEVEL;
    const concurrency = Number.isFinite(options.concurrency) && options.concurrency > 0
      ? Math.floor(options.concurrency)
      : null;

    const dbRecordIndex = buildDbRecordIndexMap();
    const preferDbHydration = window.HLSF?.remoteDb?.isReady?.() === true || dbRecordIndex.size > 0;

    const recursionResult = await fetchRecursiveAdjacencies(
      seeds,
      context,
      `hidden adjacency sweep (${seeds.length} seeds)`,
      {
        depth,
        edgesPerLevel,
        onTokenLoaded: () => queueLiveGraphUpdate(48),
        preferDb: preferDbHydration,
        dbRecordIndex,
        normalizedSeeds,
        concurrency: concurrency || undefined,
      },
    );

    const matrices = recursionResult?.matrices instanceof Map ? recursionResult.matrices : new Map();
    const stats = recursionResult?.stats || {};
    const provenance = recursionResult?.provenance || {};
    const connectivity = recursionResult?.connectivity || stats.connectivity || null;

    const resultSummary = [
      `seeds ${stats.seedCount ?? seeds.length}`,
      `visited ${stats.visitedTokens ?? matrices.size}`,
      `expansions ${stats.expansions ?? 0}`,
    ];
    if (Number.isFinite(stats.fetchCount)) resultSummary.push(`fetches ${stats.fetchCount}`);
    if (Number.isFinite(stats.apiCalls)) resultSummary.push(`API calls ${stats.apiCalls}`);

    const connectivityText = connectivity
      ? ` · connectivity ${connectivity.allSeedsConnected ? 'complete' : 'partial'} (${connectivity.componentCount || 0} component${(connectivity.componentCount || 0) === 1 ? '' : 's'})`
      : '';

    addLog(`<div class="adjacency-insight">
      <strong>🔁 Hidden sweep summary:</strong> ${sanitize(resultSummary.join(' · '))}${sanitize(connectivityText)}
    </div>`);

    const cacheSummary = formatTokenList(provenance.cacheHits);
    if (cacheSummary) {
      addLog(`<div class="adjacency-insight"><strong>📚 Cache hits:</strong> ${sanitize(cacheSummary)}</div>`);
    }

    const llmSummary = formatTokenList(provenance.llmGenerated);
    if (llmSummary) {
      addLog(`<div class="adjacency-insight"><strong>🤖 New adjacencies:</strong> ${sanitize(llmSummary)}</div>`);
    }

    if (Array.isArray(provenance.offline) && provenance.offline.length) {
      const offlineSummary = formatTokenList(provenance.offline);
      if (offlineSummary) {
        logWarning(`Offline tokens skipped: ${sanitize(offlineSummary)}`);
      }
    }

    if (Array.isArray(provenance.errors) && provenance.errors.length) {
      const errorSummary = formatTokenList(provenance.errors);
      if (errorSummary) {
        logWarning(`Tokens with errors: ${sanitize(errorSummary)}`);
      }
    }

    if (hasNewAdjacencyData(matrices)) {
      notifyHlsfAdjacencyChange('hidden-token-sweep', { immediate: true });
      queueLiveGraphUpdate(64);
    }

    const durationSec = ((performance.now() - start) / 1000).toFixed(1);
    logOK(`Hidden adjacency sweep completed in ${durationSec}s (${seeds.length} seed${seeds.length === 1 ? '' : 's'}).`);
  } catch (err) {
    logError(`Hidden adjacency sweep failed: ${err.message || err}`);
  } finally {
    exitProcessingState();
  }
}

async function cmd_state(args = []) {
  if (!enterProcessingState()) return;

  const start = performance.now();

  try {
    const manualTokens = parseStateTokens(args);

    const { entries } = resolveCachedAdjacencyEntries();
    if (!entries.length) {
      logError('No cached adjacency tokens available. Run a prompt to populate the AGI cache before using /state.');
      return;
    }

    const sortedEntries = entries.slice().sort((a, b) => {
      const attA = Number.isFinite(a.attention) ? a.attention : 0;
      const attB = Number.isFinite(b.attention) ? b.attention : 0;
      return attB - attA;
    });
    const entryMap = new Map<string, LocalHlsfAdjacencyTokenSummary>();
    for (const entry of sortedEntries) {
      if (!entry || typeof entry.token !== 'string') continue;
      const token = entry.token.trim();
      if (!token) continue;
      entryMap.set(token.toLowerCase(), entry);
    }

    const focusEntries: LocalHlsfAdjacencyTokenSummary[] = [];
    const focusSeen = new Set<string>();
    const resolvedManual: string[] = [];
    const resolvedManualSet = new Set<string>();
    const missing: string[] = [];
    const focusLimit = 20;

    const pushFocusEntry = (entry?: LocalHlsfAdjacencyTokenSummary | null) => {
      if (!entry || typeof entry.token !== 'string') return;
      const token = entry.token.trim();
      if (!token) return;
      const key = token.toLowerCase();
      if (focusSeen.has(key)) return;
      focusSeen.add(key);
      focusEntries.push(entry);
    };

    for (const rawToken of manualTokens) {
      if (!rawToken) continue;
      const normalized = String(rawToken).trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      const entry = entryMap.get(key) || null;
      if (entry) {
        pushFocusEntry(entry);
        const canonical = typeof entry.token === 'string' ? entry.token.trim() : normalized;
        const canonicalKey = canonical.toLowerCase();
        if (!resolvedManualSet.has(canonicalKey)) {
          resolvedManualSet.add(canonicalKey);
          resolvedManual.push(canonical);
        }
      } else {
        missing.push(normalized);
      }
      if (focusEntries.length >= focusLimit) break;
    }

    for (const entry of sortedEntries) {
      if (focusEntries.length >= focusLimit) break;
      pushFocusEntry(entry);
    }

    if (!focusEntries.length) {
      logError('No cached adjacency focus tokens available for /state.');
      return;
    }

    if (missing.length) {
      logWarning(`Tokens not found in cached AGI snapshot: ${missing.join(', ')}`);
    }

    const focusTokens = focusEntries
      .map(entry => (entry && typeof entry.token === 'string' ? entry.token : null))
      .filter(Boolean) as string[];
    const combinedTokens: string[] = [];
    const seen = new Set<string>();
    const pushToken = (token: string | null | undefined) => {
      if (!token) return;
      const normalized = token.trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      combinedTokens.push(normalized);
    };

    for (const token of resolvedManual) {
      pushToken(token);
    }

    for (const token of focusTokens) {
      pushToken(token);
    }

    if (!combinedTokens.length) {
      logError('No mental state tokens available to display.');
      return;
    }

    const safeTokens = sanitize(combinedTokens.join('\n'));
    addLog(`<div class="section-divider"></div><div class="section-title">🧭 Mental State Tokens</div><pre>${safeTokens}</pre>`);

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    logOK(`Mental state tokens ready (${elapsed}s)`);
  } catch (err) {
    if (err?.name === 'AbortError') {
      logWarning('Mental state walkthrough cancelled');
    } else {
      logError(err?.message || 'Mental state walkthrough failed');
      console.error(err);
    }
  } finally {
    exitProcessingState();
  }
}

function getRelationshipPriority(relType) {
  if (RELATIONSHIP_PRIORITIES instanceof Map) {
    return RELATIONSHIP_PRIORITIES.get(relType) ?? 1;
  }
  if (typeof RELATIONSHIP_PRIORITIES === 'object' && RELATIONSHIP_PRIORITIES !== null) {
    return RELATIONSHIP_PRIORITIES[relType] ?? 1;
  }
  return 1;
}

function* iterTokenRecords() {
  const db = getDb();
  if (db?.full_token_data?.length) {
    for (const rec of db.full_token_data) yield rec;
    return;
  }
  const idxRaw = safeStorageGet(DB_INDEX_KEY, []);
  const idx = Array.isArray(idxRaw) ? idxRaw : [];
  const keys = idx.length ? idx.map(t => TOKEN_CACHE_PREFIX + t)
                          : safeStorageKeys(TOKEN_CACHE_PREFIX);
  for (const k of keys) {
    const rec = safeStorageGet(k);
    if (rec) yield rec;
  }
}

function buildHLSF() {
  const pri = RELATIONSHIP_PRIORITIES || {};
  const nodes = [];
  const edges = [];
  let maxAttention = 0;

  for (const rec of iterTokenRecords()) {
    if (!rec || !rec.token || !rec.relationships) continue;
    let attention = 0;

    for (const rawKey of Object.keys(rec.relationships)) {
      const type = normRelKey(rawKey);
      const p = (pri[type] ?? pri.get?.(type)) ?? 1;
      for (const rel of rec.relationships[rawKey]) {
        const w = rel.weight ?? 0;
        attention += w * p;
        edges.push({ source: rec.token, target: rel.token, type, w });
      }
    }
    maxAttention = Math.max(maxAttention, attention);
    nodes.push({ id: rec.token, attention });
  }

  const norm = maxAttention || 1;
  for (const n of nodes) n.attention = +(n.attention / norm).toFixed(3);

  return { nodes, edges, meta: { nodeCount: nodes.length, edgeCount: edges.length } };
}

async function cmd_hlsf(arg = '') {
  const raw = typeof arg === 'string' ? arg : '';
  if (!raw.trim()) {
    const refreshed = await rebuildHlsfFromLastCommand(true);
    if (refreshed) return;
  }
  await runHlsfSafely(raw);
}

registerCommand('/self', cmd_self);
registerCommand('/state', cmd_state);
registerCommand('/import', cmd_import);
registerCommand('/read', () => cmdRead());
registerCommand('/ingest', () => cmdRead());
registerCommand('/load', cmd_load);
registerCommand('/loaddb', cmd_loaddb);
registerCommand('/remotedir', cmd_remotedir);
registerCommand('/remotestats', () => cmd_remotestats());
registerCommand('/remotedb', () => cmd_remotestats());
registerCommand('/maphidden', cmd_hidden);
registerCommand('/hidden', cmd_hidden);
registerCommand('/sv-avatar', args => cmdSaveAvatar(args));
registerCommand('/ld-avatar', () => cmdLoadAvatar());
registerCommand('/del-avatar', () => cmdDeleteAvatar());
registerCommand('/agent', args => cmdAgent(args));
window.COMMANDS = COMMANDS;
// Router guard (prevents duplicate logs)
if (!COMMANDS.__hlsf_bound) {
  COMMANDS['/hlsf'] = cmd_hlsf;
  COMMANDS.__hlsf_bound = true;
}
registerCommand('/visualize', cmd_hlsf);

registerSaasCommands(saasPlatform, {
  registerCommand,
  addLog: html => addLog(html),
  logError,
  logSuccess: message => {
    if (typeof window.logOK === 'function') {
      window.logOK(message);
    } else {
      addLog(`✅ ${sanitize(String(message))}`, 'success');
    }
  },
  sanitize,
  formatCurrency,
});

function symbolMetricsSummary() {
  const bucket = state.symbolMetrics;
  if (!bucket || !bucket.last) {
    return 'No symbol metrics recorded yet.';
  }
  const last = bucket.last;
  const density = (last.symbolDensity * 100).toFixed(1);
  const topPreview = Array.isArray(bucket.topNodes) && bucket.topNodes.length
    ? bucket.topNodes.slice(0, 3).map(node => node.token).filter(Boolean).join(', ')
    : 'none';
  const time = new Date(last.timestamp).toLocaleTimeString();
  return `Last run ${time}: words=${last.wordCount}, symbols=${last.symbolCount} (${density}% density), edges=${last.edgeCount} (${last.symbolEdgeCount} symbol edges), Δtokens=${last.deltaTokens}. Top nodes: ${topPreview}.`;
}

function cmdSymbols(args = []) {
  const [subcommand, value] = args;
  const action = (subcommand || '').toLowerCase();

  if (!action || action === 'status') {
    const summary = symbolMetricsSummary();
    addLog(`<div class="adjacency-insight"><strong>Symbol settings</strong><br>${sanitize(summary)}</div>`);
    return;
  }

  if (action === 'on') {
    SETTINGS.tokenizeSymbols = true;
    syncSettings();
    addLog('✅ Symbol tokenization enabled.');
  } else if (action === 'off') {
    SETTINGS.tokenizeSymbols = false;
    syncSettings();
    addLog('✅ Symbol tokenization disabled.');
  } else if (action === 'mode') {
    const mode = (value || '').toLowerCase();
    if (mode === 'paired' || mode === 'standalone' || mode === 'both') {
      SETTINGS.symbolEmitMode = mode;
      syncSettings();
      addLog(`✅ Symbol emit mode set to ${sanitize(mode)}.`);
    } else {
      logError('Symbol emit mode must be one of: paired, standalone, both.');
      return;
    }
  } else if (action === 'weight') {
    const weight = Number.parseFloat(value);
    if (Number.isFinite(weight) && weight >= 0 && weight <= 1) {
      SETTINGS.symbolWeightScale = weight;
      syncSettings();
      addLog(`✅ Symbol weight scale set to ${weight.toFixed(2)}.`);
    } else {
      logError('Symbol weight must be between 0 and 1.');
      return;
    }
  } else {
    logError(`Unknown /symbols action: ${sanitize(action)}`);
    return;
  }

  const summary = symbolMetricsSummary();
  addLog(`<div class="adjacency-insight"><strong>Symbol metrics</strong><br>${sanitize(summary)}</div>`);
}

function cmdAgent(args = []) {
  if (!autonomousAgent) {
    logWarning('Autonomous agent is not available.');
    return;
  }
  const action = (args[0] || '').toLowerCase();
  if (action === 'start' || action === 'on') {
    autonomousAgent.start();
    return;
  }
  if (action === 'stop' || action === 'off') {
    autonomousAgent.stop();
    return;
  }
  if (action === 'status') {
    const running = autonomousAgent.isRunning();
    addLog(`🤖 Autonomous agent is ${running ? 'active' : 'idle'}.`);
    return;
  }
  addLog('Usage: /agent start|stop|status');
}

function trackCommandExecution(
  command: string,
  args: unknown,
  source: 'dispatch' | 'handler' = 'handler',
): void {
  const argList = Array.isArray(args)
    ? args.map(item => (typeof item === 'string' ? item : String(item)))
    : typeof args === 'string' && args.trim()
      ? args.trim().split(/\s+/)
      : [];

  try {
    recordCommandUsage({
      command,
      args: argList,
      membership: getMembershipLevel(),
      source,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Failed to track command execution:', err);
  }
}

async function dispatchCommand(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return false;

  const parts = trimmed.split(/\s+/);
  const [raw, ...rest] = parts;
  const command = raw.startsWith('/') ? raw.toLowerCase() : `/${raw.toLowerCase()}`;
  const arg = rest.join(' ').trim();

  if (!ensureCommandAvailable(command)) return true;

  if (command === '/import') { trackCommandExecution(command, rest, 'dispatch'); await cmdImport(); return true; }
  if (command === '/read' || command === '/ingest') { trackCommandExecution(command, rest, 'dispatch'); await cmdRead(); return true; }
  if (command === '/loaddb') { trackCommandExecution(command, rest, 'dispatch'); await cmdLoadDb(arg); return true; }
  if (command === '/hlsf') {
    trackCommandExecution(command, rest, 'dispatch');
    if (!arg) {
      const refreshed = await rebuildHlsfFromLastCommand(true);
      if (refreshed) return true;
    }
    await runHlsfSafely(arg);
    return true;
  }
  if (command === '/scheme') { trackCommandExecution(command, rest, 'dispatch'); cmdScheme(arg || 'black'); return true; }
  if (command === '/spin') { trackCommandExecution(command, rest, 'dispatch'); cmdSpin(arg || 'on'); return true; }
  if (command === '/omega') { trackCommandExecution(command, rest, 'dispatch'); cmdOmega(arg); return true; }
  if (command === '/alpha') { trackCommandExecution(command, rest, 'dispatch'); cmdAlpha(arg); return true; }
  if (command === '/symbols') { trackCommandExecution(command, rest, 'dispatch'); cmdSymbols(rest); return true; }

  return false;
}

function isCommand(input) { return input.startsWith('/'); }

function helpCommandHtml() {
  const level = getMembershipLevel();
  const restrictions = COMMAND_RESTRICTIONS[level] || new Set();
  const intro = level === MEMBERSHIP_LEVELS.DEMO
    ? 'Demo mode active: upgrade to unlock ingestion and advanced slash commands. The /hlsf visualization remains available.'
    : 'Full membership active: all commands available.';

  const rows = COMMAND_HELP_ENTRIES.map(entry => {
    const locked = entry.requiresMembership && restrictions.has(entry.command.toLowerCase());
    const classes = ['command-entry'];
    if (locked) classes.push('command-entry--locked');
    const upgrade = locked
      ? `<a href="#" class="command-upgrade-link" data-upgrade="trial">Start trial</a>`
      : '';
    return `<div class="${classes.join(' ')}">
      <span class="command-entry__cmd">${sanitize(entry.command)}</span>
      <span class="command-entry__desc">${sanitize(entry.description)}</span>
      <span class="command-entry__cta">${upgrade}</span>
    </div>`;
  }).join('');

  return `<div class="command-list">
    <p class="command-list__intro">${sanitize(intro)}</p>
    ${rows}
  </div>`;
}

function showHelpCommand() {
  addLog(helpCommandHtml());
}

async function handleCommand(cmd) {
  const trimmed = cmd.trim();
  const handled = await safeAsync(() => dispatchCommand(trimmed), `Command dispatch failed for ${trimmed}`);
  if (handled) return;

  const segments = trimmed.slice(1).split(/\s+/);
  const [command, ...args] = segments;

  if (!command) {
    logError('Unknown command');
    return;
  }

  const normalized = `/${command.toLowerCase()}`;
  if (!ensureCommandAvailable(normalized)) return;
  const mapped = COMMANDS[normalized];
  if (mapped) {
    trackCommandExecution(normalized, args, 'handler');
    await mapped(args, trimmed);
    return;
  }

  switch (command.toLowerCase()) {
    case 'clear':
      trackCommandExecution(normalized, args, 'handler');
      clearConversationLog();
      logOK('Log cleared');
      break;
    case 'reset':
      trackCommandExecution(normalized, args, 'handler');
      if (confirm('Clear all cached data?')) {
        const keys = safeStorageKeys(TOKEN_CACHE_PREFIX);
        keys.forEach(k => safeStorageRemove(k));
        safeStorageRemove(DB_INDEX_KEY);
        const hadDbSnapshot = safeStorageGet(DB_RAW_KEY, null) != null;
        safeStorageRemove(DB_RAW_KEY);
        markHlsfDataDirty();
        CacheBatch.cancel();
        memoryStorageFallback.clear();
        if (pendingHlsfReloadTimer) {
          clearTimeout(pendingHlsfReloadTimer);
          pendingHlsfReloadTimer = null;
        }
        hlsfReloadInFlight = false;
        pendingHlsfReloadAfterFlight = false;
        lastQueuedHlsfReason = '';
        window.HLSF_GRAPH = null;
        if (window.HLSF) {
          window.HLSF.dbCache = null;
          window.HLSF.matrices = null;
          window.HLSF.metrics = {};
          window.HLSF.layoutCache = null;
          window.HLSF.indexCache = null;
          window.HLSF.indexCacheSource = null;
          window.HLSF.currentGraph = null;
          window.HLSF.currentGlyphOnly = false;
          window.HLSF.__centerInit = false;
          window.HLSF.rendering = null;
          window.HLSF.state = null;
          window.HLSF.canvas = null;
          window.HLSF.ctx = null;
          window.HLSF.view = { x: 0, y: 0, scale: 1 };
        }
        Session.tokens.clear();
        if (Array.isArray(Session.prompts)) {
          Session.prompts.length = 0;
        }
        try {
          const promptLog = getSessionPromptLog();
          promptLog.length = 0;
        } catch {
          // ignore errors clearing prompt log
        }
        try {
          const recorder = window.HLSF?.remoteDbRecorder;
          if (recorder && typeof recorder.reset === 'function') {
            recorder.reset();
          }
        } catch (err) {
          console.warn('Remote DB recorder reset failed:', err);
        }
        try {
          const remoteStore = window.HLSF?.remoteDb;
          if (remoteStore && typeof remoteStore.reset === 'function') {
            remoteStore.reset();
          }
        } catch (err) {
          console.warn('Remote DB cache reset failed:', err);
        }
        restoreLocalHlsfMemory({});
        if (state?.tokenSources instanceof Map) {
          state.tokenSources.clear();
        }
        if (Array.isArray(state?.tokenOrder)) {
          state.tokenOrder.length = 0;
        }
        if (state?.liveGraph?.nodes instanceof Map) {
          state.liveGraph.nodes.clear();
        }
        if (state?.liveGraph) {
          state.liveGraph.links = [];
        }
        if (state?.pendingPromptReviews instanceof Map) {
          state.pendingPromptReviews.clear();
        }
        if (state?.symbolMetrics && typeof state.symbolMetrics === 'object') {
          state.symbolMetrics.history = [];
          state.symbolMetrics.last = null;
          state.symbolMetrics.lastRunGraph = null;
          state.symbolMetrics.topNodes = [];
          state.symbolMetrics.lastTokens = [];
          state.symbolMetrics.lastPipeline = null;
        }
        if (state?.liveGraphUpdateTimer) {
          clearTimeout(state.liveGraphUpdateTimer);
          state.liveGraphUpdateTimer = null;
        }
        state.liveGraph = { nodes: new Map(), links: [] };
        state.hlsfReady = false;
        state.liveGraphMode = true;
        state.lastComputedCacheBase = 0;
        remoteCacheWarmPromise = null;
        remoteCacheWarmActiveKey = '';
        remoteCacheWarmCompletedKey = '';
        setDocumentCacheBaseline(0, { manual: true });
        updateStats();
        updateHeaderCounts();
        markHlsfDataDirty();
        stopHLSFAnimation();
        hideVisualizer();
        const clearedMsg = hadDbSnapshot
          ? `Cleared ${keys.length} tokens and database snapshot`
          : `Cleared ${keys.length} tokens`;
        logOK(`${clearedMsg}. Avatar voice samples and conversation history preserved.`);
      }
      break;
    case 'del-avatar':
      trackCommandExecution(normalized, args, 'handler');
      cmdDeleteAvatar();
      break;
    case 'sv-avatar':
      trackCommandExecution(normalized, args, 'handler');
      await cmdSaveAvatar(args);
      break;
    case 'ld-avatar':
      trackCommandExecution(normalized, args, 'handler');
      await cmdLoadAvatar();
      break;
    case 'stats':
      trackCommandExecution(normalized, args, 'handler');
      const { totalApiCalls, totalCacheHits, totalCostUsd } = state.sessionStats;
      const total = totalApiCalls + totalCacheHits;
      const hitRate = total > 0 ? ((totalCacheHits / total) * 100).toFixed(1) : 0;
      addLog(`<strong>Session Stats:</strong><br>
        • Requests: ${total}<br>
        • Cache hits: ${totalCacheHits} (${hitRate}%)<br>
        • API calls: ${totalApiCalls}<br>
        • Cost: ${formatCurrency(totalCostUsd)}<br>
        • Cached tokens: ${getCachedTokenCount()}`);
      break;
    case 'database':
    case 'db':
      trackCommandExecution(normalized, args, 'handler');
      showDatabaseMetadata();
      break;
    case 'remotestats':
    case 'remotedb':
      trackCommandExecution(normalized, args, 'handler');
      void cmd_remotestats();
      break;
    case 'export':
      trackCommandExecution(normalized, args, 'handler');
      exportDatabaseMetadata(args);
      break;
    case 'glyph':
      trackCommandExecution(normalized, args, 'handler');
      cmdGlyph(args.join(' '));
      break;
    case 'ledger':
      trackCommandExecution(normalized, args, 'handler');
      cmdLedger(args.join(' '));
      break;
    case 'encrypt':
      trackCommandExecution(normalized, args, 'handler');
      cmdEncrypt(args.join(' '));
      break;
    case 'decrypt':
      trackCommandExecution(normalized, args, 'handler');
      cmdDecrypt(args.join(' '));
      break;
    case 'exportledger':
      trackCommandExecution(normalized, args, 'handler');
      cmdLedger('export');
      break;
    case 'help':
      trackCommandExecution(normalized, args, 'handler');
      showHelpCommand();
      break;
    default:
      logError(`Unknown: ${command}`);
  }
}

// ============================================
// MAIN PROCESSING
// ============================================
function enterProcessingState() {
  if (state.isProcessing) return false;
  state.isProcessing = true;
  currentAbortController = new AbortController();
  if (elements.sendBtn) elements.sendBtn.disabled = true;
  if (elements.cancelBtn) elements.cancelBtn.style.display = 'inline-block';
  if (elements.input) elements.input.disabled = true;
  state.processingStart = nowMs();
  if (!state.processingStatus || typeof state.processingStatus.isActive !== 'function' || !state.processingStatus.isActive()) {
    state.processingStatus = RealtimeStatus.create('Processing request', { icon: '⚙️' });
  }
  const average = Number.isFinite(state.processingAverageMs) && state.processingAverageMs > 0
    ? state.processingAverageMs
    : 0;
  if (state.processingStatus && typeof state.processingStatus.update === 'function') {
    state.processingStatus.update({
      queueLength: 1,
      pendingWorkUnits: 1,
      activeWorkUnits: 1,
      activeStart: state.processingStart,
      averageMsPerUnit: average,
    });
  }
  return true;
}

function setupLandingExperience() {
  const landingRoot = document.getElementById('landing-screen');
  if (!landingRoot) return;

  const tabButtons = Array.from(landingRoot.querySelectorAll('.landing-tab'));
  const adminBypassLink = landingRoot.querySelector('[data-admin-bypass]');
  const forms = {
    signup: document.getElementById('landing-signup-form'),
    login: document.getElementById('landing-login-form'),
    demo: document.getElementById('landing-demo-form'),
  };
  const googleSigninButton = landingRoot.querySelector('[data-google-signin]');
  const quickSigninButton = landingRoot.querySelector('[data-quick-signin]');
  const googleProfilePreview = landingRoot.querySelector('[data-google-profile]');
  const googleSigninDefaultLabel = googleSigninButton instanceof HTMLButtonElement
    ? (googleSigninButton.textContent || 'Continue with Google').trim() || 'Continue with Google'
    : 'Continue with Google';
  let cachedGoogleProfile = null;
  let googleSignInInFlight = false;

  const paymentScreen = document.getElementById('payment-intake-screen');
  const paymentForm = paymentScreen instanceof HTMLElement
    ? paymentScreen.querySelector('#payment-intake-form')
    : null;
  const paymentBackBtn = paymentScreen instanceof HTMLElement
    ? paymentScreen.querySelector('[data-payment-action="back"]')
    : null;
  const paymentName = paymentScreen instanceof HTMLElement
    ? paymentScreen.querySelector('[data-payment-name]')
    : null;
  const paymentPlan = paymentScreen instanceof HTMLElement
    ? paymentScreen.querySelector('[data-payment-plan]')
    : null;
  const paymentTrialDays = paymentScreen instanceof HTMLElement
    ? paymentScreen.querySelector('[data-payment-trial-days]')
    : null;
  const paymentPrice = paymentScreen instanceof HTMLElement
    ? paymentScreen.querySelector('[data-payment-price]')
    : null;
  const paymentCardFields: HTMLElement[] = paymentForm instanceof HTMLFormElement
    ? Array.from(paymentForm.querySelectorAll<HTMLElement>('[data-payment-card-field]'))
    : [];
  const paymentSubmitButton = paymentForm instanceof HTMLFormElement
    ? paymentForm.querySelector<HTMLButtonElement>('[data-payment-submit]')
    : null;
  const paymentFootnote = paymentForm instanceof HTMLFormElement
    ? paymentForm.querySelector<HTMLElement>('[data-payment-footnote]')
    : null;
  const defaultPaymentSubmitLabel = paymentSubmitButton?.textContent?.trim() ?? 'Authorize & start trial';
  const defaultPaymentFootnote = paymentFootnote?.textContent?.trim()
    ?? 'You can cancel anytime before the trial ends to avoid charges.';
  const SECURE_BILLING_SUBMIT_LABEL = 'Request secure billing link';
  const SECURE_BILLING_FOOTNOTE = 'We will email a PCI-compliant checkout link. Your trial activates after secure checkout.';
  const DEFAULT_TRIAL_DAYS = Number.parseInt(paymentTrialDays?.textContent || '7', 10) || 7;
  const DEFAULT_PLAN_NAME = (paymentPlan?.textContent || 'Pro').trim();
  const DEFAULT_PRICE = (paymentPrice?.textContent || '$19.99/mo').trim();
  let pendingMembershipLevel = MEMBERSHIP_LEVELS.DEMO;
  let pendingMembershipDetails = null;

  function focusFirstInput(form) {
    if (!form) return;
    const target = form.querySelector('input, select, textarea');
    if (target instanceof HTMLElement) {
      setTimeout(() => target.focus(), 50);
    }
  }

  function setQuickSigninAvailability(enabled) {
    if (!(quickSigninButton instanceof HTMLButtonElement)) return;
    quickSigninButton.disabled = !enabled;
    quickSigninButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  function applySecureBillingMode(enabled) {
    if (!(paymentForm instanceof HTMLFormElement)) return;

    if (enabled) {
      paymentForm.dataset.secureBilling = 'true';
    } else {
      delete paymentForm.dataset.secureBilling;
    }

    for (const field of paymentCardFields) {
      if (!(field instanceof HTMLElement)) continue;
      field.classList.toggle('payment-form__field--hidden', enabled);
      field.setAttribute('aria-hidden', enabled ? 'true' : 'false');
      const inputs = Array.from(field.querySelectorAll<HTMLInputElement>('input'));
      for (const input of inputs) {
        if (!(input instanceof HTMLInputElement)) continue;
        if (enabled) {
          if (input.required) {
            input.dataset.wasRequired = 'true';
          }
          input.required = false;
          input.value = '';
        } else if (input.dataset.wasRequired === 'true') {
          input.required = true;
        }
        if (!enabled) {
          delete input.dataset.wasRequired;
        }
        input.disabled = enabled;
      }
    }

    if (paymentSubmitButton instanceof HTMLButtonElement) {
      paymentSubmitButton.textContent = enabled
        ? SECURE_BILLING_SUBMIT_LABEL
        : defaultPaymentSubmitLabel;
    }

    if (paymentFootnote instanceof HTMLElement) {
      paymentFootnote.textContent = enabled
        ? SECURE_BILLING_FOOTNOTE
        : defaultPaymentFootnote;
    }
  }

  function renderGoogleProfile(profile, options = {}) {
    if (!(googleProfilePreview instanceof HTMLElement)) return;
    const { status = null, isError = false } = options || {};
    if (status) {
      const label = sanitize(String(status));
      const classes = ['quick-signin__status'];
      if (isError) classes.push('quick-signin__status--error');
      googleProfilePreview.innerHTML = `<div class="${classes.join(' ')}">${label}</div>`;
      googleProfilePreview.classList.add('is-visible');
      return;
    }
    if (!profile) {
      googleProfilePreview.innerHTML = '';
      googleProfilePreview.classList.remove('is-visible');
      return;
    }
    const avatar = sanitize(profile.picture || '');
    const name = sanitize(profile.name || 'Google user');
    const email = sanitize(profile.email || '');
    const locale = sanitize(profile.locale || '');
    googleProfilePreview.innerHTML = `
      <img src="${avatar}" alt="Google avatar for ${name}">
      <div class="quick-signin__details">
        <span class="quick-signin__name">${name}</span>
        <span class="quick-signin__email">${email}</span>
        <span class="quick-signin__meta">Locale: ${locale || 'unknown'}</span>
      </div>
    `;
    googleProfilePreview.classList.add('is-visible');
  }

  applySecureBillingMode(Boolean(SETTINGS.secureBillingOnly));
  setQuickSigninAvailability(false);

  function setActiveView(view) {
    const activeKey = view && typeof view === 'string' ? view.toLowerCase() : 'signup';
    tabButtons.forEach(btn => {
      const match = btn.dataset.view === activeKey;
      btn.classList.toggle('is-active', match);
      btn.setAttribute('aria-selected', match ? 'true' : 'false');
    });
    Object.entries(forms).forEach(([key, form]) => {
      if (!(form instanceof HTMLElement)) return;
      form.classList.toggle('is-active', key === activeKey);
      form.setAttribute('aria-hidden', key === activeKey ? 'false' : 'true');
    });
    focusFirstInput(forms[activeKey]);
  }

  function resetPendingMembership() {
    pendingMembershipLevel = MEMBERSHIP_LEVELS.DEMO;
    pendingMembershipDetails = null;
  }

  function closePaymentIntake(options = {}) {
    const { reopenLanding = false, resetPending = true } = options || {};
    document.body.classList.remove('payment-active');
    if (paymentScreen instanceof HTMLElement) {
      paymentScreen.setAttribute('aria-hidden', 'true');
    }
    if (paymentForm instanceof HTMLFormElement) {
      paymentForm.reset();
    }
    applySecureBillingMode(Boolean(SETTINGS.secureBillingOnly));
    if (resetPending) {
      resetPendingMembership();
    }
    if (reopenLanding) {
      document.body.classList.add('onboarding-active');
      landingRoot.removeAttribute('aria-hidden');
      setActiveView('signup');
      focusFirstInput(forms.signup);
    }
  }

  function openPaymentIntake(level, details = {}) {
    pendingMembershipLevel = level;
    const baseDetails = details && typeof details === 'object' ? { ...details } : {};
    const secureMode = typeof (details as any)?.secureBilling === 'boolean'
      ? Boolean((details as any).secureBilling)
      : Boolean(SETTINGS.secureBillingOnly);
    pendingMembershipDetails = { ...baseDetails, secureBilling: secureMode };
    const viewDetails: Record<string, any> = pendingMembershipDetails || {};
    if (paymentName instanceof HTMLElement) {
      const rawLabel = viewDetails.name || viewDetails.email || 'your team';
      const label = typeof rawLabel === 'string'
        ? rawLabel.trim() || 'your team'
        : String(rawLabel || 'your team').trim() || 'your team';
      paymentName.textContent = label;
    }
    if (paymentPlan instanceof HTMLElement) {
      const rawPlan = typeof viewDetails.plan === 'string' ? viewDetails.plan.trim() : '';
      const planLabel = rawPlan
        ? `${rawPlan.charAt(0).toUpperCase()}${rawPlan.slice(1)}`
        : DEFAULT_PLAN_NAME;
      paymentPlan.textContent = planLabel;
    }
    if (paymentTrialDays instanceof HTMLElement) {
      const trialProvided = viewDetails.trialDays;
      const parsedTrial = Number.isFinite(Number(trialProvided)) ? Number(trialProvided) : DEFAULT_TRIAL_DAYS;
      const trialValue = parsedTrial > 0 ? parsedTrial : DEFAULT_TRIAL_DAYS;
      paymentTrialDays.textContent = String(trialValue);
    }
    if (paymentPrice instanceof HTMLElement) {
      paymentPrice.textContent = viewDetails.price || DEFAULT_PRICE;
    }
    if (paymentForm instanceof HTMLFormElement) {
      const cardNameInput = paymentForm.querySelector('input[name="cardName"]');
      if (cardNameInput instanceof HTMLInputElement) {
        const raw = viewDetails.name || viewDetails.email || '';
        cardNameInput.value = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
      }
    }
    applySecureBillingMode(secureMode);
    document.body.classList.add('payment-active');
    if (paymentScreen instanceof HTMLElement) {
      paymentScreen.removeAttribute('aria-hidden');
    }
    landingRoot.setAttribute('aria-hidden', 'true');
    focusFirstInput(paymentForm instanceof HTMLFormElement ? paymentForm : null);
  }

  function openLanding(view = 'signup') {
    closePaymentIntake({ resetPending: true });
    document.body.classList.add('onboarding-active');
    landingRoot.removeAttribute('aria-hidden');
    setActiveView(view);
  }

  function finalizeOnboarding(level, details = {}) {
    closePaymentIntake({ resetPending: true });
    const nextMembership = Object.assign({}, state.membership || {}, details, { level });
    if (level === MEMBERSHIP_LEVELS.MEMBER) {
      nextMembership.plan = details.plan || nextMembership.plan || 'pro';
      nextMembership.trial = true;
      nextMembership.demoMode = 'api';
    } else {
      nextMembership.trial = false;
      nextMembership.demoMode = details.demoMode === 'offline' ? 'offline' : 'api';
    }
    state.membership = nextMembership;
    state.networkOffline = level === MEMBERSHIP_LEVELS.DEMO && (nextMembership.demoMode === 'offline');
    applyMembershipUi();
    document.body.classList.remove('onboarding-active');
    landingRoot.setAttribute('aria-hidden', 'true');

    if (voiceDockController && typeof voiceDockController.focus === 'function') {
      setTimeout(() => {
        try {
          voiceDockController?.focus();
        } catch (err) {
          console.warn('Unable to focus voice model dock:', err);
        }
      }, 200);
    }

    const displayName = nextMembership.name || nextMembership.email || (level === MEMBERSHIP_LEVELS.MEMBER ? 'member' : 'demo explorer');
    if (level === MEMBERSHIP_LEVELS.MEMBER) {
      logOK(`Full membership activated for ${displayName} · Plan ${nextMembership.plan || 'pro'} with 7-day trial.`);
    } else {
      const modeLabel = nextMembership.demoMode === 'offline' ? 'offline sandbox' : 'API key + GitHub adjacency bridge';
      logStatus(`Demo mode enabled for ${displayName} (${modeLabel}). Slash commands remain disabled until upgrade.`);
    }

    if (level === MEMBERSHIP_LEVELS.DEMO && nextMembership.demoMode !== 'offline') {
      tryBootstrapDb().catch(err => console.warn('Demo bootstrap failed:', err));
    }

    if (!state.apiKey && (level === MEMBERSHIP_LEVELS.MEMBER || (level === MEMBERSHIP_LEVELS.DEMO && nextMembership.demoMode === 'api'))) {
      showApiModal();
    }

    setTimeout(() => {
      if (elements.input instanceof HTMLElement) {
        elements.input.focus();
      }
    }, 180);
  }

  if (AUTO_BYPASS_ONBOARDING) {
    finalizeOnboarding(MEMBERSHIP_LEVELS.MEMBER, AUTO_BYPASS_MEMBERSHIP_DETAILS);
    return;
  }

  if (googleSigninButton instanceof HTMLButtonElement) {
    googleSigninButton.addEventListener('click', async () => {
      if (googleSignInInFlight) return;
      googleSignInInFlight = true;
      const restoreLabel = googleSigninButton.textContent || googleSigninDefaultLabel;
      googleSigninButton.disabled = true;
      googleSigninButton.textContent = 'Contacting Google…';
      cachedGoogleProfile = null;
      setQuickSigninAvailability(false);
      renderGoogleProfile(null, { status: 'Contacting Google…' });
      try {
        const profile = await demoGoogleSignIn();
        cachedGoogleProfile = profile;
        renderGoogleProfile(profile);
        setQuickSigninAvailability(true);
        if (forms.login instanceof HTMLFormElement) {
          const emailInput = forms.login.querySelector('input[name="loginEmail"]');
          if (emailInput instanceof HTMLInputElement) {
            emailInput.value = profile.email || '';
          }
        }
        addLog(`
          <div class="quick-signin-log">
            Google sign-in demo profile retrieved.<br>
            <strong>${sanitize(profile.name || 'Google user')}</strong> · ${sanitize(profile.email || '')}
          </div>
        `.trim());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        renderGoogleProfile(null, { status: `Unable to connect: ${message}`, isError: true });
        logError(`Google sign-in failed: ${message}`);
      } finally {
        googleSignInInFlight = false;
        googleSigninButton.disabled = false;
        googleSigninButton.textContent = restoreLabel || googleSigninDefaultLabel;
      }
    });
  }

  if (quickSigninButton instanceof HTMLButtonElement) {
    quickSigninButton.addEventListener('click', () => {
      if (!cachedGoogleProfile) {
        logWarning('Fetch a Google profile before using quick sign-in.');
        renderGoogleProfile(null, { status: 'Connect with Google first.', isError: true });
        return;
      }
      finalizeOnboarding(MEMBERSHIP_LEVELS.MEMBER, {
        email: cachedGoogleProfile.email,
        name: cachedGoogleProfile.name,
        plan: 'pro',
        authProvider: 'google',
        avatar: cachedGoogleProfile.picture,
        locale: cachedGoogleProfile.locale,
        quickSignIn: true,
      });
      addLog(`
        <div class="quick-signin-log quick-signin-log--success">
          Quick sign-in activated for ${sanitize(cachedGoogleProfile.email || 'member')} via Google.
        </div>
      `.trim(), 'success');
    });
  }

  if (paymentBackBtn instanceof HTMLButtonElement) {
    paymentBackBtn.addEventListener('click', () => {
      closePaymentIntake({ reopenLanding: true });
    });
  }

  if (paymentForm instanceof HTMLFormElement) {
    paymentForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!paymentForm.reportValidity()) return;

      if (paymentForm.dataset.secureBilling === 'true') {
        const fallbackCardholder = (pendingMembershipDetails && (pendingMembershipDetails.name || pendingMembershipDetails.email))
          ? String(pendingMembershipDetails.name || pendingMembershipDetails.email).trim()
          : '';
        logWarning('Direct card capture is disabled. A secure billing link will be emailed to complete activation.');
        logOK('Secure billing link requested. Free trial provisioning will resume after checkout.');
        const membershipDetails = Object.assign({}, pendingMembershipDetails || {}, {
          paymentMethod: 'secure-link',
          cardholder: fallbackCardholder,
          secureBillingRequestedAt: new Date().toISOString(),
        });
        finalizeOnboarding(pendingMembershipLevel, membershipDetails);
        return;
      }

      const data = new FormData(paymentForm);
      const rawNumber = String(data.get('cardNumber') || '');
      const digitsOnly = rawNumber.replace(/\D+/g, '');
      const last4 = digitsOnly.slice(-4);
      const cardholder = String(data.get('cardName') || '').trim();
      if (last4) {
        logOK(`Payment method saved ••••${last4}. Free trial ready.`);
      } else {
        logOK('Payment method saved. Free trial ready.');
      }
      const membershipDetails = Object.assign({}, pendingMembershipDetails || {}, {
        paymentMethod: last4 ? `card-${last4}` : 'card',
        cardholder,
      });
      finalizeOnboarding(pendingMembershipLevel, membershipDetails);
    });
  }

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view || 'signup';
      setActiveView(view);
    });
  });

  if (forms.signup instanceof HTMLFormElement) {
    forms.signup.addEventListener('submit', (event) => {
      event.preventDefault();
      if (typeof forms.signup.reportValidity === 'function' && !forms.signup.reportValidity()) {
        return;
      }
      const data = new FormData(forms.signup);
      openPaymentIntake(MEMBERSHIP_LEVELS.MEMBER, {
        name: String(data.get('fullName') || '').trim(),
        email: String(data.get('email') || '').trim(),
        company: String(data.get('company') || '').trim(),
        role: String(data.get('role') || '').trim(),
        plan: 'pro',
        trialDays: DEFAULT_TRIAL_DAYS,
        price: DEFAULT_PRICE,
      });
    });
  }

  if (forms.login instanceof HTMLFormElement) {
    initializeLoginForm(forms.login, {
      finalizeOnboarding,
      membershipLevels: MEMBERSHIP_LEVELS,
    });
  }

  let adminBypassActivated = false;

  const triggerAdminBypass = (source: 'click' | 'hash') => {
    if (adminBypassActivated && getMembershipLevel() === MEMBERSHIP_LEVELS.MEMBER) {
      return;
    }
    adminBypassActivated = true;
    finalizeOnboarding(MEMBERSHIP_LEVELS.MEMBER, {
      plan: 'admin',
      name: 'System Administrator',
      email: 'admin@local.dev',
      role: 'admin',
      admin: true,
      authProvider: 'bypass',
    });
    const logOk = (window as any).logOK;
    if (typeof logOk === 'function') {
      const suffix = source === 'hash'
        ? ' via URL hash. Full access granted.'
        : '. Full access granted.';
      logOk(`Admin bypass activated${suffix}`);
    }
  };

  const clearAdminBypassHash = () => {
    if (typeof window === 'undefined') return;
    const { hash, pathname, search } = window.location;
    if (typeof hash === 'string' && hash.trim().toLowerCase() === '#admin-bypass') {
      const nextUrl = `${pathname}${search}`;
      if (typeof window.history?.replaceState === 'function') {
        window.history.replaceState(null, '', nextUrl);
      } else {
        window.location.hash = '';
      }
    }
  };

  const maybeHandleAdminBypassFromHash = (hash?: string) => {
    if (typeof hash !== 'string') return false;
    const normalized = hash.trim().toLowerCase();
    if (normalized === '#admin-bypass') {
      triggerAdminBypass('hash');
      clearAdminBypassHash();
      return true;
    }
    return false;
  };

  if (adminBypassLink instanceof HTMLAnchorElement) {
    adminBypassLink.addEventListener('click', (event) => {
      event.preventDefault();
      triggerAdminBypass('click');
      clearAdminBypassHash();
    });
  }

  maybeHandleAdminBypassFromHash(window.location?.hash);

  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
      maybeHandleAdminBypassFromHash(window.location.hash);
    });
  }

  if (forms.demo instanceof HTMLFormElement) {
    forms.demo.addEventListener('submit', (event) => {
      event.preventDefault();
      if (typeof forms.demo.reportValidity === 'function' && !forms.demo.reportValidity()) {
        return;
      }
      const data = new FormData(forms.demo);
      const demoMode = String(data.get('demoMode') || 'api').toLowerCase() === 'offline' ? 'offline' : 'api';
      finalizeOnboarding(MEMBERSHIP_LEVELS.DEMO, {
        name: String(data.get('demoName') || '').trim(),
        email: String(data.get('demoEmail') || '').trim(),
        focus: String(data.get('demoFocus') || '').trim(),
        demoMode,
      });
    });
  }

  setActiveView('signup');
  landingRoot.setAttribute('aria-hidden', 'false');

  if (typeof window !== 'undefined') {
    const engineRoot = (window.CognitionEngine ||= {});
    engineRoot.openLanding = openLanding;
    engineRoot.finalizeOnboarding = finalizeOnboarding;
    engineRoot.membershipLevels = MEMBERSHIP_LEVELS;
    engineRoot.landingInitialized = true;

    const queueKey = '__hlsfPendingOnboarding__';
    const pending = Array.isArray((window as any)[queueKey])
      ? (window as any)[queueKey].splice(0)
      : [];

    if (pending.length) {
      pending.forEach((payload: any) => {
        if (!payload || !payload.level) return;
        try {
          finalizeOnboarding(payload.level, payload.details || {});
        } catch (err) {
          console.warn('Deferred onboarding finalization failed:', err);
        }
      });
    }
  }
}

function exitProcessingState(options = {}) {
  const {
    preserveInput = false,
    statusMessage = null,
    status = null,
    cancelled = false,
  } = options || {};

  const resolvedStatus = typeof status === 'string' && status.trim()
    ? status.trim().toLowerCase()
    : (cancelled ? 'cancelled' : 'success');

  const hasActiveStatus = state.processingStatus
    && typeof state.processingStatus.isActive === 'function'
    && state.processingStatus.isActive();

  if (state.processingStart) {
    const elapsed = Math.max(0, nowMs() - state.processingStart);
    if (elapsed > 0) {
      const samples = Number.isFinite(state.processingSamples) ? state.processingSamples : 0;
      const average = Number.isFinite(state.processingAverageMs) ? state.processingAverageMs : 0;
      const nextSamples = samples + 1;
      state.processingAverageMs = ((average * samples) + elapsed) / nextSamples;
      state.processingSamples = nextSamples;
    }
  }

  if (hasActiveStatus) {
    const summary = typeof statusMessage === 'string' && statusMessage.trim()
      ? statusMessage.trim()
      : resolvedStatus === 'failed'
        ? 'Processing failed'
        : resolvedStatus === 'cancelled'
          ? 'Processing cancelled'
          : 'Processing complete';

    if (resolvedStatus === 'failed' && typeof state.processingStatus.fail === 'function') {
      state.processingStatus.fail(summary);
    } else if (resolvedStatus === 'cancelled' && typeof state.processingStatus.cancel === 'function') {
      state.processingStatus.cancel(summary);
    } else if (typeof state.processingStatus.complete === 'function') {
      state.processingStatus.complete({ summary });
    }
  }

  state.processingStatus = null;
  state.processingStart = 0;
  state.isProcessing = false;
  currentAbortController = null;
  if (elements.sendBtn) elements.sendBtn.disabled = false;
  if (elements.cancelBtn) elements.cancelBtn.style.display = 'none';
  if (elements.input) {
    elements.input.disabled = false;
    if (!preserveInput) elements.input.value = '';
    elements.input.focus();
  }
}

async function processPrompt(prompt) {
  if (!enterProcessingState()) return;

  const startTime = performance.now();
  const promptReviewId = `review-${Date.now()}`;
  const batchTokens = new Map();
  const detachCacheListener = CacheBatch.listen((token) => {
    if (!token) return;
    const normalized = String(token).toLowerCase();
    if (!normalized || batchTokens.has(normalized)) return;
    batchTokens.set(normalized, token);
  });
  let promptSucceeded = false;

  try {
    const limitedPrompt = limitWords(prompt, CONFIG.INPUT_WORD_LIMIT);
    const normalizedPrompt = limitedPrompt.text;

    if (!normalizedPrompt) {
      logError('Prompt cannot be empty');
      return;
    }

    if (limitedPrompt.trimmed) {
      logWarning(`Prompt truncated to ${CONFIG.INPUT_WORD_LIMIT} words to meet pipeline constraints.`);
    }

    const tokens = tokenize(normalizedPrompt);
    if (tokens.length === 0) {
      logError('Prompt cannot be empty');
      return;
    }
    addConversationTokens(tokens);
    if (tokens.length > CONFIG.MAX_TOKENS_PER_PROMPT) {
      logError(`Exceeds ${CONFIG.MAX_TOKENS_PER_PROMPT} token limit (${tokens.length})`);
      return;
    }

    const uniqueTokens = [...new Set(tokens)];
    const cachedTokens = uniqueTokens.filter(isTokenCached).length;
    const newTokenCount = Math.max(0, uniqueTokens.length - cachedTokens);

    const adjacencyCallEstimate = state.apiKey
      ? uniqueTokens.length * CONFIG.ADJACENCY_RECURSION_DEPTH
      : 0;
    const adjacencyCostEstimate = adjacencyCallEstimate > 0
      ? adjacencyCallEstimate * estimateCostUsd(
          CONFIG.ADJACENCY_TOKEN_ESTIMATES.prompt,
          CONFIG.ADJACENCY_TOKEN_ESTIMATES.completion
        )
      : 0;

    addLog(`<div class="cost-estimate">
      📊 <strong>Estimate:</strong> ${tokens.length} input tokens observed (${newTokenCount} new, ${cachedTokens} cached).<br>
      • Adjacency recursion depth ${CONFIG.ADJACENCY_RECURSION_DEPTH}: ≈${adjacencyCallEstimate} call${adjacencyCallEstimate === 1 ? '' : 's'} (${formatCurrency(adjacencyCostEstimate)}).<br>
      • Targeted edges: ${CONFIG.ADJACENCY_RECURSION_DEPTH} × ${CONFIG.ADJACENCY_EDGES_PER_LEVEL} = ${CONFIG.ADJACENCY_RECURSION_DEPTH * CONFIG.ADJACENCY_EDGES_PER_LEVEL} potential adjacencies per seed token.
    </div>`);

    const inputAdjTokens = await collectSymbolAwareTokens(normalizedPrompt, tokens, 'prompt-input');
    const promptMemoryEntry = recordLocalPromptMemory(
      promptReviewId,
      normalizedPrompt,
      uniqueTokens,
      inputAdjTokens,
    );
    if (promptMemoryEntry) {
      const tokenSummary = formatTokenList(promptMemoryEntry.tokens, 10);
      const seedSummary = formatTokenList(promptMemoryEntry.adjacencySeeds, 10);
      const summaryParts: string[] = [
        sanitize(`${promptMemoryEntry.tokens.length} token${promptMemoryEntry.tokens.length === 1 ? '' : 's'}`),
      ];
      if (tokenSummary) {
        summaryParts.push(sanitize(tokenSummary));
      }
      if (seedSummary) {
        summaryParts.push(sanitize(`adjacency seeds ${seedSummary}`));
      }
      addLog(`<div class="adjacency-insight"><strong>🧠 Local HLSF memory primed:</strong> ${summaryParts.join(' · ')}</div>`);
    }
    const normalizedSeeds = normalizeAdjacencyInputs(inputAdjTokens);
    await hydrateTokensFromKnowledgeStore(normalizedSeeds);
    const dbRecordIndex = buildDbRecordIndexMap();
    const remoteDbReady = window.HLSF?.remoteDb?.isReady?.() === true;
    const preferDbHydration = remoteDbReady || dbRecordIndex.size > 0;
    const dbSeedTokens = [];
    const llmSeedTokens = [];

    if (preferDbHydration) {
      for (const seed of normalizedSeeds) {
        if (!seed || seed.kind === 'sym') continue;
        const rawToken = String(seed.token || '').trim();
        if (!rawToken) continue;
        const seedKey = rawToken.toLowerCase();
        if (isTokenCached(rawToken)) {
          dbSeedTokens.push(rawToken);
          continue;
        }

        let hydrated = false;
        if (dbRecordIndex.has(seedKey)) {
          const record = dbRecordIndex.get(seedKey);
          if (record && record.relationships && Object.keys(record.relationships).length) {
            hydrated = stageDbRecordForCache(record);
          }
        }

        if (hydrated) {
          dbSeedTokens.push(rawToken);
        } else {
          llmSeedTokens.push(rawToken);
        }
      }
    }

    const dbSeedSummary = formatTokenList(dbSeedTokens);
    if (dbSeedSummary) {
      addLog(`<div class="adjacency-insight"><strong>📚 Database adjacencies ready:</strong> ${sanitize(dbSeedSummary)}</div>`);
      notifyHlsfAdjacencyChange('prompt-db-seeds', { immediate: true });
    }

    const llmSeedSummary = formatTokenList(llmSeedTokens);
    if (llmSeedSummary) {
      addLog(`<div class="adjacency-insight"><strong>🤖 Awaiting LLM adjacency generation:</strong> ${sanitize(llmSeedSummary)}</div>`);
    }

    const recursionResult = await fetchRecursiveAdjacencies(
      inputAdjTokens,
      normalizedPrompt,
      'recursive adjacency',
      {
        depth: CONFIG.ADJACENCY_RECURSION_DEPTH,
        edgesPerLevel: CONFIG.ADJACENCY_EDGES_PER_LEVEL,
        onTokenLoaded: () => queueLiveGraphUpdate(48),
        preferDb: preferDbHydration,
        dbRecordIndex,
        normalizedSeeds,
      },
    );

    const inputMatrices = recursionResult.matrices;
    const recursionStats = recursionResult.stats || {};

    const provenance = recursionResult.provenance || {};
    const dbExpansionSummary = formatTokenList(provenance.cacheHits);
    if (dbExpansionSummary) {
      addLog(`<div class="adjacency-insight"><strong>📈 Database coverage:</strong> ${sanitize(dbExpansionSummary)}</div>`);
      notifyHlsfAdjacencyChange('prompt-db-expansion', { immediate: true });
    }

    const llmExpansionSummary = formatTokenList(provenance.llmGenerated);
    if (llmExpansionSummary) {
      addLog(`<div class="adjacency-insight"><strong>🤖 LLM adjacency expansions:</strong> ${sanitize(llmExpansionSummary)}</div>`);
    }

    if (Array.isArray(provenance.offline) && provenance.offline.length) {
      const offlineSummary = formatTokenList(provenance.offline);
      if (offlineSummary) {
        addLog(`<div class="adjacency-insight"><strong>⚠️ Offline adjacencies skipped:</strong> ${sanitize(offlineSummary)}</div>`);
      }
    }

    const connectivitySummary = recursionStats.connectivity || recursionResult.connectivity || null;
    const summaryParts = [
      `seeds ${recursionStats.seedCount || 0}`,
      `visited ${recursionStats.visitedTokens || 0}`,
      `expansions ${recursionStats.expansions || 0}`,
    ];
    if (Number.isFinite(recursionStats.fetchCount)) {
      summaryParts.push(`fetches ${recursionStats.fetchCount}`);
    }
    summaryParts.push(`API calls ${recursionStats.apiCalls || 0}`);
    const connectivityText = connectivitySummary
      ? ` · connectivity ${connectivitySummary.allSeedsConnected ? 'complete' : 'partial'} (${connectivitySummary.componentCount || 0} component${(connectivitySummary.componentCount || 0) === 1 ? '' : 's'})`
      : '';

    addLog(`<div class="adjacency-insight">
      <strong>🔁 Recursive expansion:</strong> ${summaryParts.join(' · ')}${connectivityText}
    </div>`);

    if (connectivitySummary && !connectivitySummary.allSeedsConnected) {
      const disconnected = Array.isArray(connectivitySummary.disconnectedSeeds)
        ? connectivitySummary.disconnectedSeeds.slice(0, 8)
        : [];
      if (disconnected.length) {
        logWarning(`Adjacency graph still has disconnected seeds: ${sanitize(disconnected.join(', '))}`);
      }
      const isolated = Array.isArray(connectivitySummary.isolatedSeeds)
        ? connectivitySummary.isolatedSeeds.slice(0, 8)
        : [];
      if (isolated.length) {
        logWarning(`Isolated seeds lack adjacency edges: ${sanitize(isolated.join(', '))}`);
      }
    }

    let shouldReloadHlsf = hasNewAdjacencyData(inputMatrices);

    calculateAttention(inputMatrices);

    const allMatrices = inputMatrices instanceof Map ? new Map(inputMatrices) : new Map();
    const adjacencyRecord = recordLocalAdjacencySummary(
      promptReviewId,
      allMatrices,
      'prompt-adjacency',
      { limit: 24, edgesPerToken: 6 },
    );
    if (adjacencyRecord) {
      const adjacencyTokenSummary = formatTokenList(
        adjacencyRecord.summary.map(item => item.token),
        10,
      );
      const detailParts: string[] = [
        sanitize(`${adjacencyRecord.tokenCount} adjacency token${adjacencyRecord.tokenCount === 1 ? '' : 's'}`),
      ];
      if (adjacencyTokenSummary) {
        detailParts.push(sanitize(adjacencyTokenSummary));
      }
      addLog(`<div class="adjacency-insight"><strong>🗂️ Local adjacency cache updated:</strong> ${detailParts.join(' · ')}</div>`);
      notifyHlsfAdjacencyChange('prompt-local-memory', { immediate: true });
    }
    const topTokens = summarizeAttention(allMatrices);
    const keyRels = extractKeyRelationships(allMatrices);

    addLog(`<div class="adjacency-insight">
      <strong>🎯 High Attention:</strong> ${formatTopTokens(topTokens)}
    </div>
    <div class="adjacency-insight">
      <strong>🔗 Key Relationships:</strong><br>
      ${keyRels.map(r => `• ${r}`).join('<br>')}
    </div>`);

    const affinityCfg = window.HLSF?.config?.affinity || {};
    const affinityThreshold = Number.isFinite(affinityCfg.threshold) ? affinityCfg.threshold : 0.35;
    const affinityIterations = Number.isFinite(affinityCfg.iterations) ? affinityCfg.iterations : 8;
    const mentalState = describeAffinityMentalState(affinityThreshold, affinityIterations) || {};

    const localOutputData = generateLocalHlsfOutput(allMatrices, {
      wordLimit: CONFIG.LOCAL_OUTPUT_WORD_LIMIT,
      responseWordLimit: CONFIG.LOCAL_RESPONSE_WORD_LIMIT,
      threshold: affinityThreshold,
      iterations: affinityIterations,
      mentalState,
      topTokens,
      keyRelationships: keyRels,
      inputWordCount: limitedPrompt.wordCount || tokens.length,
    });

    let localThought = localOutputData.thoughtText || localOutputData.text || '';
    if (!localThought) {
      localThought = 'Adjacency walk could not assemble a local output with the available data.';
    }
    if (localOutputData.thoughtTrimmed || localOutputData.trimmed) {
      logWarning(`Local thought stream truncated to ${CONFIG.LOCAL_OUTPUT_WORD_LIMIT} words.`);
    }
    const thoughtLimited = limitWords(localThought, CONFIG.LOCAL_OUTPUT_WORD_LIMIT);
    if (thoughtLimited.trimmed && !(localOutputData.thoughtTrimmed || localOutputData.trimmed)) {
      logWarning(`Local thought stream trimmed to ${CONFIG.LOCAL_OUTPUT_WORD_LIMIT} words.`);
    }
    localThought = thoughtLimited.text;
    const localThoughtWordCount = localOutputData.thoughtWordCount || thoughtLimited.wordCount || countWords(localThought);

    let localOutput = localOutputData.responseText || localThought;
    if (localOutputData.responseTrimmed) {
      logWarning(`Local output truncated to ${CONFIG.LOCAL_RESPONSE_WORD_LIMIT} words.`);
    }
    localOutput = DbLexicon.rewriteText(localOutput);
    const localLimited = limitWords(localOutput, CONFIG.LOCAL_RESPONSE_WORD_LIMIT);
    if (localLimited.trimmed && !localOutputData.responseTrimmed) {
      logWarning(`Local output trimmed to ${CONFIG.LOCAL_RESPONSE_WORD_LIMIT} words.`);
    }
    localOutput = localLimited.text;
    const responseWasTrimmed = Boolean(localOutputData.responseTrimmed) || localLimited.trimmed;
    const limitedWordCount = localLimited.wordCount ?? countWords(localOutput);
    const localWordCount = responseWasTrimmed
      ? limitedWordCount
      : (typeof localOutputData.responseWordCount === 'number'
        ? localOutputData.responseWordCount
        : limitedWordCount);

    const localResponseTokens = responseWasTrimmed
      ? tokenize(localOutput)
      : (Array.isArray(localOutputData.responseTokens) && localOutputData.responseTokens.length
        ? localOutputData.responseTokens
        : tokenize(localOutput));

    if (localResponseTokens.length) {
      addConversationTokens(localResponseTokens);
      addOutputTokens(localResponseTokens, { render: false });
    }

    let localAdjacency = null;
    if (localResponseTokens.length) {
      const localAdjTargets = await collectSymbolAwareTokens(localOutput, localResponseTokens, 'prompt-local-output');
      await hydrateTokensFromKnowledgeStore(localAdjTargets);
      if (localAdjTargets.length) {
        const localAdjStatus = logStatus('⏳ Caching local HLSF AGI adjacencies');
        try {
          localAdjacency = await batchFetchAdjacencies(localAdjTargets, localOutput, 'local response adjacencies');
          localAdjStatus.innerHTML = `✅ ${sanitize('Local HLSF AGI adjacencies cached')}`;
        } catch (err) {
          localAdjStatus.innerHTML = `❌ ${sanitize(`Local HLSF AGI adjacency cache failed: ${err?.message || err}`)}`;
          logError(`Failed to cache local HLSF AGI adjacencies: ${err?.message || err}`);
          localAdjacency = null;
        }
      }
    }

    if (localAdjacency instanceof Map && localAdjacency.size) {
      calculateAttention(localAdjacency);
      mergeAdjacencyMaps(allMatrices, localAdjacency);
      calculateAttention(allMatrices);
      if (shouldReloadHlsf !== true && hasNewAdjacencyData(localAdjacency)) {
        shouldReloadHlsf = true;
      }
    }

    const walkDetails = Array.isArray(localOutputData.walk) && localOutputData.walk.length
      ? localOutputData.walk.map(step => `${sanitize(step.from || '')} → ${sanitize(relDisplay(step.relation || '∼'))} → ${sanitize(step.to || '')} (${Number.isFinite(step.weight) ? step.weight.toFixed(2) : '0.00'})`).join('<br>')
      : '';

    const mentalSummary = [
      mentalState.name ? `<strong>${sanitize(mentalState.name)}</strong>` : '',
      mentalState.desc ? sanitize(mentalState.desc) : '',
      `Threshold ${affinityThreshold.toFixed(2)} · Iterations ${affinityIterations}`,
    ].filter(Boolean).join('<br>');

    const visitedSummary = Array.isArray(localOutputData.visitedTokens) && localOutputData.visitedTokens.length
      ? `<div class="adjacency-insight"><strong>🧠 Traversal tokens:</strong> ${sanitize(localOutputData.visitedTokens.slice(0, 10).join(', '))}</div>`
      : '';

    recordLatestLocalVoiceOutputs({
      prompt: normalizedPrompt,
      localThought,
      localResponse: localOutput,
      source: 'prompt',
    });

    const safeThought = sanitize(localThought);
    const safeResponse = sanitize(localOutput);

    addLog(`<div class="section-divider"></div>
      <div class="section-title">🤖 Local HLSF AGI Output</div>
      <div class="thought-stream"><strong>Thought stream:</strong> ${safeThought}</div>
      <div class="local-response"><strong>Actual output:</strong> ${safeResponse}</div>
      <div class="adjacency-insight">${mentalSummary}</div>
      ${visitedSummary}
      ${walkDetails ? `<details><summary>Adjacency walk (${localOutputData.walk.length} steps)</summary><div class="adjacency-insight">${walkDetails}</div></details>` : ''}
    `);

    if (shouldReloadHlsf) {
      notifyHlsfAdjacencyChange('prompt-adjacencies', { immediate: true });
    }

    rebuildLiveGraph();

    const time = ((performance.now() - startTime) / 1000).toFixed(1);

    addLog(`<div class="section-divider"></div>
      <div class="final-output">
        <h3>🧩 HLSF Output Suite</h3>
        <details open>
          <summary>Local HLSF AGI thought stream (${localThoughtWordCount} words)</summary>
          <pre>${safeThought}</pre>
        </details>
        <details open>
          <summary>Local HLSF AGI chosen response (${localWordCount} words)</summary>
          <pre>${safeResponse}</pre>
        </details>
        <details>
          <summary>Adjacency data sample (${allMatrices.size} tokens)</summary>
          <pre>${JSON.stringify(Array.from(allMatrices.entries()).slice(0, 5), null, 2)}</pre>
        </details>
      </div>
    `);

    logOK(`Output suite ready (${time}s)`);

    if (batchTokens.size) {
      registerPromptReview(promptReviewId, batchTokens, allMatrices);
    }
    promptSucceeded = true;

    notifyHlsfAdjacencyChange('prompt-complete');

  } catch (err) {
    if (err.name === 'AbortError' || err.message === 'AbortError') {
      logWarning('Processing cancelled');
    } else {
      logError(err.message || 'Processing failed');
      console.error(err);
    }
  } finally {
    detachCacheListener();
    if (!promptSucceeded && batchTokens.size) {
      removeTokensFromCache(Array.from(batchTokens.values()));
    }
    exitProcessingState();
  }
}

function buildDocumentChunks(text, maxUniqueTokens = CONFIG.DOCUMENT_CHUNK_SIZE || 8) {
  const rawTokens = tokenize(text || '');
  const alignedTokens = DbLexicon.alignTokens(rawTokens).filter(Boolean);
  const uniqueLimit = Math.max(1, Math.floor(Number(maxUniqueTokens) || 1));

  const chunks = [];
  let currentChunk = [];
  let currentUnique = new Set();

  for (const token of alignedTokens) {
    const normalized = (token == null ? '' : String(token)).trim();
    if (!normalized) {
      continue;
    }

    currentChunk.push(normalized);
    if (normalized) {
      currentUnique.add(normalized.toLowerCase());
    }

    if (currentUnique.size >= uniqueLimit) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentUnique = new Set();
    }
  }

  if (currentChunk.length) {
    chunks.push(currentChunk);
  }

  const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  return {
    chunks,
    totalTokens,
    oversizedSentences: 0,
    rawTokenCount: rawTokens.length,
  };
}

async function editForCoherence(kind, chunkLabel, text) {
  if (!state.apiKey || !text || !text.trim()) return text;
  const messages = [
    { role: 'system', content: 'You are an editorial assistant who improves coherence and clarity while preserving intent and vocabulary.' },
    { role: 'user', content: `Polish the following ${kind} so it reads smoothly while keeping terminology consistent with the cached lexicon. Do not add new ideas.\n\n${text}` },
  ];
  const tokenCount = tokenize(text).length;
  const maxTokens = Math.min(420, Math.max(120, estimateCompletionTokens(tokenCount)));
  const polished = await safeAsync(
    () => callOpenAI(messages, { temperature: 0.2, max_tokens: maxTokens }),
    `${chunkLabel} ${kind} edit failed`
  );
  return polished?.trim() || text;
}

class DocumentReadEstimator {
  constructor(chunks, options = {}) {
    this.chunks = Array.isArray(chunks) ? chunks : [];
    this.totalChunks = this.chunks.length;
    this.chunksProcessed = 0;
    this.statusElement = null;
    this.cancelled = false;
    this.isComplete = false;

    this.currentSeenTokens = new Set();
    this.initialSeenTokens = new Set();
    this.cachePresence = new Map();
    this.totalDurationMs = 0;
    this.totalAdjacencyDurationMs = 0;
    this.totalAdjacencyRequests = 0;
    this.totalAdjacencyHits = 0;
    this.totalAdjacencyMisses = 0;
    this.totalAdjacencyHitDurationMs = 0;
    this.totalAdjacencyMissDurationMs = 0;
    this.totalNonAdjacencyDurationMs = 0;
    this.totalUniqueTokensObserved = 0;
    this.cachedTokenBaseline = Math.max(0, Number(options?.cachedTokenBaseline) || 0);
    this.warmupStats = null;

    const seedTokens = Array.isArray(options?.seedTokens)
      ? options.seedTokens
      : listCachedTokens(CONFIG.CACHE_SEED_LIMIT || 0);
    const defaultLimit = Number.isFinite(CONFIG.CACHE_SEED_LIMIT) && CONFIG.CACHE_SEED_LIMIT > 0
      ? Math.floor(CONFIG.CACHE_SEED_LIMIT)
      : seedTokens.length;
    const seedLimit = Number.isFinite(options?.seedLimit) && options.seedLimit > 0
      ? Math.floor(options.seedLimit)
      : defaultLimit;
    let seeded = 0;
    for (const token of seedTokens || []) {
      if (!token) continue;
      const key = this.getTokenKey(token);
      if (!key || this.currentSeenTokens.has(key)) continue;
      this.currentSeenTokens.add(key);
      this.initialSeenTokens.add(key);
      this.cachePresence.set(key, true);
      seeded++;
      if (seedLimit && seeded >= seedLimit) break;
    }
  }

  setStatusElement(element) {
    this.statusElement = element || null;
    this.updateStatus();
  }

  getTokenKey(token) {
    return (token == null ? '' : String(token)).toLowerCase();
  }

  fetchCachedPresence(token) {
    const key = this.getTokenKey(token);
    if (this.cachePresence.has(key)) return this.cachePresence.get(key);
    const cached = isTokenCached(token);
    this.cachePresence.set(key, cached);
    if (cached) this.initialSeenTokens.add(key);
    return cached;
  }

  prepareChunk(index, chunk) {
    const list = Array.isArray(chunk) ? chunk : [];
    const seenInChunk = new Set();
    const uniqueKeys = [];
    const originalTokens = [];
    for (const token of list) {
      const key = this.getTokenKey(token);
      if (!key || seenInChunk.has(key)) continue;
      seenInChunk.add(key);
      uniqueKeys.push(key);
      originalTokens.push(token);
    }

    let cachedBefore = 0;
    const cachedFlags = [];
    for (let i = 0; i < uniqueKeys.length; i++) {
      const key = uniqueKeys[i];
      let warm = this.currentSeenTokens.has(key);
      if (!warm) {
        warm = this.fetchCachedPresence(originalTokens[i]);
      }
      cachedFlags.push(warm);
      if (warm) cachedBefore++;
    }

    return {
      uniqueTokens: uniqueKeys.length,
      cachedBefore,
      newBefore: Math.max(0, uniqueKeys.length - cachedBefore),
      keys: uniqueKeys,
      cachedFlags,
    };
  }

  recordWarmup(stats = {}) {
    if (!stats || typeof stats !== 'object') return;
    const summary = {
      uniqueTokens: Math.max(0, Number(stats.uniqueTokens) || 0),
      cachedBefore: Math.max(0, Number(stats.cachedBefore) || 0),
      stagedFromDb: Math.max(0, Number(stats.stagedFromDb) || 0),
      remoteHits: Math.max(0, Number(stats.remoteHits) || 0),
      remoteLoads: Math.max(0, Number(stats.remoteLoads) || 0),
      durationMs: Math.max(0, Number(stats.durationMs) || 0),
    };
    this.warmupStats = summary;
    if (summary.cachedBefore > this.cachedTokenBaseline) {
      this.cachedTokenBaseline = summary.cachedBefore;
    }
    this.updateStatus();
  }

  getSimulationSeed() {
    return new Set([...this.initialSeenTokens, ...this.currentSeenTokens]);
  }

  recordChunk(index, stats = {}, metaOverride = null) {
    const meta = metaOverride || this.prepareChunk(index, this.chunks[index] || []);
    for (const key of meta.keys) this.currentSeenTokens.add(key);

    this.chunksProcessed = Math.max(this.chunksProcessed, index + 1);
    this.totalUniqueTokensObserved += meta.uniqueTokens;

    const durationMs = Number(stats.durationMs) || 0;
    const adjacencyDurationMs = Number(stats.adjacencyDurationMs) || 0;
    const adjacencyHits = Number(stats.adjacencyHits) || 0;
    const adjacencyMisses = Number(stats.adjacencyMisses) || 0;
    const adjacencyRequests = Number(stats.adjacencyRequests) || (adjacencyHits + adjacencyMisses);
    const totalAdjEntries = adjacencyHits + adjacencyMisses;

    const nonAdjacencyMs = Math.max(0, durationMs - adjacencyDurationMs);
    this.totalDurationMs += durationMs;
    this.totalAdjacencyDurationMs += adjacencyDurationMs;
    this.totalAdjacencyHits += adjacencyHits;
    this.totalAdjacencyMisses += adjacencyMisses;
    this.totalAdjacencyRequests += adjacencyRequests;
    this.totalNonAdjacencyDurationMs += nonAdjacencyMs;

    if (adjacencyDurationMs > 0 && totalAdjEntries > 0) {
      const missShare = Math.min(1, adjacencyMisses / totalAdjEntries);
      const missDuration = adjacencyDurationMs * missShare;
      const hitDuration = adjacencyDurationMs - missDuration;
      this.totalAdjacencyMissDurationMs += missDuration;
      this.totalAdjacencyHitDurationMs += hitDuration;
    }

    this.isComplete = this.chunksProcessed >= this.totalChunks;
    this.updateStatus();
  }

  computeRemainingForecast() {
    const remainingChunks = this.totalChunks - this.chunksProcessed;
    if (remainingChunks <= 0) {
      const hitRate = this.totalAdjacencyRequests > 0
        ? this.totalAdjacencyHits / this.totalAdjacencyRequests
        : 0;
      return {
        remainingMs: 0,
        remainingChunks: 0,
        predictedAdjRequests: 0,
        predictedNewAdjRequests: 0,
        predictedCachedAdjRequests: 0,
        projectedHitRate: hitRate,
      };
    }

    const avgChunkDuration = this.chunksProcessed > 0
      ? this.totalDurationMs / this.chunksProcessed
      : 0;
    const avgNonAdjDuration = this.chunksProcessed > 0
      ? this.totalNonAdjacencyDurationMs / this.chunksProcessed
      : 0;
    const avgAdjRequestsPerToken = this.totalUniqueTokensObserved > 0
      ? this.totalAdjacencyRequests / this.totalUniqueTokensObserved
      : 0;
    const avgMissDuration = this.totalAdjacencyMisses > 0
      ? this.totalAdjacencyMissDurationMs / this.totalAdjacencyMisses
      : 0;
    const avgHitDuration = this.totalAdjacencyHits > 0
      ? this.totalAdjacencyHitDurationMs / this.totalAdjacencyHits
      : 0;

    const simSeen = this.getSimulationSeed();
    let simulatedUnique = 0;
    let simulatedNew = 0;

    for (let idx = this.chunksProcessed; idx < this.totalChunks; idx++) {
      const chunk = this.chunks[idx] || [];
      const meta = this.prepareChunk(idx, chunk);
      simulatedUnique += meta.uniqueTokens;
      let newCount = 0;
      for (let i = 0; i < meta.keys.length; i++) {
        const key = meta.keys[i];
        if (simSeen.has(key)) continue;
        const initialWarm = this.initialSeenTokens.has(key);
        if (!initialWarm) newCount++;
        simSeen.add(key);
      }
      simulatedNew += newCount;
    }

    const predictedAdjRequests = simulatedUnique * Math.max(0, avgAdjRequestsPerToken);
    const predictedNewAdjRequests = simulatedNew * Math.max(0, avgAdjRequestsPerToken);
    const predictedCachedAdjRequests = Math.max(0, predictedAdjRequests - predictedNewAdjRequests);

    const effectiveMissDuration = avgMissDuration || avgHitDuration || avgNonAdjDuration;
    const effectiveHitDuration = avgHitDuration || (avgMissDuration * 0.4) || (avgNonAdjDuration * 0.25);

    let adjacencyMs = 0;
    if (predictedAdjRequests > 0 && Number.isFinite(effectiveMissDuration)) {
      adjacencyMs = (predictedNewAdjRequests * (effectiveMissDuration || 0))
        + (predictedCachedAdjRequests * (effectiveHitDuration || 0));
    }

    let nonAdjMs = remainingChunks * Math.max(0, avgNonAdjDuration);
    let remainingMs = adjacencyMs + nonAdjMs;

    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      remainingMs = remainingChunks * Math.max(0, avgChunkDuration);
    }

    if (!Number.isFinite(remainingMs)) remainingMs = 0;

    const totalAdjFuture = this.totalAdjacencyRequests + Math.max(0, predictedAdjRequests);
    const totalHitsFuture = this.totalAdjacencyHits + Math.max(0, predictedCachedAdjRequests);
    const projectedHitRate = totalAdjFuture > 0 ? totalHitsFuture / totalAdjFuture : 0;

    return {
      remainingMs: Math.max(0, remainingMs),
      remainingChunks,
      predictedAdjRequests: Math.max(0, predictedAdjRequests),
      predictedNewAdjRequests: Math.max(0, predictedNewAdjRequests),
      predictedCachedAdjRequests: Math.max(0, predictedCachedAdjRequests),
      projectedHitRate,
    };
  }

  estimateRemainingMs() {
    return this.computeRemainingForecast().remainingMs;
  }

  markCancelled() {
    this.cancelled = true;
    this.isComplete = false;
    this.updateStatus();
  }

  complete() {
    this.isComplete = true;
    this.cancelled = false;
    this.updateStatus();
  }

  updateStatus() {
    if (!this.statusElement) return;
    if (this.totalChunks === 0) {
      this.statusElement.innerHTML = '⚠️ No document segments detected.';
      return;
    }

    if (this.cancelled) {
      const percent = ((this.chunksProcessed / this.totalChunks) * 100).toFixed(1);
      const elapsed = formatDuration(this.totalDurationMs);
      this.statusElement.innerHTML = `⚠️ Document ingestion cancelled (${percent}% complete, elapsed ${elapsed}).`;
      return;
    }

    if (this.isComplete) {
      const elapsed = formatDuration(this.totalDurationMs);
      const hitRate = this.totalAdjacencyRequests > 0
        ? (this.totalAdjacencyHits / this.totalAdjacencyRequests) * 100
        : 0;
      this.statusElement.innerHTML = `✅ Document processed in ${elapsed} • cache hits ${hitRate.toFixed(1)}%.`;
      return;
    }

    if (this.chunksProcessed === 0) {
      const preview = this.prepareChunk(0, this.chunks[0] || []);
      const chunkWord = this.totalChunks === 1 ? 'segment' : 'segments';
      const baseline = this.cachedTokenBaseline;
      const hasBaseline = baseline > 0;
      const cachedSummary = preview.cachedBefore > 0
        ? `${preview.cachedBefore} cached`
        : hasBaseline
          ? `${baseline.toLocaleString()} cached (warm cache)`
          : '0 cached';
      const baselineNote = hasBaseline && preview.cachedBefore === 0
        ? ` Warm cache baseline detected: ${baseline.toLocaleString()} tokens.`
        : '';
      const warmup = this.warmupStats;
      const warmupLine = warmup
        ? `<br><small>Warmup: ${warmup.cachedBefore.toLocaleString()} cached · ${(warmup.stagedFromDb + warmup.remoteLoads).toLocaleString()} hydrated · ${warmup.remoteHits.toLocaleString()} remote hits</small>`
        : '';
      this.statusElement.innerHTML = `⏳ Document ETA ready • ${this.totalChunks} ${chunkWord}.<br><small>Segment 1 preview: ${preview.uniqueTokens} unique tokens (${preview.newBefore} new, ${cachedSummary}).${baselineNote}</small>${warmupLine}`;
      return;
    }

    const forecast = this.computeRemainingForecast();
    const remainingMs = forecast.remainingMs;
    const percent = ((this.chunksProcessed / this.totalChunks) * 100).toFixed(1);
    const etaText = formatDuration(remainingMs);
    const elapsed = formatDuration(this.totalDurationMs);
    const hitRate = this.totalAdjacencyRequests > 0
      ? (this.totalAdjacencyHits / this.totalAdjacencyRequests) * 100
      : 0;
    const projected = (forecast.projectedHitRate || 0) * 100;
    const chunkWord = this.totalChunks === 1 ? 'segment' : 'segments';

    this.statusElement.innerHTML = `⏳ Document ETA: ${etaText} remaining (${percent}% of ${this.totalChunks} ${chunkWord}).<br><small>Elapsed ${elapsed}, cache hits ${hitRate.toFixed(1)}% → ${projected.toFixed(1)}% projected.</small>`;
  }
}


async function analyzeDocumentChunk(chunkTokens, index, totalChunks, chunkMeta = {}) {
  const chunkLabel = `Segment ${index + 1}/${totalChunks}`;
  const chunkStart = performance.now();
  const previewTokens = chunkTokens.slice(0, 18).join(' ');
  addLog(`<div class="section-divider"></div><div class="section-title">📚 ${sanitize(chunkLabel)}</div><div>${sanitize(previewTokens)}${chunkTokens.length > 18 ? ' …' : ''}</div>`);

  const documentWordLimit = Math.min(CONFIG.DOCUMENT_WORD_LIMIT || CONFIG.INPUT_WORD_LIMIT, CONFIG.MAX_TOKENS_PER_PROMPT);
  const limitedChunkTokens = chunkTokens.slice(0, documentWordLimit);
  if (chunkTokens.length > limitedChunkTokens.length) {
    logWarning(`${chunkLabel}: prompt truncated to ${documentWordLimit} tokens for pipeline compliance.`);
  }

  const promptWordInfo = limitWords(limitedChunkTokens.join(' '), documentWordLimit);
  if (promptWordInfo.trimmed && chunkTokens.length <= limitedChunkTokens.length) {
    logWarning(`${chunkLabel}: prompt trimmed to ${documentWordLimit} words for pipeline compliance.`);
  }

  const promptText = promptWordInfo.text;
  const promptTokens = tokenize(promptText);
  if (!promptTokens.length) {
    logWarning(`${chunkLabel}: no usable tokens after prompt truncation.`);
    return null;
  }

  recordSessionPrompt(promptText, {
    source: 'document',
    chunk: chunkLabel,
    chunkIndex: index,
    totalChunks,
    tokenCount: promptTokens.length,
    documentName: typeof chunkMeta?.documentName === 'string' ? chunkMeta.documentName : undefined,
  });

  const adjacencyStatus = logStatus(`⏳ ${chunkLabel}: preparing adjacency mapping`);

  const measure = async (fn) => {
    const startTime = performance.now();
    const result = await fn();
    return { result, duration: performance.now() - startTime };
  };

  const promptAdjTokens = await collectSymbolAwareTokens(promptText, promptTokens, `${chunkLabel}-prompt`);
  await hydrateTokensFromKnowledgeStore(promptAdjTokens);
  const inputData = await measure(() => batchFetchAdjacencies(promptAdjTokens, promptText, `${chunkLabel} prompt adjacencies`));

  if (adjacencyStatus) {
    adjacencyStatus.innerHTML = `✅ ${sanitize(`${chunkLabel}: adjacency mapping cached`)}`;
  }

  const inputMatrices = inputData.result;
  const inputAdjDuration = inputData.duration || 0;
  const inputAdjStats = summarizeAdjacencyResults(inputMatrices);
  let localAdjDuration = 0;
  let localAdjStats = { hits: 0, misses: 0, total: 0 };

  calculateAttention(inputMatrices);
  const allMatrices = new Map(inputMatrices);
  calculateAttention(allMatrices);
  let topTokens = summarizeAttention(allMatrices);
  let keyRels = extractKeyRelationships(allMatrices);

  addLog(`<div class="adjacency-insight"><strong>🎯 ${sanitize(chunkLabel)} Focus:</strong> ${formatTopTokens(topTokens)}</div>`);
  if (keyRels.length) {
    addLog(`<div class="adjacency-insight"><strong>🔗 Relationships:</strong><br>${keyRels.map(rel => `• ${sanitize(rel)}`).join('<br>')}</div>`);
  }

  const affinityCfg = window.HLSF?.config?.affinity || {};
  const affinityThreshold = Number.isFinite(affinityCfg.threshold) ? affinityCfg.threshold : 0.35;
  const affinityIterations = Number.isFinite(affinityCfg.iterations) ? affinityCfg.iterations : 8;
  const mentalState = describeAffinityMentalState(affinityThreshold, affinityIterations) || {};

  const localOutputData = generateLocalHlsfOutput(allMatrices, {
    wordLimit: CONFIG.LOCAL_OUTPUT_WORD_LIMIT,
    responseWordLimit: CONFIG.LOCAL_RESPONSE_WORD_LIMIT,
    threshold: affinityThreshold,
    iterations: affinityIterations,
    mentalState,
    topTokens,
    keyRelationships: keyRels,
    inputWordCount: promptWordInfo.wordCount || promptTokens.length,
  });

  let localThought = localOutputData.thoughtText || localOutputData.text || 'Adjacency walk could not assemble a local output with the available data.';
  if (localOutputData.thoughtTrimmed || localOutputData.trimmed) {
    logWarning(`${chunkLabel}: local thought stream truncated to ${CONFIG.LOCAL_OUTPUT_WORD_LIMIT} words.`);
  }
  const thoughtLimited = limitWords(localThought, CONFIG.LOCAL_OUTPUT_WORD_LIMIT);
  if (thoughtLimited.trimmed && !(localOutputData.thoughtTrimmed || localOutputData.trimmed)) {
    logWarning(`${chunkLabel}: local thought stream trimmed to ${CONFIG.LOCAL_OUTPUT_WORD_LIMIT} words.`);
  }
  localThought = thoughtLimited.text;
  const localThoughtWordCount = localOutputData.thoughtWordCount || thoughtLimited.wordCount || countWords(localThought);

  let localOutput = localOutputData.responseText || localThought;
  if (localOutputData.responseTrimmed) {
    logWarning(`${chunkLabel}: local output truncated to ${CONFIG.LOCAL_RESPONSE_WORD_LIMIT} words.`);
  }
  localOutput = DbLexicon.rewriteText(localOutput);
  const localLimited = limitWords(localOutput, CONFIG.LOCAL_RESPONSE_WORD_LIMIT);
  if (localLimited.trimmed && !localOutputData.responseTrimmed) {
    logWarning(`${chunkLabel}: local output trimmed to ${CONFIG.LOCAL_RESPONSE_WORD_LIMIT} words for archival.`);
  }
  localOutput = localLimited.text;
  const responseWasTrimmed = Boolean(localOutputData.responseTrimmed) || localLimited.trimmed;
  const limitedWordCount = localLimited.wordCount ?? countWords(localOutput);
  const localWordCount = responseWasTrimmed
    ? limitedWordCount
    : (typeof localOutputData.responseWordCount === 'number'
      ? localOutputData.responseWordCount
      : limitedWordCount);

  const localResponseTokens = responseWasTrimmed
    ? tokenize(localOutput)
    : (Array.isArray(localOutputData.responseTokens) && localOutputData.responseTokens.length
      ? localOutputData.responseTokens
      : tokenize(localOutput));

  if (localResponseTokens.length) {
    addConversationTokens(localResponseTokens);
    addOutputTokens(localResponseTokens, { render: false });
  }

  let localAdjacency = null;
  let localAdjTargets = [];
  if (localResponseTokens.length) {
    localAdjTargets = await collectSymbolAwareTokens(localOutput, localResponseTokens, `${chunkLabel}-local-output`);
    await hydrateTokensFromKnowledgeStore(localAdjTargets);
    if (localAdjTargets.length) {
      const localAdjStatus = logStatus(`⏳ ${chunkLabel}: caching local HLSF AGI adjacencies`);
      const localAdjStart = performance.now();
      try {
        localAdjacency = await batchFetchAdjacencies(localAdjTargets, localOutput, `${chunkLabel} local response adjacencies`);
        localAdjDuration = performance.now() - localAdjStart;
        localAdjStatus.innerHTML = `✅ ${sanitize(`${chunkLabel}: Local HLSF AGI adjacencies cached`)}`;
      } catch (err) {
        localAdjDuration = performance.now() - localAdjStart;
        localAdjStatus.innerHTML = `❌ ${sanitize(`${chunkLabel}: Local HLSF AGI adjacency cache failed: ${err?.message || err}`)}`;
        logError(`${chunkLabel}: failed to cache local HLSF AGI adjacencies: ${err?.message || err}`);
        localAdjacency = null;
      }
    }
  }

  if (localAdjacency instanceof Map && localAdjacency.size) {
    calculateAttention(localAdjacency);
    localAdjStats = summarizeAdjacencyResults(localAdjacency);
    mergeAdjacencyMaps(allMatrices, localAdjacency);
    calculateAttention(allMatrices);
  }

  const symbolicSeeds = [
    ...promptAdjTokens,
    ...localAdjTargets,
  ].filter(Boolean);

  if (symbolicSeeds.length) {
    const connectivityStatus = logStatus(`⏳ ${chunkLabel}: ensuring symbolic connectivity`);
    try {
      const connectivityResult = await ensureSymbolicAdjacencyConnectivity(
        allMatrices,
        symbolicSeeds,
        chunkLabel,
        promptText,
      );
      if (connectivityResult.updated) {
        topTokens = summarizeAttention(allMatrices);
        keyRels = extractKeyRelationships(allMatrices);
      }
      if (connectivityResult.connectivity?.allSeedsConnected) {
        connectivityStatus.innerHTML = `✅ ${sanitize(`${chunkLabel}: symbolic connectivity satisfied`)}`;
      } else {
        connectivityStatus.innerHTML = `⚠️ ${sanitize(`${chunkLabel}: symbolic connectivity incomplete`)}`;
      }
    } catch (err) {
      connectivityStatus.innerHTML = `❌ ${sanitize(`${chunkLabel}: symbolic connectivity failed`)}${err?.message ? ` (${sanitize(err.message)})` : ''}`;
      console.warn('Symbolic connectivity expansion failed:', err);
    }
  }

  const walkDetails = Array.isArray(localOutputData.walk) && localOutputData.walk.length
    ? localOutputData.walk.map(step => `${sanitize(step.from || '')} → ${sanitize(relDisplay(step.relation || '∼'))} → ${sanitize(step.to || '')} (${Number.isFinite(step.weight) ? step.weight.toFixed(2) : '0.00'})`).join('<br>')
    : '';

  const mentalSummary = [
    mentalState.name ? `<strong>${sanitize(mentalState.name)}</strong>` : '',
    mentalState.desc ? sanitize(mentalState.desc) : '',
    `Threshold ${affinityThreshold.toFixed(2)} · Iterations ${affinityIterations}`,
  ].filter(Boolean).join('<br>');

  const visitedSummary = Array.isArray(localOutputData.visitedTokens) && localOutputData.visitedTokens.length
    ? `<div class="adjacency-insight"><strong>🧠 Traversal tokens:</strong> ${sanitize(localOutputData.visitedTokens.slice(0, 10).join(', '))}</div>`
    : '';

  const safeThought = sanitize(localThought);
  const safeResponse = sanitize(localOutput);

  addLog(`<div class="section-divider"></div>
    <div class="section-title">🧩 ${sanitize(chunkLabel)} Output Suite</div>
    <div class="thought-stream"><strong>Thought stream:</strong> ${safeThought}</div>
    <div class="local-response"><strong>Actual output:</strong> ${safeResponse}</div>
    <div class="adjacency-insight">${mentalSummary}</div>
    ${visitedSummary}
    ${walkDetails ? `<details><summary>Adjacency walk (${localOutputData.walk.length} steps)</summary><div class="adjacency-insight">${walkDetails}</div></details>` : ''}
    <div class="final-output">
      <details open>
        <summary>Local HLSF AGI thought stream (${localThoughtWordCount} words)</summary>
        <pre>${safeThought}</pre>
      </details>
      <details open>
        <summary>Local HLSF AGI chosen response (${localWordCount} words)</summary>
        <pre>${safeResponse}</pre>
      </details>
      <details>
        <summary>Adjacency data sample (${allMatrices.size} tokens)</summary>
        <pre>${JSON.stringify(Array.from(allMatrices.entries()).slice(0, 5), null, 2)}</pre>
      </details>
    </div>
  `);

  let coherenceAssessment = null;
  let coherenceSummary = null;
  if (state.apiKey && localOutput) {
    const db = getDb();
    const dbStats = db?.database_stats || {};
    const databaseSize = Number.isFinite(dbStats.total_tokens)
      ? dbStats.total_tokens
      : (Array.isArray(db?.full_token_data) ? db.full_token_data.length : null);
    const adjacencyLexicon = Array.isArray(localOutputData.visitedTokens)
      ? localOutputData.visitedTokens.slice(0, 24)
      : [];
    const historicalRefinementLexicon = CoherenceStore.getRefinementLexicon({ targetScore: 0.9, maxTokens: 16 });
    const uncachedHistoricalHints = historicalRefinementLexicon.filter(token => token && !adjacencyLexicon.includes(token));
    const coherenceMessages = [
      {
        role: 'system',
        content: 'You evaluate text coherence. Compare the provided local response against adjacency lexicon hints and craft a coherent rewrite. Respond strictly in JSON with keys coherence_score (0-1 float) and coherent_response (string).',
      },
      {
        role: 'user',
        content: `Local response:
${localOutput}

Adjacency lexicon hints:${adjacencyLexicon.length ? ` ${adjacencyLexicon.join(', ')}` : ' (none)'}
Historical refinement hints:${uncachedHistoricalHints.length ? ` ${uncachedHistoricalHints.join(', ')}` : ' (none available)' }
Instructions: Produce a grammatically coherent rewrite that incorporates adjacency hints and, when helpful, the historical refinement hints to fill gaps with coherent replacements. Rate the original response coherence on a 0-1 scale and explain improvements in the rewrite where relevant.`,
      },
    ];
    const rawCoherence = await safeAsync(
      () => callOpenAI(coherenceMessages, { temperature: 0.2, max_tokens: 420 }),
      `${chunkLabel} coherence assessment failed`,
      { fallbackValue: null }
    );
    const parsedCoherence = parseCoherenceEvaluation(rawCoherence);
    if (parsedCoherence) {
      const coherentResponse = typeof parsedCoherence.coherent_response === 'string'
        ? parsedCoherence.coherent_response.trim()
        : '';
      const coherenceScoreValue = Number(parsedCoherence.coherence_score);
      const coherenceScore = Number.isFinite(coherenceScoreValue)
        ? Math.max(0, Math.min(1, coherenceScoreValue))
        : null;
      if (coherenceScore != null) {
        const tokenCount = Array.isArray(localResponseTokens) && localResponseTokens.length
          ? localResponseTokens.length
          : countWords(localOutput);
        CoherenceStore.record({
          timestamp: Date.now(),
          chunkLabel,
          coherenceScore,
          tokenCount,
          databaseSize,
          localResponse: localOutput,
          coherentResponse,
        });
        coherenceSummary = CoherenceStore.summarize(0.99);
      }

      const safeCoherent = sanitize(coherentResponse);
      const scoreLabel = coherenceScore != null ? `${(coherenceScore * 100).toFixed(2)}%` : 'N/A';
      const decimalScoreLabel = coherenceScore != null ? coherenceScore.toFixed(2) : 'N/A';
      const lexiconLabel = adjacencyLexicon.slice(0, 12).join(', ') || 'none';
      const historicalLexiconLabel = uncachedHistoricalHints.slice(0, 12).join(', ') || 'none';
      const summaryLabel = coherenceSummary && coherenceSummary.targetCount
        ? `Avg tokens for ≥0.99 coherence: ${coherenceSummary.targetAverageTokens.toFixed(1)} (${coherenceSummary.targetCount} samples)`
        : 'Collecting samples to estimate tokens for ≥0.99 coherence.';
      const avgScoreLabel = coherenceSummary && coherenceSummary.total
        ? `Offline average coherence: ${coherenceSummary.averageScore.toFixed(2)}`
        : '';
      addLog(`<div class="section-divider"></div>
        <div class="section-title">🧮 Coherence Evaluation</div>
        <div class="adjacency-insight"><strong>Local HLSF AGI coherence score:</strong> ${sanitize(decimalScoreLabel)} (${sanitize(scoreLabel)})<br><strong>Adjacency lexicon:</strong> ${sanitize(lexiconLabel)}<br><strong>Historical refinement lexicon:</strong> ${sanitize(historicalLexiconLabel)}<br>${sanitize(summaryLabel)}${avgScoreLabel ? `<br>${sanitize(avgScoreLabel)}` : ''}</div>
      `);

      coherenceAssessment = {
        score: coherenceScore,
        coherentResponse,
        adjacencyLexicon,
        historicalRefinementLexicon: uncachedHistoricalHints,
        summary: coherenceSummary,
      };
    }
  }

  const metaUnique = Number(chunkMeta.uniqueTokens);
  const fallbackUnique = (() => {
    const uniqueSet = new Set();
    for (const token of chunkTokens) {
      const key = (token == null ? '' : String(token)).toLowerCase();
      if (key) uniqueSet.add(key);
    }
    return uniqueSet.size;
  })();
  const uniqueTokenCount = Number.isFinite(metaUnique) && metaUnique > 0 ? metaUnique : fallbackUnique;

  const metaNew = Number(chunkMeta.newBefore);
  const metaCached = Number(chunkMeta.cachedBefore);
  let newBefore = Number.isFinite(metaNew) && metaNew >= 0 ? metaNew : NaN;
  let cachedBefore = Number.isFinite(metaCached) && metaCached >= 0 ? metaCached : NaN;
  if (!Number.isFinite(newBefore) && Number.isFinite(cachedBefore)) {
    newBefore = Math.max(0, uniqueTokenCount - cachedBefore);
  } else if (!Number.isFinite(cachedBefore) && Number.isFinite(newBefore)) {
    cachedBefore = Math.max(0, uniqueTokenCount - newBefore);
  } else if (!Number.isFinite(cachedBefore) && !Number.isFinite(newBefore)) {
    cachedBefore = 0;
    newBefore = uniqueTokenCount;
  }

  const adjacencyDurationMs = inputAdjDuration + localAdjDuration;
  const adjacencyHits = inputAdjStats.hits + localAdjStats.hits;
  const adjacencyMisses = inputAdjStats.misses + localAdjStats.misses;
  const adjacencyRequests = inputAdjStats.total + localAdjStats.total;
  const totalDurationMs = performance.now() - chunkStart;
  const adjacencyHitRate = adjacencyRequests > 0 ? adjacencyHits / adjacencyRequests : 0;

  return {
    tokens: chunkTokens,
    originalResponse: null,
    localOutput,
    thoughtStream: localThought,
    coherence: coherenceAssessment,
    matrices: allMatrices,
    topTokens,
    keyRelationships: keyRels,
    metrics: {
      durationMs: totalDurationMs,
      adjacencyDurationMs,
      adjacencyHits,
      adjacencyMisses,
      adjacencyRequests,
      adjacencyHitRate,
      uniqueInputTokens: uniqueTokenCount,
      cachedInputTokensBefore: cachedBefore,
      newInputTokensBefore: newBefore,
    },
  };
}

function updateVisualizationAfterChunk(matrices, focusTokens, chunkIndex, totalChunks) {
  if (!(matrices instanceof Map)) return;
  const index = Number.isFinite(chunkIndex) ? Math.max(0, Math.floor(chunkIndex)) : null;
  const total = Number.isFinite(totalChunks) ? Math.max(1, Math.floor(totalChunks)) : null;
  if (focusTokens) {
    const tokenList = focusTokens instanceof Set ? Array.from(focusTokens) : focusTokens;
    if (tokenList && tokenList.length) {
      setDocumentFocusTokens(tokenList);
    }
  }
  rebuildLiveGraph();
  if (index != null && total != null) {
    notifyHlsfAdjacencyChange('document-chunk', {
      immediate: true,
      chunkIndex: index + 1,
      totalChunks: total,
    });
  } else {
    notifyHlsfAdjacencyChange('document-chunk', { immediate: true });
  }
}


async function synthesizeDocumentReflection(chunkResults, aggregateMatrices, focusTokens, docName) {
  calculateAttention(aggregateMatrices);
  const docTopTokens = summarizeAttention(aggregateMatrices);
  const docRelationships = extractKeyRelationships(aggregateMatrices);
  const lexiconSeeds = Array.from(focusTokens).slice(0, 160);
  const chunkSummaries = chunkResults.map((result, idx) => {
    const tops = result.topTokens.slice(0, 5).map(t => `${t.token} (${t.attention.toFixed(2)})`).join(', ') || 'none';
    const rels = result.keyRelationships.slice(0, 4).join('; ') || 'none';
    return `Segment ${idx + 1}: tokens ${tops}; links ${rels}.`;
  }).join('\n');

  let finalReflection = '';
  const reflectionStatus = logStatus('⏳ Building document-scale reflection');
  if (state.apiKey) {
    const messages = [
      { role: 'system', content: 'You craft extensive reflections using cached database language and HLSF adjacency insights.' },
      { role: 'user', content: `Document: ${docName}\nLexicon anchors: ${lexiconSeeds.join(', ')}\nGlobal attention: ${docTopTokens.map(t => `${t.token} (${t.attention.toFixed(2)})`).join(', ')}\nRelationships: ${docRelationships.join('; ')}\nChunk breakdown:\n${chunkSummaries}\nProduce an approximately 1000-token synthesis that traces these relationships, highlights correlated nodes, and concludes with an integrative perspective. Maintain vocabulary from the cached database.` }
    ];
    finalReflection = await safeAsync(
      () => callOpenAI(messages, { temperature: 0.55, max_tokens: 1200 }),
      'Document reflection failed'
    ) || '';
    reflectionStatus.innerHTML = '✅ Document reflection ready';
  } else {
    finalReflection = `Offline document reflection for ${docName}: ${lexiconSeeds.join(' ')}`;
    reflectionStatus.innerHTML = '⚠️ Offline document reflection placeholder';
  }

  finalReflection = DbLexicon.rewriteText(finalReflection);

  if (finalReflection.trim()) {
    const grammarStatus = logStatus('⏳ Polishing reflection for grammar');
    const polishedReflection = await editForCoherence('document reflection', 'document reflection', finalReflection);
    if (!state.apiKey && grammarStatus) {
      grammarStatus.innerHTML = '⚠️ Reflection grammar refinement skipped (offline)';
    } else if (grammarStatus) {
      grammarStatus.innerHTML = '✅ Reflection grammar refinement complete';
    }
    finalReflection = polishedReflection;
  }

  let reflectionTokens = tokenize(finalReflection);
  const tokenCountMsg = `Document reflection tokens (pre-padding): ${reflectionTokens.length}`;
  if (reflectionTokens.length) {
    logOK(tokenCountMsg);
  } else {
    logWarning(tokenCountMsg);
  }

  if (!state.apiKey || reflectionTokens.length < 150) {
    finalReflection = DbLexicon.padToTokenCount(finalReflection, 1000);
    reflectionTokens = tokenize(finalReflection);
  }
  if (reflectionTokens.length) {
    addConversationTokens(reflectionTokens);
    addOutputTokens(reflectionTokens, { render: false });
    const reflectionAdjTokens = await collectSymbolAwareTokens(finalReflection, reflectionTokens, 'document-reflection');
    await hydrateTokensFromKnowledgeStore(reflectionAdjTokens);
    const reflectionAdjacency = await batchFetchAdjacencies(reflectionAdjTokens, finalReflection, 'document reflection adjacencies');
    calculateAttention(reflectionAdjacency);
    if (hasNewAdjacencyData(reflectionAdjacency)) {
      notifyHlsfAdjacencyChange('document-reflection', { immediate: true });
    }
  }
  addLog(`<div class="section-divider"></div><div class="section-title">🧾 Document Reflection</div><div class="thought-stream">${sanitize(finalReflection)}</div>`);
}

async function warmDocumentIngestion(chunks, options = {}) {
  const config = (options && typeof options === 'object') ? options : {};
  const estimator = config.estimator && typeof config.estimator.recordWarmup === 'function'
    ? config.estimator
    : null;

  const tokenSet = new Set();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!Array.isArray(chunk) || !chunk.length) continue;
    for (const token of chunk) {
      if (!token) continue;
      tokenSet.add(String(token));
    }
  }

  const uniqueTokens = Array.from(tokenSet).filter(Boolean);
  if (!uniqueTokens.length) return null;

  const warmupStatus = logStatus('⏳ Prewarming document cache…');
  const start = performance.now();

  let cachedBefore = 0;
  const toWarm = [];
  for (const token of uniqueTokens) {
    if (isTokenCached(token)) {
      cachedBefore += 1;
    } else {
      toWarm.push(token);
    }
  }

  let stagedFromDb = 0;
  const dbIndex = toWarm.length ? buildDbRecordIndexMap() : new Map();
  if (toWarm.length && dbIndex.size) {
    CacheBatch.begin({ snapshot: getCachedTokenCount() });
    try {
      for (const token of toWarm) {
        const key = typeof token === 'string' ? token.toLowerCase() : '';
        if (!key || !dbIndex.has(key)) continue;
        const record = dbIndex.get(key);
        if (record && stageDbRecordForCache(record)) stagedFromDb += 1;
      }
    } finally {
      CacheBatch.end();
    }
  }

  let remoteHits = 0;
  let remoteLoads = 0;
  const remote = window.HLSF?.remoteDb;
  if (toWarm.length
    && remote
    && typeof remote.isReady === 'function'
    && remote.isReady()
    && typeof remote.preloadTokens === 'function') {
    try {
      const stats = await remote.preloadTokens(toWarm);
      remoteHits = Number(stats?.hits) || 0;
      remoteLoads = Number(stats?.loaded) || 0;
    } catch (err) {
      console.warn('Document warmup remote preload failed:', err);
    }
  }

  const elapsed = performance.now() - start;
  const summaryParts = [];
  if (cachedBefore > 0) summaryParts.push(`${cachedBefore} cached tokens`);
  if (stagedFromDb > 0) summaryParts.push(`${stagedFromDb} staged from DB`);
  if (remoteLoads + remoteHits > 0) {
    summaryParts.push(`${remoteLoads} remote loads`);
    summaryParts.push(`${remoteHits} remote hits`);
  }

  if (warmupStatus) {
    const duration = formatDuration(elapsed);
    const summary = summaryParts.length
      ? summaryParts.map(part => sanitize(part)).join(' · ')
      : sanitize('No additional warmup required');
    warmupStatus.innerHTML = `✅ Document cache warmed in ${sanitize(duration)} • ${summary}`;
  }

  if ((stagedFromDb + remoteLoads + remoteHits) > 0) {
    notifyHlsfAdjacencyChange('document-warmup', { immediate: true });
  }

  if (estimator) {
    try {
      estimator.recordWarmup({
        uniqueTokens: uniqueTokens.length,
        cachedBefore,
        stagedFromDb,
        remoteHits,
        remoteLoads,
        durationMs: elapsed,
      });
    } catch (err) {
      console.warn('Document warmup estimator update failed:', err);
    }
  }

  return {
    uniqueTokens: uniqueTokens.length,
    cachedBefore,
    stagedFromDb,
    remoteHits,
    remoteLoads,
    durationMs: elapsed,
  };
}

async function processDocumentFile(file) {
  if (!enterProcessingState()) return;
  let estimator = null;
  let wasCancelled = false;
  let exitStatus: 'success' | 'cancelled' | 'failed' = 'success';
  try {
    let hasDatabase = !!getDb();
    if (!hasDatabase) {
      const loaded = await tryBootstrapDb();
      hasDatabase = !!loaded;
    }
    if (!hasDatabase) {
      logWarning('No cached database detected. Proceeding with empty lexicon.');
    }

    const text = await DocumentReaders.extract(file);
    if (currentAbortController?.signal.aborted) throw new Error('AbortError');
    const chunkDimension = Number(CONFIG.DOCUMENT_CHUNK_SIZE) || 8;
    const chunkInfo = buildDocumentChunks(text, chunkDimension);
    const { chunks, totalTokens, rawTokenCount } = chunkInfo;

    if (!rawTokenCount) {
      logError('Document contained no readable tokens.');
      exitProcessingState({ preserveInput: true, status: 'failed', statusMessage: 'Processing halted' });
      return;
    }

    if (!chunks.length || !totalTokens) {
      logError('Unable to align document tokens with cached database vocabulary.');
      exitProcessingState({ preserveInput: true, status: 'failed', statusMessage: 'Processing halted' });
      return;
    }

    addLog(`📥 Processing <strong>${sanitize(file.name || 'document')}</strong> (${totalTokens} tokens → ${chunks.length} segment${chunks.length === 1 ? '' : 's'} · ≤ ${chunkDimension} unique tokens each)`);

    const cachedTokenBaseline = Number.isFinite(state.documentCacheBaseline)
      ? state.documentCacheBaseline
      : getCachedTokenCount();
    const cachedSeedTokens = listCachedTokens(CONFIG.CACHE_SEED_LIMIT || 0);
    estimator = new DocumentReadEstimator(chunks, {
      cachedTokenBaseline,
      seedTokens: cachedSeedTokens,
      seedLimit: CONFIG.CACHE_SEED_LIMIT,
    });
    const etaStatus = logStatus('⏳ Document ETA initializing…');
    estimator.setStatusElement(etaStatus);

    await warmDocumentIngestion(chunks, {
      estimator,
    });

    const aggregateMatrices = new Map();
    const focusTokens = new Set();
    const chunkResults = [];

    let cancelledMidway = false;
    const levelDimension = Math.max(1, Number(CONFIG.DOCUMENT_CHUNK_SIZE) || 1);
    for (let levelStart = 0; levelStart < chunks.length; levelStart += levelDimension) {
      if (currentAbortController?.signal.aborted) {
        logWarning('Document processing cancelled.');
        cancelledMidway = true;
        exitStatus = 'cancelled';
        break;
      }

      const levelChunks = chunks.slice(levelStart, levelStart + levelDimension);
      const levelIndex = Math.floor(levelStart / levelDimension) + 1;
      for (let offset = 0; offset < levelChunks.length; offset++) {
        if (currentAbortController?.signal.aborted) {
          logWarning('Document processing cancelled.');
          cancelledMidway = true;
          exitStatus = 'cancelled';
          break;
        }

        const chunkIndex = levelStart + offset;
        const chunk = levelChunks[offset];
        chunk.forEach(token => focusTokens.add(token));
        commitTokens(chunk, { render: false });
        addConversationTokens(chunk);
        const chunkMeta = estimator ? estimator.prepareChunk(chunkIndex, chunk) : {};
        if (!chunkMeta.documentName) {
          chunkMeta.documentName = file?.name || 'document';
        }
        const result = await analyzeDocumentChunk(chunk, chunkIndex, chunks.length, chunkMeta);
        if (result) {
          chunkResults.push(result);
          mergeAdjacencyMaps(aggregateMatrices, result.matrices);
          if (estimator) estimator.recordChunk(chunkIndex, result.metrics || {}, chunkMeta);
          updateVisualizationAfterChunk(aggregateMatrices, focusTokens, chunkIndex, chunks.length);
        }
      }

      if (cancelledMidway || currentAbortController?.signal.aborted) {
        break;
      }

      logOK(`HLSF level ${levelIndex} consolidated (${levelChunks.length} segment${levelChunks.length === 1 ? '' : 's'}).`);
    }

    if (cancelledMidway) {
      wasCancelled = true;
      exitStatus = 'cancelled';
      estimator?.markCancelled();
    }

    if (!cancelledMidway && currentAbortController?.signal.aborted) {
      wasCancelled = true;
      exitStatus = 'cancelled';
      estimator?.markCancelled();
    }

    if (!chunkResults.length) {
      exitStatus = 'failed';
      exitProcessingState({ preserveInput: true, status: 'failed', statusMessage: 'Processing halted' });
      return;
    }

    setDocumentFocusTokens(focusTokens);
    rebuildLiveGraph();
    notifyHlsfAdjacencyChange('document-read', { immediate: true });

    if (!currentAbortController?.signal.aborted) {
      await synthesizeDocumentReflection(chunkResults, aggregateMatrices, focusTokens, file.name || 'document');
    }

    if (!wasCancelled) {
      estimator?.complete();
    }

    logOK('Document ingestion complete');
  } catch (err) {
    if (err?.name === 'AbortError' || err?.message === 'AbortError') {
      wasCancelled = true;
      exitStatus = 'cancelled';
      logWarning('Document ingestion cancelled');
    } else {
      wasCancelled = true;
      exitStatus = 'failed';
      logError(err?.message || 'Document ingestion failed');
      console.error(err);
    }
  } finally {
    if (wasCancelled) {
      estimator?.markCancelled();
    }
    const finalSnapshot = getCachedTokenCount();
    const existingBaseline = getDocumentCacheBaseline();
    if (Number.isFinite(finalSnapshot)) {
      const snapshotValue = Math.max(0, finalSnapshot);
      setDocumentCacheBaseline(Math.max(existingBaseline, snapshotValue));
    } else {
      setDocumentCacheBaseline(existingBaseline);
    }
    updateStats();
    const summary = exitStatus === 'failed'
      ? 'Processing failed'
      : exitStatus === 'cancelled'
        ? 'Processing cancelled'
        : 'Processing complete';
    exitProcessingState({ preserveInput: true, status: exitStatus, statusMessage: summary });
  }
}

// ============================================
// EVENTS
// ============================================
function showApiModal() {
  const modal = elements.apiModal;
  if (!(modal instanceof HTMLElement)) return;
  modal.classList.remove('hidden');
  setTimeout(() => {
    const input = elements.apiKeyInput;
    if (input instanceof HTMLElement) {
      input.focus();
    }
  }, 80);
}

function applyApiKeyFromModal() {
  const input = elements.apiKeyInput;
  if (!(input instanceof HTMLInputElement)) {
    logError('API key input not available');
    return;
  }
  const key = input.value.trim();
  if (!isValidApiKey(key)) {
    logError('Invalid API key format');
    return;
  }
  state.apiKey = key.trim();
  const persisted = safeStorageSet(API_KEY_STORAGE_KEY, state.apiKey);
  const modal = elements.apiModal;
  if (modal instanceof HTMLElement) {
    modal.classList.add('hidden');
  }
  if (!persisted) {
    logWarning('API key configured but not saved to storage');
  }
  logOK('API key configured');
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof HTMLElement ? event.target.closest('.command-upgrade-link') : null;
  if (!target) return;
  event.preventDefault();
  if (window.CognitionEngine && typeof window.CognitionEngine.openLanding === 'function') {
    window.CognitionEngine.openLanding('signup');
  } else {
    document.body.classList.add('onboarding-active');
  }
});

async function submitPromptThroughEngine(
  input,
  options: { annotateLog?: boolean; source?: 'input-field' | 'voice' } = {},
) {
  const raw = typeof input === 'string' ? input : String(input ?? '');
  const trimmed = raw.trim();
  if (!trimmed) {
    return { success: false, tokens: [], kind: 'prompt', error: new Error('Prompt cannot be empty') };
  }

  const annotate = Boolean(options?.annotateLog);
  const source = options?.source === 'voice' ? 'voice' : 'input-field';
  const isCmd = isCommand(trimmed);
  let committedTokens = [];
  if (!isCmd) {
    committedTokens = commitInputTokensFromText(raw, { source, render: false });
  }

  setInputPreviewTokens([], { render: false });
  rebuildLiveGraph();
  addLog(`${annotate ? '🎤' : '&gt;'} ${sanitize(trimmed)}`);

  if (isCmd) {
    await handleCommand(trimmed);
    return { success: true, tokens: committedTokens, kind: 'command' as const };
  }

  try {
    onUserPromptSubmitted(trimmed);
    await processPrompt(trimmed);
    return { success: true, tokens: committedTokens, kind: 'prompt' as const };
  } catch (error) {
    if (source === 'voice') {
      return { success: false, tokens: committedTokens, kind: 'prompt' as const, error };
    }
    throw error;
  }
}

autonomousAgent = new AutonomousAgent({
  intervalMs: 60000,
  vectorStore: vectorSemanticStore,
  runPrompt: async (prompt: string) => {
    await submitPromptThroughEngine(prompt, { source: 'input-field' });
  },
  getContext: () => ({
    isProcessing: state.isProcessing === true,
    lastAdjacency: ensureLocalHlsfMemory()?.lastAdjacency ?? null,
  }),
  log: (message: string, level: 'info' | 'warning' | 'error' = 'info') => {
    if (level === 'error') {
      logError(message);
    } else if (level === 'warning') {
      logWarning(message);
    } else {
      addLog(message);
    }
  },
});

if (typeof window !== 'undefined') {
  const root = (window.CognitionEngine = window.CognitionEngine || {});
  root.agent = {
    start: () => autonomousAgent?.start(),
    stop: () => autonomousAgent?.stop(),
    isRunning: () => autonomousAgent?.isRunning() ?? false,
  };
}

async function submitVoiceModelPrompt(input, options: { annotateLog?: boolean } = {}) {
  return submitPromptThroughEngine(input, { annotateLog: options?.annotateLog, source: 'voice' });
}

// ============================================
// INIT
// ============================================
window.addEventListener('beforeunload', () => {
  state.apiKey = '';
  stopHLSFAnimation();
});

function bindHlsfControls(container: HTMLElement | null): void {
  const root = container instanceof HTMLElement
    ? container
    : document.getElementById('hlsf-canvas-container');

  if (!(root instanceof HTMLElement)) {
    return;
  }

  if (root.dataset.hlsfControlsBound === 'true') {
    syncHlsfControls(root);
    return;
  }

  root.dataset.hlsfControlsBound = 'true';
  syncHlsfControls(root);
}

function syncHlsfControls(container: HTMLElement | null): void {
  const root = container instanceof HTMLElement
    ? container
    : document.getElementById('hlsf-canvas-container');

  if (!(root instanceof HTMLElement)) {
    return;
  }

  const hlsf = (window as any).HLSF;
  const config = hlsf?.config ?? null;
  if (!config) {
    return;
  }

  const ownerDocument = root.ownerDocument ?? document;

  const updateNumericControl = (
    inputId: string,
    valueId: string,
    rawValue: unknown,
    options: { digits?: number } = {},
  ) => {
    const input = ownerDocument.getElementById(inputId) as HTMLInputElement | null;
    if (!input) return;
    const digits = options.digits ?? (input.type === 'range' ? 2 : 0);
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    const formatted = digits > 0 ? numeric.toFixed(digits) : String(Math.round(numeric));
    if (input.value !== formatted) {
      input.value = formatted;
    }
    const valueEl = ownerDocument.getElementById(valueId) as HTMLElement | null;
    if (valueEl) {
      valueEl.textContent = formatted;
    }
  };

  updateNumericControl('hlsf-rotation-speed', 'hlsf-speed-val', config.rotationOmega, { digits: 2 });
  updateNumericControl('hlsf-alpha', 'hlsf-alpha-val', config.alpha, { digits: 2 });
  updateNumericControl('hlsf-node-size', 'hlsf-node-size-val', config.nodeSize, { digits: 1 });

  const affinity = (config.affinity ?? {}) as { threshold?: unknown; iterations?: unknown };
  updateNumericControl('hlsf-aff-thresh', 'hlsf-aff-thresh-val', affinity.threshold, { digits: 2 });
  updateNumericControl('hlsf-aff-iters', 'hlsf-aff-iters-val', affinity.iterations, { digits: 0 });

  const updateIntegerField = (inputId: string, valueId: string, rawValue: unknown) => {
    const input = ownerDocument.getElementById(inputId) as HTMLInputElement | null;
    if (!input) return;
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    const formatted = String(Math.round(numeric));
    if (input.value !== formatted) {
      input.value = formatted;
    }
    const valueEl = ownerDocument.getElementById(valueId) as HTMLElement | null;
    if (valueEl) {
      valueEl.textContent = formatted;
    }
  };

  const relationCap = getRelationTypeCap();
  if (Number.isFinite(relationCap)) {
    updateIntegerField('hlsf-relation-cap', 'hlsf-relation-cap-val', relationCap);
  }

  const edgesPerType = getEdgesPerType();
  if (Number.isFinite(edgesPerType)) {
    updateIntegerField('hlsf-edges-per-type', 'hlsf-edges-per-type-val', edgesPerType);
  }

  const syncSelectValue = (id: string, desired: unknown) => {
    if (typeof desired !== 'string' || !desired) return;
    const select = ownerDocument.getElementById(id) as HTMLSelectElement | null;
    if (!select) return;
    const normalized = desired.toLowerCase();
    for (const option of Array.from(select.options)) {
      if (option.value.toLowerCase() === normalized) {
        if (select.value !== option.value) {
          select.value = option.value;
        }
        break;
      }
    }
  };

  syncSelectValue('hlsf-edge-color-mode', config.edgeColorMode);
  syncSelectValue('hlsf-layout', config.layout);

  const setToggleState = (id: string, active: boolean, onLabel: string, offLabel: string) => {
    const button = ownerDocument.getElementById(id) as HTMLButtonElement | null;
    if (!button) return;
    button.textContent = active ? onLabel : offLabel;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  };

  setToggleState('hlsf-toggle-edges', config.showEdges !== false, 'Edges: On', 'Edges: Off');
  setToggleState('hlsf-toggle-labels', config.showLabels !== false, 'Labels: On', 'Labels: Off');
  setToggleState('hlsf-toggle-glow', config.showNodeGlow === true, 'Glow: On', 'Glow: Off');
  setToggleState('hlsf-toggle-bg', config.whiteBg === true, 'BG: Light', 'BG: Dark');
  setToggleState('hlsf-toggle-emergent', config.emergentActive === true, 'Stop Emergence', 'Start Emergence');

  const adjacencyButton = ownerDocument.getElementById('hlsf-toggle-adjacency') as HTMLButtonElement | null;
  if (adjacencyButton) {
    const expanded = isAdjacencyExpansionEnabled();
    adjacencyButton.textContent = expanded ? 'Adjacency: Expanded' : 'Adjacency: Compact';
    adjacencyButton.setAttribute('aria-pressed', expanded ? 'true' : 'false');
  }

  const affinitySummary = ownerDocument.getElementById('hlsf-affinity-summary') as HTMLElement | null;
  if (affinitySummary) {
    const threshold = Number(affinity.threshold);
    const iterations = Number(affinity.iterations);
    if (Number.isFinite(threshold) || Number.isFinite(iterations)) {
      const parts: string[] = [];
      if (Number.isFinite(threshold)) {
        parts.push(`threshold ${threshold.toFixed(2)}`);
      }
      if (Number.isFinite(iterations)) {
        parts.push(`iterations ${Math.round(iterations)}`);
      }
      affinitySummary.textContent = `Current mental state: ${parts.join(', ')}`;
    }
  }
}

async function initialize() {
  let cachedCount = getCachedTokenCount();
  if (Number.isFinite(cachedCount)) {
    const currentBaseline = getDocumentCacheBaseline();
    setDocumentCacheBaseline(Math.max(currentBaseline, Math.max(0, cachedCount)));
  } else {
    cachedCount = 0;
    setDocumentCacheBaseline(Math.max(0, getDocumentCacheBaseline()));
  }
  updateStats();
  printStartupBanner();

  const hlsfWrapper = document.getElementById('hlsf-canvas-container');
  if (hlsfWrapper) {
    bindHlsfControls(hlsfWrapper);
    syncHlsfControls(hlsfWrapper);
    showVisualizer();
  }

  voiceDockController = initializeVoiceModelDock({
    submitPrompt: (text, opts) => submitVoiceModelPrompt(text, opts),
    userAvatar: userAvatarStore,
    onTokensCommitted: (tokens, context) => {
      try {
        const voiceApi = window.CognitionEngine?.voice;
        if (voiceApi?.recordVoiceTokens) {
          const payloadTokens = Array.isArray(tokens) ? tokens : [];
          voiceApi.recordVoiceTokens(payloadTokens, {
            source: 'voice-model',
            prompt: context?.prompt || '',
            capturedAt: new Date().toISOString(),
            kind: context?.kind,
          });
        }
      } catch (err) {
        console.warn('Voice data capture from voice model failed:', err);
      }
      try {
        signalVoiceCloneTokensChanged('voice-model');
      } catch (err) {
        console.warn('Voice model token signal failed:', err);
      }
    },
  });

  const storedKey = safeStorageGet(API_KEY_STORAGE_KEY, '');
  if (isValidApiKey(storedKey)) {
    state.apiKey = storedKey.trim();
    if (elements.apiKeyInput instanceof HTMLInputElement) {
      elements.apiKeyInput.value = state.apiKey;
    }
    if (elements.apiModal instanceof HTMLElement) {
      elements.apiModal.classList.add('hidden');
    }
    logOK('Loaded stored API key');
  } else if (storedKey) {
    safeStorageRemove(API_KEY_STORAGE_KEY);
  }

  const bootstrapped = await cmd_load(['-remotedir'], { interactive: false });
  const dbAvailable = bootstrapped || !!getDb();
  scheduleRemoteCacheWarmup({ reason: 'initialize' });

  cachedCount = getCachedTokenCount();
  if (Number.isFinite(cachedCount)) {
    const currentBaseline = getDocumentCacheBaseline();
    setDocumentCacheBaseline(Math.max(currentBaseline, Math.max(0, cachedCount)));
  } else {
    cachedCount = 0;
  }
  updateStats();

  addLog(`<strong>🧠 HLSF Cognition Engine v2.0</strong><br><br>
    This engine performs:<br>
    1. Token adjacency mapping (50 relationship types)<br>
    2. Attention score calculation<br>
    3. Emergent thought stream synthesis<br>
    4. Response refinement based on insights<br>
    5. <strong>Symbolic glyph encryption</strong> (complex number encoding)<br>
    6. <strong>HLSF visualization</strong> (hierarchical semantic framework)<br><br>
    <strong>Commands:</strong> /help, /hlsf, /read, /ingest, /glyph, /encrypt, /decrypt<br>
    <br><strong>SaaS:</strong> Hosted workspace features are available. Use /signup to create a profile.<br>
    ${cachedCount > 0 ? `<br>✅ Loaded with ${cachedCount} cached tokens` : ''}
    <br><small>⚠️ Note: Download HTML and run locally for API calls to work.</small>
  `);

  const hasHlsfData = dbAvailable || cachedCount > 0;
  if (hasHlsfData) {
    announceDatabaseReady('startup');
  }

  initializeVoiceClonePanel();
  if (elements.input instanceof HTMLElement) {
    elements.input.focus();
  }
}

window.addEventListener('load', () => {
  tryBootstrapDb();
});

function runAfterDomReady(task: () => void): void {
  if (typeof document === 'undefined') {
    task();
    return;
  }
  if (document.readyState === 'loading') {
    const invoke = () => {
      document.removeEventListener('DOMContentLoaded', invoke);
      task();
    };
    document.addEventListener('DOMContentLoaded', invoke);
    return;
  }
  task();
}

runAfterDomReady(() => {
  hydrateAppElements(document);
  bindCoreUiEvents();
  setupLandingExperience();
  void initialize();
});


/* ===== HLSF limit controls wiring ===== */
(function initHlsfLimitControls(){
  try {
    const root = document;
    const perfSel = root.getElementById('hlsf-performance') as HTMLSelectElement | null;
    const maxNodes = root.getElementById('hlsf-max-nodes') as HTMLInputElement | null;
    const maxEdges = root.getElementById('hlsf-max-edges') as HTMLInputElement | null;
    const maxRel = root.getElementById('hlsf-max-rel') as HTMLInputElement | null;
    const prune = root.getElementById('hlsf-prune-thresh') as HTMLInputElement | null;
    const pruneVal = root.getElementById('hlsf-prune-thresh-val') as HTMLElement | null;

    const PRESETS = PERFORMANCE_PROFILES;

    function applyHlsfLimitsFromControls(options = {}) {
      const forceDefaults = Boolean(options && options.forceDefaults);
      const cfg = (window as any).SETTINGS || ((window as any).SETTINGS = {});
      const selectedId = perfSel ? perfSel.value.toLowerCase() : String(cfg.performanceProfileId || '').toLowerCase();
      const profile = resolvePerformanceProfile(selectedId || cfg.performanceProfileId);
      cfg.performanceProfileId = profile.id;
      cfg.branchingFactor = profile.branchingFactor;

      if (perfSel && perfSel.value.toLowerCase() !== profile.id) {
        perfSel.value = profile.id;
      }

      const resolveNumericInput = (input, fallback) => {
        if (!input) return fallback;
        if (forceDefaults) {
          input.value = String(fallback);
          return fallback;
        }
        if (!input.value) input.value = String(fallback);
        const value = Number(input.value);
        return Number.isFinite(value) ? value : fallback;
      };

      cfg.maxNodes = resolveNumericInput(maxNodes, profile.maxNodes);
      cfg.maxEdges = resolveNumericInput(maxEdges, profile.maxEdges);
      cfg.maxRelationships = resolveNumericInput(maxRel, profile.maxRelationships);
      const profileRelationTypes = Math.max(50, profile.maxRelationTypes);
      cfg.maxRelationTypes = profileRelationTypes;
      if (prune) {
        if (forceDefaults) {
          prune.value = String(profile.pruneWeightThreshold);
        } else if (!prune.value) {
          prune.value = String(profile.pruneWeightThreshold);
        }
        cfg.pruneWeightThreshold = Number(prune.value || profile.pruneWeightThreshold);
      } else {
        cfg.pruneWeightThreshold = profile.pruneWeightThreshold;
      }
      if (pruneVal) pruneVal.textContent = Number(cfg.pruneWeightThreshold).toFixed(2);

      applyPerformanceCaps(cfg);
      try {
        notifyHlsfAdjacencyChange('performance-profile-change', { immediate: true });
      } catch (err) {
        console.warn('Unable to refresh HLSF after profile update:', err);
      }
    }

    perfSel?.addEventListener('change', () => applyHlsfLimitsFromControls({ forceDefaults: true }));
    maxNodes?.addEventListener('change', applyHlsfLimitsFromControls);
    maxEdges?.addEventListener('change', applyHlsfLimitsFromControls);
    maxRel?.addEventListener('change', applyHlsfLimitsFromControls);
    prune?.addEventListener('input', applyHlsfLimitsFromControls);

    // initialize on load
    applyHlsfLimitsFromControls({ forceDefaults: true });
    (window as any).applyHlsfLimitsFromControls = applyHlsfLimitsFromControls;
  } catch (err) {
    console.warn('HLSF limit controls init failed:', err);
  }
})();

