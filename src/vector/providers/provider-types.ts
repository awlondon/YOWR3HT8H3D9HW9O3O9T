import type { VectorConfig } from '../types';

export interface EmbeddingProvider {
  name(): string;
  dim(): number;
  init(config: VectorConfig): Promise<void>;
  embedTokens(tokens: string[]): Promise<Float32Array[]>;
  trainPairs?(pairs: Array<[string, string]>, epochs?: number): Promise<void>;
}
