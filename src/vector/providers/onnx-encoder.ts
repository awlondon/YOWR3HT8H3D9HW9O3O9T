import type { EmbeddingProvider } from './provider-types';
import type { VectorConfig } from '../types';

function hashToVector(text: string, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let seed = 2166136261 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  for (let i = 0; i < dim; i += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    out[i] = ((seed % 2000) / 1000) - 1;
  }
  return out;
}

export class OnnxEncoder implements EmbeddingProvider {
  private _dim = 384;
  private initialized = false;
  private backend: VectorConfig['device'];

  async init(cfg: VectorConfig): Promise<void> {
    if (cfg.dim && Number.isFinite(cfg.dim) && cfg.dim > 0) {
      this._dim = Math.floor(cfg.dim);
    }
    this.backend = cfg.device;
    this.initialized = true;
  }

  name(): string {
    return 'onnx';
  }

  dim(): number {
    return this._dim;
  }

  async embedTokens(tokens: string[]): Promise<Float32Array[]> {
    if (!this.initialized) {
      throw new Error('OnnxEncoder used before init');
    }
    return tokens.map(token => hashToVector(token, this._dim));
  }
}
