import { canvasLogicalW, canvasLogicalH, setCanvasLogicalW, setCanvasLogicalH, layers, groupCanvas, groupCtx, setGroupCanvas, setGroupCtx, viewOffsetX, viewOffsetY, viewScale, viewRotation } from './state';
import { displayCanvas, displayCtx, canvasWrapper } from './dom';

export function generateThumbnail(sourceCanvas: HTMLCanvasElement, maxDim: number = 160): string {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  let newW = w;
  let newH = h;
  
  if (w > maxDim || h > maxDim) {
    if (w > h) {
      newW = maxDim;
      newH = Math.round((h / w) * maxDim);
    } else {
      newH = maxDim;
      newW = Math.round((w / h) * maxDim);
    }
  }

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = newW;
  thumbCanvas.height = newH;
  const ctx = thumbCanvas.getContext('2d');
  if (!ctx) return '';
  
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, newW, newH);
  ctx.drawImage(sourceCanvas, 0, 0, newW, newH);
  
  return thumbCanvas.toDataURL('image/jpeg', 0.8);
}

export function initCanvasSize(w: number, h: number) {
  setCanvasLogicalW(w);
  setCanvasLogicalH(h);
  const dpr = window.devicePixelRatio || 1;

  displayCanvas.width = w * dpr;
  displayCanvas.height = h * dpr;
  displayCanvas.style.width = `${w}px`;
  displayCanvas.style.height = `${h}px`;
  canvasWrapper.style.width = `${w}px`;
  canvasWrapper.style.height = `${h}px`;

  let gc = groupCanvas;
  if (!gc) {
    gc = document.createElement('canvas');
    setGroupCanvas(gc);
  }
  gc.width = w * dpr;
  gc.height = h * dpr;
  setGroupCtx(gc.getContext('2d')!);

  displayCtx.scale(dpr, dpr);
}

export function compositeAndDisplay() {
  const dpr = window.devicePixelRatio || 1;
  displayCtx.setTransform(1, 0, 0, 1, 0, 0);
  displayCtx.fillStyle = '#ffffff';
  displayCtx.fillRect(0, 0, displayCanvas.width, displayCanvas.height);

  const gc = groupCanvas;
  const gctx = groupCtx;
  if (!gc || !gctx) {
    displayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return;
  }

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const isClipped = layer.clipped;
    const nextIsClipped = (i + 1 < layers.length) && layers[i + 1].clipped;

    if (isClipped) {
      if (layer.visible) {
        gctx.globalCompositeOperation = 'source-atop';
        gctx.drawImage(layer.canvas, 0, 0);
      }
      if (!nextIsClipped) {
        displayCtx.drawImage(gc, 0, 0);
      }
    } else {
      if (nextIsClipped) {
        gctx.clearRect(0, 0, gc.width, gc.height);
        if (layer.visible) {
          gctx.globalCompositeOperation = 'source-over';
          gctx.drawImage(layer.canvas, 0, 0);
        }
      } else {
        if (layer.visible) {
          displayCtx.drawImage(layer.canvas, 0, 0);
        }
      }
    }
  }

  displayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function updateViewTransform() {
  canvasWrapper.style.transform = `translate(${viewOffsetX}px, ${viewOffsetY}px) scale(${viewScale}) rotate(${viewRotation}rad)`;
}

export function createLayerCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  c.width = canvasLogicalW * dpr;
  c.height = canvasLogicalH * dpr;
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return { canvas: c, ctx };
}
