import type { EmbeddingProvider } from './provider-types';
import type { VectorConfig } from '../types';

function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = Math.imul(31, hash) + token.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

export class Word2VecOnline implements EmbeddingProvider {
  private _dim = 0;
  private initialized = false;

  async init(cfg: VectorConfig): Promise<void> {
    this._dim = Math.max(1, Math.floor(cfg.dim || 128));
    this.initialized = true;
  }

  name(): string {
    return 'word2vec';
  }

  dim(): number {
    return this._dim;
  }

  async embedTokens(tokens: string[]): Promise<Float32Array[]> {
    if (!this.initialized) {
      throw new Error('Word2VecOnline used before init');
    }
    return tokens.map(token => {
      const vector = new Float32Array(this._dim);
      let seed = hashToken(token) + this._dim;
      for (let i = 0; i < this._dim; i += 1) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        vector[i] = ((seed % 1000) / 1000) - 0.5;
      }
      return vector;
    });
  }

  async trainPairs(): Promise<void> {
    // Training is a no-op in the stub implementation.
  }
}
