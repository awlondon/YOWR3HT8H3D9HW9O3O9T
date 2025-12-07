import { type SpectralFeatures } from './emergentThoughtTypes.js';

const DEFAULT_WINDOW = 32;
const DEFAULT_ROLE_BANDS = 5;

export function computeSpectralFeatures(
  series: number[],
  roleBands: number = DEFAULT_ROLE_BANDS,
  windowSize: number = DEFAULT_WINDOW,
): SpectralFeatures {
  const data = series.slice(-windowSize);
  while (data.length < windowSize) data.unshift(0);

  const magnitudes: number[] = [];
  for (let k = 0; k < windowSize; k += 1) {
    let real = 0;
    let imag = 0;
    for (let n = 0; n < windowSize; n += 1) {
      const angle = (-2 * Math.PI * k * n) / windowSize;
      real += data[n] * Math.cos(angle);
      imag += data[n] * Math.sin(angle);
    }
    magnitudes.push(Math.sqrt(real * real + imag * imag));
  }

  const totalMag = magnitudes.reduce((sum, m) => sum + m, 0) || 1e-6;
  const energy = magnitudes.reduce((sum, m) => sum + m * m, 0) / windowSize;
  const centroid = magnitudes.reduce((sum, m, idx) => sum + idx * m, 0) /
    (totalMag * windowSize);
  const arith = totalMag / magnitudes.length;
  const geo = Math.exp(
    magnitudes.reduce((sum, m) => sum + Math.log(m + 1e-6), 0) / magnitudes.length,
  );
  const flatness = Math.min(1, geo / (arith + 1e-6));

  const bandSize = Math.max(1, Math.floor(windowSize / roleBands));
  const roleBandpower: number[] = [];
  for (let i = 0; i < roleBands; i += 1) {
    const start = i * bandSize;
    const end = i === roleBands - 1 ? windowSize : (i + 1) * bandSize;
    let sum = 0;
    for (let k = start; k < end; k += 1) {
      sum += (magnitudes[k] ?? 0) ** 2;
    }
    const normalized = sum / Math.max(1, end - start);
    roleBandpower.push(Number(normalized.toFixed(4)));
  }

  return {
    energy: Number(energy.toFixed(4)),
    centroid: Number(centroid.toFixed(4)),
    flatness: Number(flatness.toFixed(4)),
    roleBandpower,
  };
}

// Alias retained for compatibility with legacy code paths.
export const computeSpectralFeaturesFromSeries = computeSpectralFeatures;
