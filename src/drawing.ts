import Color from 'colorjs.io';
import type { Point } from './types';
import { currentTool, currentColor, setCurrentColor, currentSize, setCurrentSize, setCurrentTool, isDrawing, anchorPoint, lastInputPoint, lastRenderPos, lastInputTime, positionSmoothing, lazyRadius, setAnchorPoint, setLastInputPoint, setLastRenderPos, setLastInputTime, setLazyRadius, layers, activeLayerId, canvasLogicalW, canvasLogicalH, viewScale, viewOffsetX, viewOffsetY, viewRotation } from './state';
import { colorPreview, colorInput, oklchL, oklchC, oklchH, sizeSlider, sizeValEl, stabSlider, stabValEl, btnToggleTool, container } from './dom';
import { compositeAndDisplay } from './canvas';
import { saveUndoState, showToast } from './undo';

// ===================================================================
// Color helpers
// ===================================================================
const oklchColorCache: { [key: number]: string } = {};
export function getMaxChromaColor(h: number): string {
  if (oklchColorCache[h] !== undefined) {
    return oklchColorCache[h];
  }
  let maxC = 0;
  let bestL = 0.7;
  for (let l = 0.2; l <= 0.9; l += 0.05) {
    let low = 0;
    let high = 0.4;
    let fitC = 0;
    for (let step = 0; step < 10; step++) {
      const mid = (low + high) / 2;
      const col = new Color('oklch', [l, mid, h]);
      if (col.inGamut('srgb')) {
        fitC = mid;
        low = mid;
      } else {
        high = mid;
      }
    }
    if (fitC > maxC) {
      maxC = fitC;
      bestL = l;
    }
  }
  const finalCol = new Color('oklch', [bestL, maxC, h]);
  const hex = finalCol.to('srgb').toString({ format: 'hex' });
  oklchColorCache[h] = hex;
  return hex;
}

export function updateColorDisplay(c: InstanceType<typeof Color>) {
  setCurrentColor(c.toString({ format: "hex" }));
  colorInput.value = currentColor;
  colorPreview.style.backgroundColor = currentColor;

  const oklch = c.to('oklch');
  const l = oklch.coords[0];
  const chr = oklch.coords[1];
  const h = oklch.coords[2];
  oklchL.value = (typeof l === 'number' && !isNaN(l)) ? l.toFixed(3) : "0";
  oklchC.value = (typeof chr === 'number' && !isNaN(chr)) ? chr.toFixed(3) : "0";
  oklchH.value = (typeof h === 'number' && !isNaN(h)) ? h.toFixed(1) : "0";
}

export function handleOklchInput() {
  try {
    const l = parseFloat(oklchL.value) || 0;
    const c = parseFloat(oklchC.value) || 0;
    const h = parseFloat(oklchH.value) || 0;
    const color = new Color('oklch', [l, c, h]);
    setCurrentColor(color.to('srgb').toString({ format: "hex" }));
    colorInput.value = currentColor;
    colorPreview.style.backgroundColor = currentColor;
  } catch (err) {
    console.error(err);
  }
}

// ===================================================================
// Tool state
// ===================================================================
export function resetToolToPen() {
  setCurrentTool('pen');
  btnToggleTool.innerHTML = '<i data-lucide="pen-tool"></i>';
  btnToggleTool.title = 'Pen';
  if ((window as any).lucide) {
    (window as any).lucide.createIcons({ root: btnToggleTool });
  }
}

export function fillLayerColor(layerId: number, colorHex: string) {
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return;
  
  saveUndoState(layerId);
  
  const ctx = layer.ctx;
  const prevComposite = ctx.globalCompositeOperation;
  
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, canvasLogicalW, canvasLogicalH);
  
  ctx.globalCompositeOperation = prevComposite;
  
  compositeAndDisplay();
  showToast('Layer color changed');
}

// ===================================================================
// Drawing: render a line segment on the active layer
// ===================================================================
function getActiveLayer() {
  return layers.find(l => l.id === activeLayerId);
}

export function drawSegment(from: Point, to: Point) {
  const layer = getActiveLayer();
  if (!layer) return;
  const ctx = layer.ctx;

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);

  if (currentTool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = currentColor;
  }

  ctx.lineWidth = currentTool === 'eraser' ? currentSize * 2 : currentSize;
  ctx.stroke();

  compositeAndDisplay();
}

// ===================================================================
// Coordinate math
// ===================================================================
export function getCanvasPoint(clientX: number, clientY: number): Point {
  const rect = container.getBoundingClientRect();
  const screenX = clientX - rect.left;
  const screenY = clientY - rect.top;

  const dx = screenX - viewOffsetX;
  const dy = screenY - viewOffsetY;

  const cos = Math.cos(viewRotation);
  const sin = Math.sin(viewRotation);

  const rx = dx * cos + dy * sin;
  const ry = -dx * sin + dy * cos;

  return { x: rx / viewScale, y: ry / viewScale };
}

// ===================================================================
// StrokeSmoother
// ===================================================================
export function smootherReset() {
  setAnchorPoint(null);
  setLastInputPoint(null);
  setLastRenderPos(null);
  setLastInputTime(0);
}

export function smootherProcessPoint(p: Point) {
  setLastInputTime(performance.now());
  if (!anchorPoint) {
    setAnchorPoint({ x: p.x, y: p.y });
    setLastInputPoint({ x: p.x, y: p.y });
    setLastRenderPos({ x: p.x, y: p.y });
    return;
  }
  setLastInputPoint({ x: p.x, y: p.y });
}

export function smootherTick() {
  if (!isDrawing || !anchorPoint || !lastInputPoint || !lastRenderPos) return;

  const elapsed = performance.now() - lastInputTime;
  let currentSmoothing = positionSmoothing;
  if (elapsed > 40) {
    const t = Math.min(1, (elapsed - 40) / 200);
    currentSmoothing = positionSmoothing + (0.35 - positionSmoothing) * t;
  }

  const ap = anchorPoint;
  ap.x += (lastInputPoint.x - ap.x) * currentSmoothing;
  ap.y += (lastInputPoint.y - ap.y) * currentSmoothing;

  const adx = lastInputPoint.x - ap.x;
  const ady = lastInputPoint.y - ap.y;
  const adist = Math.sqrt(adx * adx + ady * ady);

  if (adist > lazyRadius) {
    const pullRatio = (adist - lazyRadius) / adist;
    ap.x += adx * pullRatio;
    ap.y += ady * pullRatio;
  }

  const movedX = ap.x - lastRenderPos.x;
  const movedY = ap.y - lastRenderPos.y;
  if (movedX * movedX + movedY * movedY < 0.01) return;

  drawSegment(lastRenderPos, { x: ap.x, y: ap.y });
  setLastRenderPos({ x: ap.x, y: ap.y });
}

// ===================================================================
// Setup event listeners for color/size/tool controls
// ===================================================================
export function initDrawingListeners() {
  colorInput.addEventListener('input', (e) => {
    updateColorDisplay(new Color((e.target as HTMLInputElement).value));
  });

  oklchL.addEventListener('input', handleOklchInput);
  oklchC.addEventListener('input', handleOklchInput);
  oklchH.addEventListener('input', handleOklchInput);

  btnToggleTool.addEventListener('click', () => {
    if (currentTool === 'pen') {
      setCurrentTool('eraser');
      btnToggleTool.innerHTML = '<i data-lucide="eraser"></i>';
      btnToggleTool.title = 'Eraser';
    } else {
      setCurrentTool('pen');
      btnToggleTool.innerHTML = '<i data-lucide="pen-tool"></i>';
      btnToggleTool.title = 'Pen';
    }
    if ((window as any).lucide) {
      (window as any).lucide.createIcons({ root: btnToggleTool });
    }
  });

  sizeSlider.addEventListener('input', (e) => {
    const sliderVal = parseFloat((e.target as HTMLInputElement).value);
    const size = Math.pow(10, sliderVal / 50);
    setCurrentSize(Math.max(1, Math.round(size)));
    sizeValEl.innerText = currentSize.toString();
  });

  stabSlider.addEventListener('input', (e) => {
    const sliderVal = parseFloat((e.target as HTMLInputElement).value);
    setLazyRadius(Math.round(12.5 * (Math.pow(3, sliderVal / 50) - 1)));
    stabValEl.innerText = lazyRadius.toString();
  });

  // Start animation loop
  function tick() {
    smootherTick();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
