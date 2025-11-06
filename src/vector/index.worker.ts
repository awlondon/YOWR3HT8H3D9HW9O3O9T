/// <reference lib="webworker" />

import { OnnxEncoder } from './providers/onnx-encoder';
import { Word2VecOnline } from './providers/word2vec-online';
import { ApiEncoder } from './providers/api-encoder';
import type { EmbeddingProvider } from './providers/provider-types';
import type { VectorConfig } from './types';

let provider: EmbeddingProvider | null = null;

interface WorkerMessage<T = unknown> {
  id: number;
  op: 'init' | 'embed' | 'train';
  payload: T;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: any;
  error?: string;
}

function pickProvider(name: VectorConfig['provider']): EmbeddingProvider {
  switch (name) {
    case 'onnx':
      return new OnnxEncoder();
    case 'word2vec':
      return new Word2VecOnline();
    case 'api':
      return new ApiEncoder();
    default:
      throw new Error(`Unsupported provider: ${name}`);
  }
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { id, op, payload } = event.data;
  const respond = (response: WorkerResponse, transfers?: Transferable[]) => {
    (self as unknown as Worker).postMessage(response, transfers ?? []);
  };

  try {
    switch (op) {
      case 'init': {
        const cfg = (payload as { cfg: VectorConfig }).cfg;
        provider = pickProvider(cfg.provider);
        await provider.init(cfg);
        respond({ id, ok: true, result: { dim: provider.dim(), name: provider.name() } });
        break;
      }
      case 'embed': {
        if (!provider) throw new Error('Provider not initialised');
        const tokens = (payload as { tokens: string[] }).tokens;
        const vectors = await provider.embedTokens(tokens);
        const buffers = vectors.map(vec => vec.buffer.slice(0));
        respond(
          { id, ok: true, result: { vecs: buffers, dim: provider.dim() } },
          buffers as unknown as Transferable[],
        );
        break;
      }
      case 'train': {
        if (!provider) throw new Error('Provider not initialised');
        const { pairs, epochs } = payload as { pairs: Array<[string, string]>; epochs?: number };
        if (provider.trainPairs) {
          await provider.trainPairs(pairs, epochs);
        }
        respond({ id, ok: true, result: { ok: true } });
        break;
      }
      default:
        throw new Error(`Unknown op: ${op}`);
    }
  } catch (error: any) {
    respond({ id, ok: false, error: error?.message ?? String(error) });
  }
};

export {};
