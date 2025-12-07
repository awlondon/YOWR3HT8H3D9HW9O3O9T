import { computeSpectralFeatures } from './spectralUtils.js';
import { type HLSFGraph, type RotationEvent, type RotationOptions, type SpectralFeatures } from './emergentThoughtTypes.js';

let rotationActive = false;

/**
 * Streams rotation updates for a given HLSF graph. This is UI-agnostic and
 * simply emits geometric and spectral snapshots for consumers. (HLSF step 6/7
 * visualization helper)
 */
export async function* startRotation(
  graph: HLSFGraph,
  options: RotationOptions = {},
): AsyncGenerator<RotationEvent> {
  rotationActive = true;
  const angularVelocity = options.angularVelocity ?? 0.05;
  const interval = options.sampleIntervalMs ?? 200;
  let angle = 0;

  while (rotationActive) {
    const spectral = computeGraphSpectral(graph);
    yield { angle, spectral, timestamp: Date.now() };
    angle = (angle + angularVelocity) % (Math.PI * 2);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** Stops any active rotation stream. */
export function stopRotation(): void {
  rotationActive = false;
}

/** Computes simple spectral statistics for a graph without UI coupling. */
export function computeSpectralFeaturesForSeries(series: number[]): SpectralFeatures {
  return computeSpectralFeatures(series);
}

function computeGraphSpectral(graph: HLSFGraph): SpectralFeatures {
  const roleBands: number[] = [];
  const flattened: number[] = [];
  for (let i = 0; i < graph.nodes.length; i += 1) {
    // Placeholder spectral series per node; real implementation would sample per-node energy
    const series = [Math.random(), Math.random(), Math.random()];
    const features = computeSpectralFeatures(series);
    flattened.push(features.energy);
    roleBands.push(...features.roleBandpower);
  }
  return computeSpectralFeatures(flattened.length ? flattened : [0]);
}
