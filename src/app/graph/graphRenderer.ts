import type { PipelineGraph } from '../../engine/pipeline';

export interface GraphRendererDependencies {
  animateViewport(target: { x: number; y: number; scale: number }, duration: number): void;
  renderComposite(graph: PipelineGraph, glyphOnly?: boolean): void;
}

export type ClusterZoomMode = 'in' | 'out';

export class GraphRenderer {
  constructor(private readonly deps: GraphRendererDependencies) {}

  renderGraph(graph: PipelineGraph, glyphOnly = false): void {
    this.deps.renderComposite(graph, glyphOnly);
  }

  installClusterZoom(canvas: HTMLCanvasElement | null): void {
    if (!canvas || canvas.dataset.clusterZoomBound === 'true') return;
    const overlay = this.ensureClusterZoomOverlay(canvas);
    if (!overlay) {
      canvas.dataset.clusterZoomBound = 'true';
      return;
    }

    const minSelectionSize = 64;
    let selecting = false;
    let startPoint = { x: 0, y: 0 };
    let currentRect: { x: number; y: number; width: number; height: number } | null = null;

    const resetOverlay = () => {
      overlay.style.left = '0px';
      overlay.style.top = '0px';
      overlay.style.width = '0px';
      overlay.style.height = '0px';
      overlay.setAttribute('aria-hidden', 'true');
      currentRect = null;
    };

    const updateOverlayRect = (endPoint: { x: number; y: number }) => {
      currentRect = this.buildClusterSelectionRect(canvas, startPoint, endPoint);
      overlay.style.left = `${currentRect.x}px`;
      overlay.style.top = `${currentRect.y}px`;
      overlay.style.width = `${currentRect.width}px`;
      overlay.style.height = `${currentRect.height}px`;
      overlay.setAttribute('aria-hidden', 'false');
    };

    const cancelSelection = () => {
      selecting = false;
      canvas.classList.remove('hlsf-selecting');
      overlay.classList.remove('is-active');
      resetOverlay();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (!this.shouldStartClusterZoom(event)) return;
      selecting = true;
      startPoint = this.getCanvasRelativePosition(canvas, event);
      updateOverlayRect(startPoint);
      overlay.classList.add('is-active');
      canvas.classList.add('hlsf-selecting');
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!selecting) return;
      const pos = this.getCanvasRelativePosition(canvas, event);
      updateOverlayRect(pos);
      event.preventDefault();
    };

    const onMouseUp = (event: MouseEvent) => {
      if (!selecting) return;
      const canvasSize = {
        width: canvas.clientWidth || canvas.width || 1,
        height: canvas.clientHeight || canvas.height || 1,
      };
      selecting = false;
      canvas.classList.remove('hlsf-selecting');
      overlay.classList.remove('is-active');
      const endPoint = event ? this.getCanvasRelativePosition(canvas, event) : startPoint;
      updateOverlayRect(endPoint);
      const rect = currentRect || this.buildClusterSelectionRect(canvas, startPoint, endPoint);
      const dragVector = { x: endPoint.x - startPoint.x, y: endPoint.y - startPoint.y };
      const shouldZoomOut = dragVector.x < 0 && dragVector.y < 0;
      resetOverlay();
      if (!rect) return;
      const effectiveWidth = Math.max(rect.width, Math.min(minSelectionSize, canvasSize.width));
      const effectiveHeight = Math.max(rect.height, Math.min(minSelectionSize, canvasSize.height));
      let normalizedRect = { ...rect };
      if (rect.width < minSelectionSize || rect.height < minSelectionSize) {
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const halfW = Math.min(effectiveWidth / 2, canvasSize.width / 2);
        const halfH = Math.min(effectiveHeight / 2, canvasSize.height / 2);
        normalizedRect = {
          x: Math.max(0, centerX - halfW),
          y: Math.max(0, centerY - halfH),
          width: Math.min(canvasSize.width, halfW * 2),
          height: Math.min(canvasSize.height, halfH * 2),
        };
      }
      this.applyClusterZoomSelection(canvas, normalizedRect, shouldZoomOut ? 'out' : 'in');
    };

    const onMouseLeave = () => {
      if (!selecting) return;
      cancelSelection();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!selecting) return;
      if (event.key === 'Escape') {
        cancelSelection();
      }
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('mouseup', onMouseUp, { passive: false });
    window.addEventListener('keydown', onKeyDown, { passive: false });

    canvas.dataset.clusterZoomBound = 'true';
  }

  private shouldStartClusterZoom(event: MouseEvent): boolean {
    return event.shiftKey || event.altKey || event.metaKey;
  }

  private ensureClusterZoomOverlay(canvas: HTMLCanvasElement): HTMLDivElement | null {
    if (!canvas || typeof document === 'undefined') return null;
    const host = canvas.parentElement;
    if (!host) return null;
    let overlay = host.querySelector<HTMLDivElement>('.hlsf-cluster-zoom-box');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'hlsf-cluster-zoom-box';
      overlay.setAttribute('aria-hidden', 'true');
      host.appendChild(overlay);
    }
    return overlay;
  }

  private getCanvasRelativePosition(canvas: HTMLCanvasElement, event: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.clientWidth || canvas.width || 1;
    const height = rect.height || canvas.clientHeight || canvas.height || 1;
    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    const clampedX = Math.max(0, Math.min(width, rawX));
    const clampedY = Math.max(0, Math.min(height, rawY));
    return { x: clampedX, y: clampedY };
  }

  private buildClusterSelectionRect(
    canvas: HTMLCanvasElement,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ) {
    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;
    const minX = Math.max(0, Math.min(width, Math.min(start.x, end.x)));
    const minY = Math.max(0, Math.min(height, Math.min(start.y, end.y)));
    const maxX = Math.max(0, Math.min(width, Math.max(start.x, end.x)));
    const maxY = Math.max(0, Math.min(height, Math.max(start.y, end.y)));
    const rectWidth = Math.max(1, maxX - minX);
    const rectHeight = Math.max(1, maxY - minY);
    return { x: minX, y: minY, width: rectWidth, height: rectHeight };
  }

  private screenToWorldFromCanvas(canvas: HTMLCanvasElement, point: { x: number; y: number }) {
    const hlsfWindow = window as typeof window & {
      HLSF?: { view?: { x?: number; y?: number; scale?: number } };
    };
    hlsfWindow.HLSF = hlsfWindow.HLSF || {};
    hlsfWindow.HLSF.view = hlsfWindow.HLSF.view || { x: 0, y: 0, scale: 1 };
    const view = hlsfWindow.HLSF.view;
    const scale = Number.isFinite(view.scale) ? view.scale : 1;
    const vx = Number.isFinite(view.x) ? view.x : 0;
    const vy = Number.isFinite(view.y) ? view.y : 0;
    return {
      x: (point.x - vx) / scale,
      y: (point.y - vy) / scale,
    };
  }

  private applyClusterZoomSelection(
    canvas: HTMLCanvasElement,
    rect: { x: number; y: number; width: number; height: number },
    mode: ClusterZoomMode = 'in',
  ) {
    if (!canvas || rect.width <= 0 || rect.height <= 0) return;
    const viewWidth = canvas.clientWidth || canvas.width || 1;
    const viewHeight = canvas.clientHeight || canvas.height || 1;
    const padding = 0.85;
    const hlsfWindow = window as typeof window & {
      HLSF?: { view?: { x?: number; y?: number; scale?: number } };
    };
    hlsfWindow.HLSF = hlsfWindow.HLSF || {};
    hlsfWindow.HLSF.view = hlsfWindow.HLSF.view || { x: 0, y: 0, scale: 1 };
    const currentView = hlsfWindow.HLSF.view;
    const currentScale = Number.isFinite(currentView.scale) ? currentView.scale : 1;
    const startWorld = this.screenToWorldFromCanvas(canvas, { x: rect.x, y: rect.y });
    const endWorld = this.screenToWorldFromCanvas(canvas, {
      x: rect.x + rect.width,
      y: rect.y + rect.height,
    });
    const worldWidth = Math.max(1e-4, Math.abs(endWorld.x - startWorld.x));
    const worldHeight = Math.max(1e-4, Math.abs(endWorld.y - startWorld.y));
    const scaleByWidth = (viewWidth * padding) / worldWidth;
    const scaleByHeight = (viewHeight * padding) / worldHeight;
    const scaleCandidate = Math.min(scaleByWidth, scaleByHeight);
    const zoomRatio = scaleCandidate / Math.max(currentScale, 1e-4);
    const targetScale =
      mode === 'out'
        ? Math.min(48, Math.max(0.1, currentScale / Math.max(zoomRatio, 1e-4)))
        : Math.min(48, Math.max(0.1, scaleCandidate));
    const centerWorldX = startWorld.x + worldWidth / 2;
    const centerWorldY = startWorld.y + worldHeight / 2;
    const target = {
      scale: targetScale,
      x: viewWidth / 2 - centerWorldX * targetScale,
      y: viewHeight / 2 - centerWorldY * targetScale,
    };
    const travel = Math.hypot(rect.width, rect.height);
    const duration = Math.min(650, Math.max(220, travel * 1.2));
    this.deps.animateViewport(target, duration);
  }
}
