import './style.css';
import Color from 'colorjs.io';

// ===================================================================
// HTML
// ===================================================================
const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div id="canvas-container">
    <div id="canvas-wrapper">
      <canvas id="display-canvas"></canvas>
    </div>
  </div>

  <div class="settings-panel">
    <div class="settings-row">
      <label>Canvas W:</label>
      <input type="number" id="canvas-w" value="1024" />
    </div>
    <div class="settings-row">
      <label>Canvas H:</label>
      <input type="number" id="canvas-h" value="768" />
    </div>
    <div class="settings-row">
      <button id="btn-resize">Resize</button>
      <button id="btn-reset-view">Reset View</button>
    </div>
  </div>

  <div class="layer-panel">
    <div class="layer-panel-header">
      <span>Layers</span>
      <button id="btn-add-layer" title="Add layer">+</button>
    </div>
    <div class="layer-list" id="layer-list"></div>
  </div>

  <div class="toolbar">
    <div class="tool-group">
      <button id="btn-pen" class="active">Pen</button>
      <button id="btn-eraser">Eraser</button>
    </div>

    <div class="tool-group slider-group">
      <label>Size: <span id="size-val">5</span>px</label>
      <input type="range" id="size-slider" min="1" max="100" value="5" />
    </div>

    <div class="tool-group color-picker-group">
      <div class="color-preview" id="color-preview"></div>
      <input type="color" id="color-input" value="#000000" />

      <div class="oklch-inputs">
        <div class="oklch-row">
          <label>L</label> <input type="number" id="oklch-l" step="0.01" min="0" max="1" />
        </div>
        <div class="oklch-row">
          <label>C</label> <input type="number" id="oklch-c" step="0.01" min="0" max="0.4" />
        </div>
        <div class="oklch-row">
          <label>H</label> <input type="number" id="oklch-h" step="1" min="0" max="360" />
        </div>
      </div>
    </div>

    <div class="tool-group slider-group">
      <label>Stabilize: <span id="stab-val">30</span></label>
      <input type="range" id="stab-slider" min="0" max="100" value="30" />
    </div>
  </div>

  <div class="undo-toast" id="undo-toast"></div>
`;

// ===================================================================
// DOM Elements
// ===================================================================
const displayCanvas = document.getElementById('display-canvas') as HTMLCanvasElement;
const canvasWrapper = document.getElementById('canvas-wrapper') as HTMLDivElement;
const container = document.getElementById('canvas-container') as HTMLDivElement;
const displayCtx = displayCanvas.getContext('2d')!;

const btnPen = document.getElementById('btn-pen') as HTMLButtonElement;
const btnEraser = document.getElementById('btn-eraser') as HTMLButtonElement;
const sizeSlider = document.getElementById('size-slider') as HTMLInputElement;
const sizeValEl = document.getElementById('size-val') as HTMLSpanElement;

const colorPreview = document.getElementById('color-preview') as HTMLDivElement;
const colorInput = document.getElementById('color-input') as HTMLInputElement;
const oklchL = document.getElementById('oklch-l') as HTMLInputElement;
const oklchC = document.getElementById('oklch-c') as HTMLInputElement;
const oklchH = document.getElementById('oklch-h') as HTMLInputElement;

const stabSlider = document.getElementById('stab-slider') as HTMLInputElement;
const stabValEl = document.getElementById('stab-val') as HTMLSpanElement;

const canvasWInput = document.getElementById('canvas-w') as HTMLInputElement;
const canvasHInput = document.getElementById('canvas-h') as HTMLInputElement;
const btnResize = document.getElementById('btn-resize') as HTMLButtonElement;
const btnResetView = document.getElementById('btn-reset-view') as HTMLButtonElement;

const btnAddLayer = document.getElementById('btn-add-layer') as HTMLButtonElement;
const layerListEl = document.getElementById('layer-list') as HTMLDivElement;
const undoToastEl = document.getElementById('undo-toast') as HTMLDivElement;

// ===================================================================
// Types & State
// ===================================================================
interface Point { x: number; y: number; }

interface Layer {
  id: number;
  name: string;
  visible: boolean;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

let currentTool: 'pen' | 'eraser' = 'pen';
let currentSize = 5;
let currentColor = '#000000';

// StrokeSmoother parameters
const positionSmoothing = 0.07;
let lazyRadius = 30;

let viewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;
let viewRotation = 0;

let canvasLogicalW = 1024;
let canvasLogicalH = 768;

let isDrawing = false;
const activePointers: Map<number, PointerEvent> = new Map();

// StrokeSmoother state
let anchorPoint: Point | null = null;
let lastInputPoint: Point | null = null;
let lastRenderPos: Point | null = null;
let lastInputTime = 0;

// Gesture state
let initialPinchDistance: number | null = null;
let initialPinchAngle: number | null = null;
let initialViewScale = 1;
let initialViewRotation = 0;
let initialPinchCenter: Point | null = null;
let initialViewOffset: Point | null = null;

// Tap detection state
interface TapRecord { pointerId: number; startTime: number; startX: number; startY: number; moved: boolean; }
let tapRecords: TapRecord[] = [];
const TAP_MAX_DURATION = 300;  // ms
const TAP_MAX_DISTANCE = 15;   // px

// ===================================================================
// Layers
// ===================================================================
let layers: Layer[] = [];
let activeLayerId = -1;
let nextLayerId = 0;

function createLayerCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
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

// Internal: add layer without recording undo (used by init and undo/redo restore)
function addLayerInternal(name?: string): Layer {
  const { canvas, ctx } = createLayerCanvas();
  const layer: Layer = {
    id: nextLayerId++,
    name: name || `Layer ${layers.length + 1}`,
    visible: true,
    canvas,
    ctx,
  };
  layers.push(layer);
  activeLayerId = layer.id;
  renderLayerList();
  return layer;
}

// Public: add layer with undo recording
function addLayer(name?: string): Layer {
  const prevActiveId = activeLayerId;
  const layer = addLayerInternal(name);
  pushUndo({
    type: 'addLayer',
    layerId: layer.id,
    layerIndex: layers.length - 1,
    layerName: layer.name,
    imageData: null, // new layer is empty
    prevActiveLayerId: prevActiveId,
  });
  return layer;
}

// Internal: delete layer without recording undo
function deleteLayerInternal(id: number): { layer: Layer; index: number } | null {
  if (layers.length <= 1) return null;
  const index = layers.findIndex(l => l.id === id);
  if (index === -1) return null;
  const layer = layers[index];
  layers.splice(index, 1);
  if (activeLayerId === id) {
    activeLayerId = layers[Math.min(index, layers.length - 1)].id;
  }
  renderLayerList();
  compositeAndDisplay();
  return { layer, index };
}

// Public: delete layer with undo recording
function deleteLayer(id: number) {
  if (layers.length <= 1) return;
  const layerToDelete = layers.find(l => l.id === id);
  if (!layerToDelete) return;

  // Save layer content before deletion
  const imageData = layerToDelete.ctx.getImageData(0, 0, layerToDelete.canvas.width, layerToDelete.canvas.height);
  const prevActiveId = activeLayerId;
  const result = deleteLayerInternal(id);
  if (!result) return;

  pushUndo({
    type: 'deleteLayer',
    layerId: result.layer.id,
    layerIndex: result.index,
    layerName: result.layer.name,
    imageData,
    prevActiveLayerId: prevActiveId,
  });
}

function getActiveLayer(): Layer | undefined {
  return layers.find(l => l.id === activeLayerId);
}

function renderLayerList() {
  layerListEl.innerHTML = '';
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const item = document.createElement('div');
    item.className = 'layer-item' + (layer.id === activeLayerId ? ' selected' : '');

    const vis = document.createElement('span');
    vis.className = 'layer-visibility';
    vis.textContent = layer.visible ? '👁' : '−';
    vis.addEventListener('click', (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      renderLayerList();
      compositeAndDisplay();
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'layer-name';
    nameEl.textContent = layer.name;

    const del = document.createElement('span');
    del.className = 'layer-delete';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLayer(layer.id);
    });

    item.appendChild(vis);
    item.appendChild(nameEl);
    item.appendChild(del);

    item.addEventListener('click', () => {
      activeLayerId = layer.id;
      renderLayerList();
    });

    layerListEl.appendChild(item);
  }
}

btnAddLayer.addEventListener('click', () => {
  addLayer();
  compositeAndDisplay();
});

// ===================================================================
// Undo / Redo (supports stroke, addLayer, deleteLayer)
// ===================================================================
interface StrokeUndoEntry {
  type: 'stroke';
  layerId: number;
  imageData: ImageData;
}

interface AddLayerUndoEntry {
  type: 'addLayer';
  layerId: number;
  layerIndex: number;
  layerName: string;
  imageData: ImageData | null;
  prevActiveLayerId: number;
}

interface DeleteLayerUndoEntry {
  type: 'deleteLayer';
  layerId: number;
  layerIndex: number;
  layerName: string;
  imageData: ImageData;
  prevActiveLayerId: number;
}

type UndoEntry = StrokeUndoEntry | AddLayerUndoEntry | DeleteLayerUndoEntry;

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
const MAX_UNDO = 50;

function pushUndo(entry: UndoEntry) {
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

function saveUndoState(layerId: number) {
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return;
  const imageData = layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
  pushUndo({ type: 'stroke', layerId, imageData });
}

function performUndo() {
  const entry = undoStack.pop();
  if (!entry) return;

  switch (entry.type) {
    case 'stroke': {
      const layer = layers.find(l => l.id === entry.layerId);
      if (!layer) return;
      const currentData = layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      redoStack.push({ type: 'stroke', layerId: entry.layerId, imageData: currentData });
      layer.ctx.putImageData(entry.imageData, 0, 0);
      break;
    }
    case 'addLayer': {
      // Undo adding a layer = remove it
      const layer = layers.find(l => l.id === entry.layerId);
      const imageData = layer
        ? layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height)
        : null;
      const index = layers.findIndex(l => l.id === entry.layerId);
      if (index !== -1) layers.splice(index, 1);
      activeLayerId = entry.prevActiveLayerId;
      // Ensure activeLayerId is valid
      if (!layers.find(l => l.id === activeLayerId) && layers.length > 0) {
        activeLayerId = layers[layers.length - 1].id;
      }
      redoStack.push({
        type: 'addLayer',
        layerId: entry.layerId,
        layerIndex: index !== -1 ? index : entry.layerIndex,
        layerName: entry.layerName,
        imageData,
        prevActiveLayerId: activeLayerId,
      });
      renderLayerList();
      break;
    }
    case 'deleteLayer': {
      // Undo deleting a layer = re-insert it
      const { canvas, ctx } = createLayerCanvas();
      const restoredLayer: Layer = {
        id: entry.layerId,
        name: entry.layerName,
        visible: true,
        canvas,
        ctx,
      };
      restoredLayer.ctx.putImageData(entry.imageData, 0, 0);
      // Ensure nextLayerId stays ahead
      if (entry.layerId >= nextLayerId) nextLayerId = entry.layerId + 1;
      // Insert at original position
      layers.splice(entry.layerIndex, 0, restoredLayer);
      activeLayerId = entry.prevActiveLayerId;
      if (!layers.find(l => l.id === activeLayerId) && layers.length > 0) {
        activeLayerId = layers[layers.length - 1].id;
      }
      redoStack.push({
        type: 'deleteLayer',
        layerId: entry.layerId,
        layerIndex: entry.layerIndex,
        layerName: entry.layerName,
        imageData: entry.imageData,
        prevActiveLayerId: activeLayerId,
      });
      renderLayerList();
      break;
    }
  }

  compositeAndDisplay();
  showToast('Undo');
}

function performRedo() {
  const entry = redoStack.pop();
  if (!entry) return;

  switch (entry.type) {
    case 'stroke': {
      const layer = layers.find(l => l.id === entry.layerId);
      if (!layer) return;
      const currentData = layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      undoStack.push({ type: 'stroke', layerId: entry.layerId, imageData: currentData });
      layer.ctx.putImageData(entry.imageData, 0, 0);
      break;
    }
    case 'addLayer': {
      // Redo adding a layer = re-insert it
      const { canvas, ctx } = createLayerCanvas();
      const restoredLayer: Layer = {
        id: entry.layerId,
        name: entry.layerName,
        visible: true,
        canvas,
        ctx,
      };
      if (entry.imageData) {
        restoredLayer.ctx.putImageData(entry.imageData, 0, 0);
      }
      if (entry.layerId >= nextLayerId) nextLayerId = entry.layerId + 1;
      layers.splice(entry.layerIndex, 0, restoredLayer);
      const prevActive = activeLayerId;
      activeLayerId = entry.layerId;
      undoStack.push({
        type: 'addLayer',
        layerId: entry.layerId,
        layerIndex: entry.layerIndex,
        layerName: entry.layerName,
        imageData: entry.imageData,
        prevActiveLayerId: prevActive,
      });
      renderLayerList();
      break;
    }
    case 'deleteLayer': {
      // Redo deleting a layer = remove it again
      const layer = layers.find(l => l.id === entry.layerId);
      const imageData = layer
        ? layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height)
        : entry.imageData;
      const index = layers.findIndex(l => l.id === entry.layerId);
      if (index !== -1) layers.splice(index, 1);
      const prevActive = activeLayerId;
      if (activeLayerId === entry.layerId && layers.length > 0) {
        activeLayerId = layers[Math.min(index, layers.length - 1)].id;
      }
      undoStack.push({
        type: 'deleteLayer',
        layerId: entry.layerId,
        layerIndex: index !== -1 ? index : entry.layerIndex,
        layerName: entry.layerName,
        imageData,
        prevActiveLayerId: prevActive,
      });
      renderLayerList();
      break;
    }
  }

  compositeAndDisplay();
  showToast('Redo');
}

let toastTimeout: ReturnType<typeof setTimeout> | null = null;
function showToast(text: string) {
  undoToastEl.textContent = text;
  undoToastEl.classList.add('show');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    undoToastEl.classList.remove('show');
  }, 600);
}

// ===================================================================
// Canvas Init & Composite
// ===================================================================
function initCanvasSize(w: number, h: number) {
  canvasLogicalW = w;
  canvasLogicalH = h;
  const dpr = window.devicePixelRatio || 1;

  displayCanvas.width = w * dpr;
  displayCanvas.height = h * dpr;
  displayCanvas.style.width = `${w}px`;
  displayCanvas.style.height = `${h}px`;
  canvasWrapper.style.width = `${w}px`;
  canvasWrapper.style.height = `${h}px`;

  displayCtx.scale(dpr, dpr);
}

function compositeAndDisplay() {
  const dpr = window.devicePixelRatio || 1;
  displayCtx.setTransform(1, 0, 0, 1, 0, 0);
  // White background
  displayCtx.fillStyle = '#ffffff';
  displayCtx.fillRect(0, 0, displayCanvas.width, displayCanvas.height);

  // Draw each visible layer bottom-to-top
  for (const layer of layers) {
    if (!layer.visible) continue;
    displayCtx.drawImage(layer.canvas, 0, 0, displayCanvas.width, displayCanvas.height);
  }

  displayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function updateViewTransform() {
  canvasWrapper.style.transform = `translate(${viewOffsetX}px, ${viewOffsetY}px) scale(${viewScale}) rotate(${viewRotation}rad)`;
}

// ===================================================================
// Color Handling
// ===================================================================
function updateColorDisplay(c: Color) {
  currentColor = c.toString({ format: "hex" });
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

colorPreview.addEventListener('click', () => colorInput.click());
colorInput.addEventListener('input', (e) => {
  updateColorDisplay(new Color((e.target as HTMLInputElement).value));
});

function handleOklchInput() {
  try {
    const l = parseFloat(oklchL.value) || 0;
    const c = parseFloat(oklchC.value) || 0;
    const h = parseFloat(oklchH.value) || 0;
    const color = new Color('oklch', [l, c, h]);
    currentColor = color.to('srgb').toString({ format: "hex" });
    colorInput.value = currentColor;
    colorPreview.style.backgroundColor = currentColor;
  } catch (err) {
    console.error(err);
  }
}

oklchL.addEventListener('input', handleOklchInput);
oklchC.addEventListener('input', handleOklchInput);
oklchH.addEventListener('input', handleOklchInput);

// ===================================================================
// UI Listeners
// ===================================================================
btnPen.addEventListener('click', () => {
  currentTool = 'pen';
  btnPen.classList.add('active');
  btnEraser.classList.remove('active');
});

btnEraser.addEventListener('click', () => {
  currentTool = 'eraser';
  btnEraser.classList.add('active');
  btnPen.classList.remove('active');
});

sizeSlider.addEventListener('input', (e) => {
  currentSize = parseInt((e.target as HTMLInputElement).value, 10);
  sizeValEl.innerText = currentSize.toString();
});

stabSlider.addEventListener('input', (e) => {
  lazyRadius = parseInt((e.target as HTMLInputElement).value, 10);
  stabValEl.innerText = lazyRadius.toString();
});

btnResize.addEventListener('click', () => {
  const w = parseInt(canvasWInput.value, 10);
  const h = parseInt(canvasHInput.value, 10);
  if (w > 0 && h > 0) {
    initCanvasSize(w, h);
    // Recreate all layer canvases at new size (existing content is lost)
    const dpr = window.devicePixelRatio || 1;
    for (const layer of layers) {
      layer.canvas.width = w * dpr;
      layer.canvas.height = h * dpr;
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.scale(dpr, dpr);
      layer.ctx.lineCap = 'round';
      layer.ctx.lineJoin = 'round';
    }
    undoStack.length = 0;
    redoStack.length = 0;
    compositeAndDisplay();
  }
});

btnResetView.addEventListener('click', () => {
  viewScale = 1;
  viewRotation = 0;
  viewOffsetX = (container.clientWidth - canvasLogicalW) / 2;
  viewOffsetY = (container.clientHeight - canvasLogicalH) / 2;
  updateViewTransform();
});

// ===================================================================
// Coordinate math
// ===================================================================
function getCanvasPoint(clientX: number, clientY: number): Point {
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
// Drawing: render a line segment on the active layer
// ===================================================================
function drawSegment(from: Point, to: Point) {
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

  // Update display
  compositeAndDisplay();
}

// ===================================================================
// StrokeSmoother
// ===================================================================
function smootherReset() {
  anchorPoint = null;
  lastInputPoint = null;
  lastRenderPos = null;
  lastInputTime = 0;
}

function smootherProcessPoint(p: Point) {
  lastInputTime = performance.now();
  if (!anchorPoint) {
    anchorPoint = { x: p.x, y: p.y };
    lastInputPoint = { x: p.x, y: p.y };
    lastRenderPos = { x: p.x, y: p.y };
    return;
  }
  lastInputPoint = { x: p.x, y: p.y };
}

function smootherTick() {
  if (!isDrawing || !anchorPoint || !lastInputPoint || !lastRenderPos) return;

  const elapsed = performance.now() - lastInputTime;
  let currentSmoothing = positionSmoothing;
  if (elapsed > 40) {
    // Ramp up smoothing factor from positionSmoothing (0.07) to 0.8 over 200ms
    const t = Math.min(1, (elapsed - 40) / 200);
    currentSmoothing = positionSmoothing + (0.8 - positionSmoothing) * t;
  }

  anchorPoint.x += (lastInputPoint.x - anchorPoint.x) * currentSmoothing;
  anchorPoint.y += (lastInputPoint.y - anchorPoint.y) * currentSmoothing;

  const adx = lastInputPoint.x - anchorPoint.x;
  const ady = lastInputPoint.y - anchorPoint.y;
  const adist = Math.sqrt(adx * adx + ady * ady);

  if (adist > lazyRadius) {
    const pullRatio = (adist - lazyRadius) / adist;
    anchorPoint.x += adx * pullRatio;
    anchorPoint.y += ady * pullRatio;
  }

  const movedX = anchorPoint.x - lastRenderPos.x;
  const movedY = anchorPoint.y - lastRenderPos.y;
  if (movedX * movedX + movedY * movedY < 0.01) return;

  drawSegment(lastRenderPos, { x: anchorPoint.x, y: anchorPoint.y });
  lastRenderPos = { x: anchorPoint.x, y: anchorPoint.y };
}

function tick() {
  smootherTick();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function smootherFinishStroke() {
  if (!anchorPoint || !lastInputPoint) return;

  const dx = lastInputPoint.x - anchorPoint.x;
  const dy = lastInputPoint.y - anchorPoint.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return;

  const limit = 20;
  const moveDist = Math.min(dist, limit);
  const ratio = moveDist / dist;

  const finalPoint: Point = {
    x: anchorPoint.x + dx * ratio,
    y: anchorPoint.y + dy * ratio,
  };
  drawSegment(lastRenderPos!, finalPoint);
}

// ===================================================================
// Tap Detection (2-finger undo, 3-finger redo)
// ===================================================================
function addTapRecord(e: PointerEvent) {
  tapRecords.push({
    pointerId: e.pointerId,
    startTime: performance.now(),
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
  });
}

function updateTapRecord(e: PointerEvent) {
  const rec = tapRecords.find(r => r.pointerId === e.pointerId);
  if (!rec) return;
  const dx = e.clientX - rec.startX;
  const dy = e.clientY - rec.startY;
  if (dx * dx + dy * dy > TAP_MAX_DISTANCE * TAP_MAX_DISTANCE) {
    rec.moved = true;
  }
}

function checkTapOnAllUp(): number | null {
  // Called when all pointers are up
  const now = performance.now();
  const count = tapRecords.length;
  if (count < 2) { tapRecords = []; return null; }

  const allQuick = tapRecords.every(r => (now - r.startTime) < TAP_MAX_DURATION);
  const noneMoved = tapRecords.every(r => !r.moved);

  tapRecords = [];

  if (allQuick && noneMoved) {
    return count; // number of fingers in the tap
  }
  return null;
}

// ===================================================================
// Pointer Events
// ===================================================================
container.addEventListener('pointerdown', (e) => {
  activePointers.set(e.pointerId, e);
  addTapRecord(e);

  if (activePointers.size === 1) {
    container.setPointerCapture(e.pointerId);
    // Save undo state before drawing
    const layer = getActiveLayer();
    if (layer) saveUndoState(layer.id);
    isDrawing = true;
    smootherReset();
    smootherProcessPoint(getCanvasPoint(e.clientX, e.clientY));
  } else if (activePointers.size >= 2) {
    // Cancel drawing, switch to gesture
    if (isDrawing) {
      // Revert the stroke we just started — restore from undo
      const entry = undoStack.pop(); // the state we just saved
      if (entry && entry.type === 'stroke') {
        const layer = layers.find(l => l.id === entry.layerId);
        if (layer) {
          layer.ctx.putImageData(entry.imageData, 0, 0);
          compositeAndDisplay();
        }
      }
      isDrawing = false;
      smootherReset();
    }
    if (activePointers.size === 2) {
      initGesture();
    }
  }
});

container.addEventListener('pointermove', (e) => {
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, e);
  }
  updateTapRecord(e);

  if (activePointers.size === 1 && isDrawing) {
    smootherProcessPoint(getCanvasPoint(e.clientX, e.clientY));
  } else if (activePointers.size >= 2) {
    handleGesture();
  }
});

function handlePointerUp(e: PointerEvent) {
  activePointers.delete(e.pointerId);
  try { container.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }

  if (activePointers.size === 0) {
    if (isDrawing) {
      smootherFinishStroke();
      isDrawing = false;
      smootherReset();
    }

    // Check for multi-finger tap
    const fingerCount = checkTapOnAllUp();
    if (fingerCount === 2) {
      performUndo();
    } else if (fingerCount !== null && fingerCount >= 3) {
      performRedo();
    }
  }
}

container.addEventListener('pointerup', handlePointerUp);
container.addEventListener('pointercancel', handlePointerUp);

// ===================================================================
// Gestures (Pan / Zoom)
// ===================================================================
function getPointers() {
  return Array.from(activePointers.values());
}

function initGesture() {
  const pts = getPointers();
  if (pts.length < 2) return;

  const p1 = pts[0];
  const p2 = pts[1];

  const dx = p2.clientX - p1.clientX;
  const dy = p2.clientY - p1.clientY;
  initialPinchDistance = Math.hypot(dx, dy);
  initialPinchAngle = Math.atan2(dy, dx);
  initialViewScale = viewScale;
  initialViewRotation = viewRotation;

  const rect = container.getBoundingClientRect();
  initialPinchCenter = {
    x: (p1.clientX + p2.clientX) / 2 - rect.left,
    y: (p1.clientY + p2.clientY) / 2 - rect.top,
  };

  initialViewOffset = { x: viewOffsetX, y: viewOffsetY };
}

function handleGesture() {
  const pts = getPointers();
  if (pts.length < 2 || !initialPinchDistance || !initialPinchCenter || !initialViewOffset || initialPinchAngle === null) return;

  const p1 = pts[0];
  const p2 = pts[1];

  const dx = p2.clientX - p1.clientX;
  const dy = p2.clientY - p1.clientY;
  const currentDistance = Math.hypot(dx, dy);
  const currentAngle = Math.atan2(dy, dx);

  let newScale = initialViewScale * (currentDistance / initialPinchDistance);
  newScale = Math.max(0.1, Math.min(newScale, 10));

  let newRotation = initialViewRotation + (currentAngle - initialPinchAngle);

  const rect = container.getBoundingClientRect();
  const currentCenter = {
    x: (p1.clientX + p2.clientX) / 2 - rect.left,
    y: (p1.clientY + p2.clientY) / 2 - rect.top,
  };

  const vX = initialPinchCenter.x - initialViewOffset.x;
  const vY = initialPinchCenter.y - initialViewOffset.y;

  const deltaAngle = newRotation - initialViewRotation;
  const cos = Math.cos(deltaAngle);
  const sin = Math.sin(deltaAngle);

  const rotatedVX = vX * cos - vY * sin;
  const rotatedVY = vX * sin + vY * cos;

  const scaleRatio = newScale / initialViewScale;
  const scaledVX = rotatedVX * scaleRatio;
  const scaledVY = rotatedVY * scaleRatio;

  viewOffsetX = currentCenter.x - scaledVX;
  viewOffsetY = currentCenter.y - scaledVY;
  viewScale = newScale;
  viewRotation = newRotation;

  updateViewTransform();
}

// Wheel support for desktop
container.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) {
    const zoomSpeed = 0.01;
    const oldScale = viewScale;
    viewScale -= e.deltaY * zoomSpeed;
    viewScale = Math.max(0.1, Math.min(viewScale, 10));

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    viewOffsetX = mouseX - (mouseX - viewOffsetX) * (viewScale / oldScale);
    viewOffsetY = mouseY - (mouseY - viewOffsetY) * (viewScale / oldScale);
  } else {
    viewOffsetX -= e.deltaX;
    viewOffsetY -= e.deltaY;
  }
  updateViewTransform();
}, { passive: false });

// Keyboard undo/redo for desktop
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      performRedo();
    } else {
      performUndo();
    }
  }
});

// ===================================================================
// Init
// ===================================================================
function init() {
  initCanvasSize(1024, 768);
  addLayerInternal('Background');
  // Fill background layer white
  const bg = getActiveLayer()!;
  bg.ctx.fillStyle = '#ffffff';
  bg.ctx.fillRect(0, 0, canvasLogicalW, canvasLogicalH);
  addLayerInternal('Layer 1');
  compositeAndDisplay();

  updateColorDisplay(new Color('#000000'));

  viewOffsetX = (container.clientWidth - canvasLogicalW) / 2;
  viewOffsetY = (container.clientHeight - canvasLogicalH) / 2;
  updateViewTransform();
}

init();
