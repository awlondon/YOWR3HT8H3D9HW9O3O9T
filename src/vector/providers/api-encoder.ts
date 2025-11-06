import type { EmbeddingProvider } from './provider-types';
import type { VectorConfig } from '../types';

export class ApiEncoder implements EmbeddingProvider {
  private _dim = 0;
  private initialized = false;

  async init(cfg: VectorConfig): Promise<void> {
    this._dim = Math.max(1, Math.floor(cfg.dim || 384));
    this.initialized = true;
  }

  name(): string {
    return 'api';
  }

  dim(): number {
    return this._dim;
  }

  async embedTokens(tokens: string[]): Promise<Float32Array[]> {
    if (!this.initialized) {
      throw new Error('ApiEncoder used before init');
    }
    return tokens.map(() => new Float32Array(this._dim));
  }
}
