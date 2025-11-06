export type VectorProviderName = 'onnx' | 'word2vec' | 'api';
export type Device = 'wasm' | 'webgpu' | 'webgl';

export interface VectorConfig {
  provider: VectorProviderName;
  dim: number;
  device?: Device;
  quantize8?: boolean;
  normalize?: boolean;
  batchSize?: number;
  index: {
    type: 'flat' | 'ivf' | 'hnsw';
    trainK?: number;
  };
}

export type TokenId = number;
export type Embedding = Float32Array;
export type QEmbedding = { q: Uint8Array; scale: number; zero: number };

export interface SimilarResult {
  id: TokenId;
  score: number;
}

export interface HybridExpandOptions {
  tokenId: TokenId;
  topK: number;
  alpha?: number;
  beta?: number;
  minWeight?: number;
  types?: number[];
}
