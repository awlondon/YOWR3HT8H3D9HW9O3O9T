export type ExpansionOriginMode = 'center' | 'corner';
export type ExpansionCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface WedgeAngles {
  start: number;
  end: number;
}

export function normalizeOriginMode(value: unknown): ExpansionOriginMode {
  return value === 'center' ? 'center' : 'corner';
}

export function normalizeOriginCorner(value: unknown): ExpansionCorner {
  switch (value) {
    case 'top-left':
    case 'top-right':
    case 'bottom-right':
    case 'bottom-left':
      return value;
    default:
      return 'bottom-left';
  }
}

export function resolveOriginPadding(paddingPx?: unknown, nodeRadius = 0): number {
  const basePadding = Number.isFinite(paddingPx as number)
    ? Math.max(0, Number(paddingPx))
    : 48;
  const safeRadius = Math.max(0, nodeRadius);
  return Math.max(basePadding, safeRadius + 8);
}

export function getCornerPivot(
  width: number,
  height: number,
  corner: ExpansionCorner,
  padding: number,
): { x: number; y: number } {
  const pad = Math.max(0, padding);
  switch (corner) {
    case 'top-left':
      return { x: pad, y: pad };
    case 'top-right':
      return { x: width - pad, y: pad };
    case 'bottom-right':
      return { x: width - pad, y: height - pad };
    case 'bottom-left':
    default:
      return { x: pad, y: height - pad };
  }
}

export function getInwardWedgeAngles(
  pivot: { x: number; y: number },
  width: number,
  height: number,
  wedgeRadians = Math.PI / 2,
): WedgeAngles {
  const cx = width / 2;
  const cy = height / 2;
  const thetaCenter = Math.atan2(cy - pivot.y, cx - pivot.x);
  const half = wedgeRadians / 2;
  return { start: thetaCenter - half, end: thetaCenter + half };
}

export function distributeAngles(count: number, wedge: WedgeAngles): number[] {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return [];
  const angles: number[] = [];
  const denom = safeCount + 1;
  for (let i = 0; i < safeCount; i++) {
    const t = (i + 1) / denom;
    const theta = wedge.start + (wedge.end - wedge.start) * t;
    angles.push(theta);
  }
  return angles;
}

export function estimateNodePadding(nodeScale?: unknown): number {
  const scale = Number.isFinite(nodeScale as number) ? Math.max(0.25, Number(nodeScale)) : 1;
  const spokeScale = 1 + Math.log2(3) * 0.3;
  const approximateRadius = Math.max(2, (4 + 2 * spokeScale) * scale * 1.6);
  return resolveOriginPadding(undefined, approximateRadius);
}
