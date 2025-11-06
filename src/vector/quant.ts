export function quantize8(v: Float32Array): { q: Uint8Array; scale: number; zero: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const range = max - min;
  const scale = range === 0 ? 1 : range / 255;
  const zero = Math.round(-min / (scale || 1));
  const q = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i += 1) {
    const value = scale === 0 ? 0 : v[i] / scale + zero;
    q[i] = Math.max(0, Math.min(255, Math.round(value)));
  }
  return { q, scale: scale || 1, zero };
}

export function dequantize8(q: Uint8Array, scale: number, zero: number): Float32Array {
  const v = new Float32Array(q.length);
  for (let i = 0; i < q.length; i += 1) {
    v[i] = (q[i] - zero) * scale;
  }
  return v;
}
