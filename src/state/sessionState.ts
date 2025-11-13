import type { SaasPlatform } from '../features/saas/platform';
import { MEMBERSHIP_LEVELS, type MembershipLevel } from './membership';

export interface SessionStats {
  totalApiCalls: number;
  totalCacheHits: number;
  totalCostUsd: number;
}

export interface SessionSymbolMetrics {
  history: unknown[];
  last: unknown;
  lastRunGraph: unknown;
  topNodes: unknown[];
  lastTokens: unknown[];
  lastPipeline: unknown;
}

export interface SessionState {
  apiKey: string;
  isProcessing: boolean;
  processingStatus: string | null;
  processingStart: number;
  processingAverageMs: number;
  processingSamples: number;
  sessionStats: SessionStats;
  saas: SaasPlatform | null;
  hlsfReady: boolean;
  tokenSources: Map<string, unknown>;
  tokenOrder: string[];
  liveGraph: {
    nodes: Map<string, unknown>;
    links: unknown[];
  };
  liveGraphMode: boolean;
  liveGraphUpdateTimer: ReturnType<typeof setTimeout> | null;
  documentCacheBaseline: number;
  documentCacheBaselineManuallyCleared: boolean;
  networkOffline: boolean;
  networkErrorNotified: boolean;
  lastNetworkErrorTime: number;
  lastComputedCacheBase: number;
  pendingPromptReviews: Map<string, unknown>;
  symbolMetrics: SessionSymbolMetrics;
  membership: {
    level: MembershipLevel;
    name: string;
    email: string;
    plan: string | null;
    trial: boolean;
    demoMode: string;
  };
}

export const sessionState: SessionState = {
  apiKey: '',
  isProcessing: false,
  processingStatus: null,
  processingStart: 0,
  processingAverageMs: 0,
  processingSamples: 0,
  sessionStats: {
    totalApiCalls: 0,
    totalCacheHits: 0,
    totalCostUsd: 0,
  },
  saas: null,
  hlsfReady: false,
  tokenSources: new Map(),
  tokenOrder: [],
  liveGraph: { nodes: new Map(), links: [] },
  liveGraphMode: true,
  liveGraphUpdateTimer: null,
  documentCacheBaseline: 0,
  documentCacheBaselineManuallyCleared: false,
  networkOffline: false,
  networkErrorNotified: false,
  lastNetworkErrorTime: 0,
  lastComputedCacheBase: 0,
  pendingPromptReviews: new Map(),
  symbolMetrics: {
    history: [],
    last: null,
    lastRunGraph: null,
    topNodes: [],
    lastTokens: [],
    lastPipeline: null,
  },
  membership: {
    level: MEMBERSHIP_LEVELS.DEMO,
    name: '',
    email: '',
    plan: null,
    trial: true,
    demoMode: 'api',
  },
};

export type { MembershipLevel } from './membership';
