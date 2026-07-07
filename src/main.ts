import './style.css';
import Color from 'colorjs.io';
import { getStorageUsage, getSavedCanvasesMetadata, generateNewCanvasId, saveCanvas, loadCanvas, clearAllCanvases, getAllLocalCanvasIds, deleteLocalCanvas } from './storage';
import type { SaveData, LayerData, CanvasMetadata } from './storage';
import {
  initAndLoginGDrive, logoutGDrive, tryRestoreToken,
  isGDriveConnected,
  getGDriveUserInfo,
  saveToDrive,
  findDriveFileId,
  downloadDriveFile,
  deleteDriveFile
} from './gdrive';


// ===================================================================
// GDrive State & Index
// ===================================================================
let gdriveIndex: CanvasMetadata[] | null = null;

async function getGDriveIndex(): Promise<CanvasMetadata[]> {
  if (gdriveIndex) return gdriveIndex;
  try {
    const fileId = await findDriveFileId('canvas_index.json');
    if (fileId) {
      const content = await downloadDriveFile(fileId);
      gdriveIndex = JSON.parse(content);
    } else {
      gdriveIndex = [];
    }
  } catch (err) {
    console.error('Failed to get GDrive index', err);
    gdriveIndex = [];
  }
  return gdriveIndex!;
}

async function saveGDriveIndex(index: CanvasMetadata[]) {
  gdriveIndex = index;
  await saveToDrive('canvas_index.json', JSON.stringify(index));
}

async function generateNewCanvasIdAsync(): Promise<string> {
  if (isGDriveConnected()) {
    const index = await getGDriveIndex();
    let maxIndex = -1;
    for (const meta of index) {
      if (meta.id.startsWith('paint_canvas_')) {
        const idxStr = meta.id.replace('paint_canvas_', '');
        const idx = parseInt(idxStr, 10);
        if (!isNaN(idx) && idx > maxIndex) {
          maxIndex = idx;
        }
      }
    }
    return `paint_canvas_${maxIndex + 1}`;
  } else {
    return generateNewCanvasId();
  }
}

async function migrateLocalDataToDrive() {
  const localIds = getAllLocalCanvasIds();
  if (localIds.length === 0) return;
  
  const confirmMigrate = confirm(`ローカルに ${localIds.length} 件のデータがあります。Googleドライブへアップロード（同期）しますか？`);
  if (!confirmMigrate) return;
  
  const index = await getGDriveIndex();
  const gdriveStatusEl = document.getElementById('gdrive-status');
  if (gdriveStatusEl) gdriveStatusEl.textContent = 'マイグレーション中...';
  
  for (const id of localIds) {
    const saveData = loadCanvas(id);
    if (!saveData) continue;
    
    // ID Collision Check & Auto-Renaming
    let targetId = id;
    const exists = index.some(m => m.id === id);
    if (exists) {
      let maxIndex = -1;
      for (const meta of index) {
        if (meta.id.startsWith('paint_canvas_')) {
          const idxStr = meta.id.replace('paint_canvas_', '');
          const idx = parseInt(idxStr, 10);
          if (!isNaN(idx) && idx > maxIndex) {
            maxIndex = idx;
          }
        }
      }
      targetId = `paint_canvas_${maxIndex + 1}`;
      saveData.id = targetId; // update internal id to avoid confusion
    }
    
    // Upload file
    const fileId = await saveToDrive(`${targetId}.json`, JSON.stringify(saveData));
    
    let thumbnail = '';
    if (saveData.layers && saveData.layers.length > 0) {
      thumbnail = saveData.layers[0].data; // Bottom layer as thumbnail
    }
    
    const existingIdx = index.findIndex(m => m.id === targetId);
    const meta: CanvasMetadata = {
      id: targetId,
      name: saveData.name || '無題のキャンバス',
      updatedAt: saveData.updatedAt || new Date().toISOString(),
      thumbnail,
      gdriveFileId: fileId
    };
    
    if (existingIdx >= 0) {
      index[existingIdx] = meta;
    } else {
      index.push(meta);
    }
  }
  
  await saveGDriveIndex(index);
  localIds.forEach(id => deleteLocalCanvas(id));
  
  showToast('マイグレーション完了');
  if (gdriveStatusEl) gdriveStatusEl.textContent = '同期完了しました';
  setTimeout(updateGDriveStatusUI, 2000);
}

function updateGDriveStatusUI(errorMessage?: string) {
  const gdriveStatusEl = document.getElementById('gdrive-status');
  const btnGDriveConnect = document.getElementById('btn-gdrive-connect') as HTMLButtonElement;
  if (!gdriveStatusEl || !btnGDriveConnect) return;
  
  if (isGDriveConnected()) {
    const user = getGDriveUserInfo();
    gdriveStatusEl.textContent = `接続中 (${user?.email || 'Unknown'})`;
    gdriveStatusEl.style.color = '#34A853';
    btnGDriveConnect.textContent = '接続解除';
    btnGDriveConnect.disabled = false;
    btnGDriveConnect.style.background = 'var(--destructive)';
    btnGDriveConnect.style.color = 'var(--destructive-foreground)';
  } else {
    gdriveStatusEl.textContent = errorMessage || '未接続';
    gdriveStatusEl.style.color = errorMessage ? 'var(--destructive)' : 'var(--muted-foreground)';
    btnGDriveConnect.textContent = 'ドライブと接続';
    btnGDriveConnect.disabled = false;
    btnGDriveConnect.style.background = '#4285F4';
    btnGDriveConnect.style.color = 'white';
  }
}

// ===================================================================
// HTML
// ===================================================================
const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div id="start-screen" class="start-screen">
    <div class="start-content">
      <h1>Paint</h1>
      
      <div style="display: flex; gap: 12px; margin-bottom: 24px; width: 100%;">
        <button id="btn-new-canvas" class="start-button" style="flex: 2;">
          <i data-lucide="plus"></i> 新規作成
        </button>
        <button id="btn-start-settings" class="start-button secondary" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 16px;">
          <i data-lucide="settings"></i> 設定
        </button>
      </div>

      <div id="storage-info" class="storage-info" style="margin-top: 20px;"></div>
      <div id="saved-canvases-list" class="saved-canvases-list" style="margin-top: 12px;"></div>
    </div>

    <!-- Settings Modal -->
    <div id="start-settings-modal" class="start-modal">
      <div class="start-modal-content">
        <button id="btn-close-start-settings" class="start-modal-close">
          <i data-lucide="x" style="width: 20px; height: 20px;"></i>
        </button>
        
        <h2 style="margin-top: 0; margin-bottom: 20px; font-size: 18px; font-weight: bold; border-bottom: 1px solid var(--border); padding-bottom: 10px;">設定</h2>
        
        <div class="start-settings-panel" style="margin-bottom: 20px;">
          <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 14px; font-weight: bold;">新規キャンバスサイズ</h3>
          <div class="start-settings-row">
            <label>キャンバスの幅 (px)</label>
            <input type="number" id="start-canvas-w" value="1024" min="100" max="4096" />
          </div>
          <div class="start-settings-row">
            <label>キャンバスの高さ (px)</label>
            <input type="number" id="start-canvas-h" value="768" min="100" max="4096" />
          </div>
        </div>

        <div class="gdrive-settings" style="background: var(--secondary); padding: 16px; border-radius: 8px;">
          <h3 style="margin-top: 0; margin-bottom: 12px; font-size: 14px; font-weight: bold; display: flex; align-items: center; gap: 6px;">
            <i data-lucide="cloud"></i> Google ドライブ連携
          </h3>
          <div class="start-settings-row">
            <label>クライアントID</label>
            <input type="text" id="gdrive-client-id" placeholder="OAuth Client ID" style="font-size: 12px;" />
          </div>
          <div class="button-row" style="margin-top: 12px; display: flex; gap: 8px;">
            <button id="btn-save-gdrive-creds" class="start-button secondary" style="flex: 1; height: 32px; font-size: 12px;">保存</button>
            <button id="btn-gdrive-connect" class="start-button" style="flex: 1; height: 32px; font-size: 12px; background: #4285F4; color: white;">接続</button>
          </div>
          <div id="gdrive-status" style="margin-top: 8px; font-size: 12px; color: var(--muted-foreground);">未接続</div>
        </div>
      </div>
    </div>
  </div>

  <div id="paint-app" class="paint-app" style="display: none;">
    <div id="canvas-container">
      <div id="canvas-wrapper">
        <canvas id="display-canvas"></canvas>
      </div>
    </div>



    <div class="layer-panel panel-card" id="layer-panel">
      <div class="layer-panel-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span>Layers</span>
          <button id="btn-add-layer" title="Add layer" class="icon-btn sm"><i data-lucide="plus"></i></button>
        </div>
      </div>
      <div class="layer-actions-row">
        <button id="btn-active-clip" title="Toggle clipping mask" class="icon-btn sm"><i data-lucide="corner-down-right"></i></button>
        <button id="btn-active-fill" title="Fill layer elements with current color" class="icon-btn sm"><i data-lucide="palette"></i></button>
        <button id="btn-active-delete" title="Delete selected layer" class="icon-btn sm"><i data-lucide="trash-2"></i></button>
      </div>
      <div class="layer-list" id="layer-list"></div>
    </div>

    <div class="toolbar panel-card">
      <div class="tool-group">
        <button id="btn-toggle-tool" class="icon-btn" title="Pen"><i data-lucide="pen-tool"></i></button>
      </div>



      <div class="tool-group slider-group">
        <label>Size: <span id="size-val">5</span>px</label>
        <input type="range" id="size-slider" min="0" max="100" value="35" />
      </div>

      <div class="tool-group color-picker-group">
        <div class="color-picker-wrapper">
          <div class="color-preview" id="color-preview"></div>
          <input type="color" id="color-input" value="#000000" />
        </div>

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
        <input type="range" id="stab-slider" min="0" max="100" value="56" />
      </div>

      <div class="tool-group" style="position: relative;">
        <button id="btn-settings" class="icon-btn" title="Settings"><i data-lucide="settings"></i></button>
        <div id="settings-dropdown" class="settings-dropdown panel-card">
          <button id="btn-save" class="start-button" style="height: 36px; padding: 0 12px; width: 100%; white-space: nowrap;">
            <i data-lucide="save"></i> 保存
          </button>
          <button id="btn-download" class="start-button" style="height: 36px; padding: 0 12px; width: 100%; white-space: nowrap; background-color: var(--secondary); color: var(--secondary-foreground);">
            <i data-lucide="download"></i> PNG 保存
          </button>
        </div>
      </div>
    </div>

    <div class="undo-toast" id="undo-toast"></div>
  </div>
`;

// Initialize standard icons
if ((window as any).lucide) {
  (window as any).lucide.createIcons();
}

// ===================================================================
// DOM Elements
// ===================================================================
const startScreen = document.getElementById('start-screen') as HTMLDivElement;
const paintApp = document.getElementById('paint-app') as HTMLDivElement;
const btnNewCanvas = document.getElementById('btn-new-canvas') as HTMLButtonElement;
const storageInfoEl = document.getElementById('storage-info') as HTMLDivElement;
const savedCanvasesListEl = document.getElementById('saved-canvases-list') as HTMLDivElement;

const displayCanvas = document.getElementById('display-canvas') as HTMLCanvasElement;
const canvasWrapper = document.getElementById('canvas-wrapper') as HTMLDivElement;
const container = document.getElementById('canvas-container') as HTMLDivElement;
const displayCtx = displayCanvas.getContext('2d')!;

const btnToggleTool = document.getElementById('btn-toggle-tool') as HTMLButtonElement;
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
const settingsDropdown = document.getElementById('settings-dropdown') as HTMLDivElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
const sizeSlider = document.getElementById('size-slider') as HTMLInputElement;
const sizeValEl = document.getElementById('size-val') as HTMLSpanElement;

const colorPreview = document.getElementById('color-preview') as HTMLDivElement;
const colorInput = document.getElementById('color-input') as HTMLInputElement;
const oklchL = document.getElementById('oklch-l') as HTMLInputElement;
const oklchC = document.getElementById('oklch-c') as HTMLInputElement;
const oklchH = document.getElementById('oklch-h') as HTMLInputElement;

const stabSlider = document.getElementById('stab-slider') as HTMLInputElement;
const stabValEl = document.getElementById('stab-val') as HTMLSpanElement;



const btnAddLayer = document.getElementById('btn-add-layer') as HTMLButtonElement;
const btnActiveClip = document.getElementById('btn-active-clip') as HTMLButtonElement;
const btnActiveFill = document.getElementById('btn-active-fill') as HTMLButtonElement;
const btnActiveDelete = document.getElementById('btn-active-delete') as HTMLButtonElement;
const layerListEl = document.getElementById('layer-list') as HTMLDivElement;
const layerPanelEl = document.getElementById('layer-panel') as HTMLDivElement;
const undoToastEl = document.getElementById('undo-toast') as HTMLDivElement;

let groupCanvas: HTMLCanvasElement | null = null;
let groupCtx: CanvasRenderingContext2D | null = null;

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
  clipped: boolean;
}

let currentTool: 'pen' | 'eraser' = 'pen';
let currentSize = 5;
let currentColor = '#000000';

let currentCanvasId: string | null = null;

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
const activeTouchPointers: Map<number, PointerEvent> = new Map();
let drawingPointerId: number | null = null;

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
    clipped: false,
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
    clipped: layerToDelete.clipped
  });
}

function getActiveLayer(): Layer | undefined {
  return layers.find(l => l.id === activeLayerId);
}

const oklchColorCache: { [key: number]: string } = {};
function getMaxChromaColor(h: number): string {
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

function fillLayerColor(layerId: number, colorHex: string) {
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

function finalizeReorder() {
  const draggingItem = layerListEl.querySelector('.layer-item.dragging') as HTMLDivElement;
  if (draggingItem) {
    draggingItem.classList.remove('dragging');
  }
  
  const children = Array.from(layerListEl.children);
  const newOrderIds = children.map(child => parseInt(child.getAttribute('data-id')!, 10));
  newOrderIds.reverse();
  
  const currentOrderIds = layers.map(l => l.id);
  const orderChanged = newOrderIds.some((id, idx) => id !== currentOrderIds[idx]);
  
  if (orderChanged) {
    const prevOrder = [...currentOrderIds];
    const prevClippedStates: { [layerId: number]: boolean } = {};
    layers.forEach(l => {
      prevClippedStates[l.id] = l.clipped;
    });

    layers.sort((a, b) => newOrderIds.indexOf(a.id) - newOrderIds.indexOf(b.id));
    
    // Bottom-most layer cannot be clipped
    if (layers.length > 0 && layers[0].clipped) {
      layers[0].clipped = false;
    }
    
    const clippedStates: { [layerId: number]: boolean } = {};
    layers.forEach(l => {
      clippedStates[l.id] = l.clipped;
    });

    pushUndo({
      type: 'reorderLayers',
      layersOrder: [...newOrderIds],
      prevLayersOrder: prevOrder,
      clippedStates,
      prevClippedStates
    });
    
    compositeAndDisplay();
  }
  
  renderLayerList();
}

function renderLayerList() {
  layerListEl.innerHTML = '';
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const item = document.createElement('div');
    item.className = 'layer-item' + (layer.id === activeLayerId ? ' selected' : '') + (layer.clipped ? ' clipped' : '');
    item.setAttribute('data-id', layer.id.toString());



    const vis = document.createElement('span');
    vis.className = 'layer-visibility icon-btn sm';
    vis.innerHTML = layer.visible ? '<i data-lucide="eye"></i>' : '<i data-lucide="eye-off"></i>';
    vis.addEventListener('click', (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      renderLayerList();
      compositeAndDisplay();
    });

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    const grip = document.createElement('span');
    grip.className = 'layer-grip icon-btn sm';
    grip.innerHTML = '<i data-lucide="grip-vertical"></i>';
    grip.title = 'Drag to reorder';
    
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      
      const rect = item.getBoundingClientRect();
      const startY = e.clientY;
      const startTop = rect.top;
      
      const placeholder = document.createElement('div');
      placeholder.className = 'layer-item placeholder';
      placeholder.style.height = `${rect.height}px`;
      placeholder.style.background = 'var(--muted)';
      placeholder.style.border = '1px dashed var(--border)';
      placeholder.style.opacity = '0.5';
      placeholder.style.borderRadius = 'calc(var(--radius) - 2px)';
      placeholder.style.boxSizing = 'border-box';
      
      layerListEl.insertBefore(placeholder, item);
      
      item.classList.add('dragging');
      item.style.position = 'fixed';
      item.style.top = `${startTop}px`;
      item.style.left = `${rect.left}px`;
      item.style.width = `${rect.width}px`;
      item.style.height = `${rect.height}px`;
      item.style.zIndex = '9999';
      item.style.boxSizing = 'border-box';
      item.style.margin = '0';
      
      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        const deltaY = ev.clientY - startY;
        item.style.transform = `translateY(${deltaY}px)`;
        
        item.style.visibility = 'hidden';
        const elementUnder = document.elementFromPoint(ev.clientX, ev.clientY);
        item.style.visibility = '';
        
        const targetItem = elementUnder?.closest('.layer-item:not(.dragging)') as HTMLDivElement;
        if (targetItem && targetItem !== placeholder) {
          const children = Array.from(layerListEl.children).filter(c => c !== item);
          const pIdx = children.indexOf(placeholder);
          const tIdx = children.indexOf(targetItem);
          if (pIdx < tIdx) {
            layerListEl.insertBefore(placeholder, targetItem.nextSibling);
          } else {
            layerListEl.insertBefore(placeholder, targetItem);
          }
        }
      };
      
      const onUp = (ev: PointerEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onUp);
        try { grip.releasePointerCapture(ev.pointerId); } catch(err){}
        
        layerListEl.insertBefore(item, placeholder);
        placeholder.remove();
        
        item.style.position = '';
        item.style.top = '';
        item.style.left = '';
        item.style.width = '';
        item.style.height = '';
        item.style.zIndex = '';
        item.style.margin = '';
        item.style.transform = '';
        
        finalizeReorder();
      };
      
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onUp);
    });

    const colorCircle = document.createElement('span');
    colorCircle.className = 'layer-color-circle';
    const H = (layer.id % 8) * 45;
    colorCircle.style.backgroundColor = getMaxChromaColor(H);

    item.appendChild(vis);

    // Clipping mask L-arrow indicator
    if (layer.clipped) {
      const clipIndicator = document.createElement('span');
      clipIndicator.className = 'layer-clip-indicator';
      clipIndicator.innerHTML = '<i data-lucide="corner-down-right"></i>';
      item.appendChild(clipIndicator);
    }

    item.appendChild(colorCircle);
    item.appendChild(spacer);
    item.appendChild(grip);

    item.addEventListener('click', () => {
      activeLayerId = layer.id;
      renderLayerList();
    });

    layerListEl.appendChild(item);
  }

  // Update selected layer actions row state
  const activeLayer = getActiveLayer();
  if (activeLayer) {
    const activeIdx = layers.indexOf(activeLayer);
    
    // Clipping mask toggle button
    btnActiveClip.disabled = (activeIdx === 0);
    if (activeLayer.clipped) {
      btnActiveClip.classList.add('active');
    } else {
      btnActiveClip.classList.remove('active');
    }

    // Delete button
    btnActiveDelete.disabled = (layers.length <= 1);
  } else {
    btnActiveClip.disabled = true;
    btnActiveClip.classList.remove('active');
    btnActiveDelete.disabled = true;
  }
  
  if ((window as any).lucide) {
    (window as any).lucide.createIcons({
      root: layerPanelEl
    });
  }
}

btnAddLayer.addEventListener('click', () => {
  addLayer();
  compositeAndDisplay();
});

btnActiveClip.addEventListener('click', () => {
  const activeLayer = getActiveLayer();
  if (!activeLayer) return;
  const idx = layers.indexOf(activeLayer);
  if (idx === 0) return;
  
  activeLayer.clipped = !activeLayer.clipped;
  
  pushUndo({
    type: 'toggleClip',
    layerId: activeLayer.id,
    clipped: activeLayer.clipped
  });
  
  renderLayerList();
  compositeAndDisplay();
});

btnActiveFill.addEventListener('click', () => {
  const activeLayer = getActiveLayer();
  if (!activeLayer) return;
  fillLayerColor(activeLayer.id, currentColor);
});

btnActiveDelete.addEventListener('click', () => {
  const activeLayer = getActiveLayer();
  if (!activeLayer) return;
  deleteLayer(activeLayer.id);
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
  clipped?: boolean;
}

interface DeleteLayerUndoEntry {
  type: 'deleteLayer';
  layerId: number;
  layerIndex: number;
  layerName: string;
  imageData: ImageData;
  prevActiveLayerId: number;
  clipped?: boolean;
}

interface ReorderLayersUndoEntry {
  type: 'reorderLayers';
  layersOrder: number[];
  prevLayersOrder: number[];
  clippedStates?: { [layerId: number]: boolean };
  prevClippedStates?: { [layerId: number]: boolean };
}

interface ToggleClipUndoEntry {
  type: 'toggleClip';
  layerId: number;
  clipped: boolean;
}

type UndoEntry = StrokeUndoEntry | AddLayerUndoEntry | DeleteLayerUndoEntry | ReorderLayersUndoEntry | ToggleClipUndoEntry;

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
        clipped: entry.clipped || false
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
        clipped: entry.clipped || false,
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
    case 'reorderLayers': {
      const order = entry.prevLayersOrder;
      layers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      
      // Restore previous clipped states if available
      if (entry.prevClippedStates) {
        layers.forEach(l => {
          if (entry.prevClippedStates![l.id] !== undefined) {
            l.clipped = entry.prevClippedStates![l.id];
          }
        });
      }

      redoStack.push({
        type: 'reorderLayers',
        layersOrder: entry.layersOrder,
        prevLayersOrder: entry.prevLayersOrder,
        clippedStates: entry.clippedStates,
        prevClippedStates: entry.prevClippedStates
      });
      renderLayerList();
      break;
    }
    case 'toggleClip': {
      const layer = layers.find(l => l.id === entry.layerId);
      if (layer) {
        redoStack.push({
          type: 'toggleClip',
          layerId: entry.layerId,
          clipped: layer.clipped
        });
        layer.clipped = entry.clipped;
        renderLayerList();
      }
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
        clipped: entry.clipped || false,
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
        clipped: entry.clipped || false
      });
      renderLayerList();
      break;
    }
    case 'reorderLayers': {
      const order = entry.layersOrder;
      layers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

      // Restore clipped states if available
      if (entry.clippedStates) {
        layers.forEach(l => {
          if (entry.clippedStates![l.id] !== undefined) {
            l.clipped = entry.clippedStates![l.id];
          }
        });
      }

      undoStack.push({
        type: 'reorderLayers',
        layersOrder: entry.layersOrder,
        prevLayersOrder: entry.prevLayersOrder,
        clippedStates: entry.clippedStates,
        prevClippedStates: entry.prevClippedStates
      });
      renderLayerList();
      break;
    }
    case 'toggleClip': {
      const layer = layers.find(l => l.id === entry.layerId);
      if (layer) {
        undoStack.push({
          type: 'toggleClip',
          layerId: entry.layerId,
          clipped: layer.clipped
        });
        layer.clipped = entry.clipped;
        renderLayerList();
      }
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

  if (!groupCanvas) {
    groupCanvas = document.createElement('canvas');
  }
  groupCanvas.width = w * dpr;
  groupCanvas.height = h * dpr;
  groupCtx = groupCanvas.getContext('2d')!;

  displayCtx.scale(dpr, dpr);
}

function compositeAndDisplay() {
  const dpr = window.devicePixelRatio || 1;
  displayCtx.setTransform(1, 0, 0, 1, 0, 0);
  // White background
  displayCtx.fillStyle = '#ffffff';
  displayCtx.fillRect(0, 0, displayCanvas.width, displayCanvas.height);

  if (!groupCanvas || !groupCtx) {
    displayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return;
  }

  // Draw layers bottom-to-top with clipping masks
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const isClipped = layer.clipped;
    const nextIsClipped = (i + 1 < layers.length) && layers[i + 1].clipped;

    if (isClipped) {
      if (layer.visible) {
        groupCtx.globalCompositeOperation = 'source-atop';
        groupCtx.drawImage(layer.canvas, 0, 0);
      }
      if (!nextIsClipped) {
        displayCtx.drawImage(groupCanvas, 0, 0);
      }
    } else {
      if (nextIsClipped) {
        groupCtx.clearRect(0, 0, groupCanvas.width, groupCanvas.height);
        if (layer.visible) {
          groupCtx.globalCompositeOperation = 'source-over';
          groupCtx.drawImage(layer.canvas, 0, 0);
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
function resetToolToPen() {
  currentTool = 'pen';
  btnToggleTool.innerHTML = '<i data-lucide="pen-tool"></i>';
  btnToggleTool.title = 'Pen';
  if ((window as any).lucide) {
    (window as any).lucide.createIcons({ root: btnToggleTool });
  }
}

btnToggleTool.addEventListener('click', () => {
  if (currentTool === 'pen') {
    currentTool = 'eraser';
    btnToggleTool.innerHTML = '<i data-lucide="eraser"></i>';
    btnToggleTool.title = 'Eraser';
  } else {
    currentTool = 'pen';
    btnToggleTool.innerHTML = '<i data-lucide="pen-tool"></i>';
    btnToggleTool.title = 'Pen';
  }
  if ((window as any).lucide) {
    (window as any).lucide.createIcons({ root: btnToggleTool });
  }
});

btnSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsDropdown.classList.toggle('show');
});

document.addEventListener('click', (e) => {
  if (!settingsDropdown.contains(e.target as Node) && e.target !== btnSettings) {
    settingsDropdown.classList.remove('show');
  }
});

btnSave.addEventListener('click', async () => {
  if (!currentCanvasId) {
    currentCanvasId = await generateNewCanvasIdAsync();
  }
  
  const layerData: LayerData[] = layers.map(l => ({
    id: l.id,
    name: l.name,
    visible: l.visible,
    data: l.canvas.toDataURL('image/png'),
    clipped: l.clipped
  }));
  
  const saveData: SaveData = {
    version: 1,
    id: currentCanvasId,
    name: '無題のキャンバス',
    updatedAt: new Date().toISOString(),
    canvas: { w: canvasLogicalW, h: canvasLogicalH },
    activeLayerId,
    nextLayerId,
    layers: layerData
  };
  
  if (isGDriveConnected()) {
    showToast('Google ドライブへ保存中...');
    try {
      const fileId = await saveToDrive(`${currentCanvasId}.json`, JSON.stringify(saveData));
      let thumbnail = '';
      if (saveData.layers && saveData.layers.length > 0) {
        thumbnail = saveData.layers[0].data;
      }
      const index = await getGDriveIndex();
      const existingIdx = index.findIndex(m => m.id === currentCanvasId);
      const meta: CanvasMetadata = {
        id: currentCanvasId as string,
        name: saveData.name || '無題のキャンバス',
        updatedAt: saveData.updatedAt || new Date().toISOString(),
        thumbnail,
        gdriveFileId: fileId
      };
      if (existingIdx >= 0) {
        index[existingIdx] = meta;
      } else {
        index.push(meta);
      }
      await saveGDriveIndex(index);
      
      showToast('Saved to Google Drive');
      renderStartScreen();
    } catch (err: any) {
      showToast(`Drive Save Error: ${err.message}`);
    }
  } else {
    if (saveCanvas(saveData)) {
      showToast('Saved locally');
      renderStartScreen();
    } else {
      showToast('Failed to save (Storage full)');
    }
  }
});

btnDownload.addEventListener('click', () => {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvasLogicalW;
  tempCanvas.height = canvasLogicalH;
  const tempCtx = tempCanvas.getContext('2d')!;
  
  // Fill background white
  tempCtx.fillStyle = '#ffffff';
  tempCtx.fillRect(0, 0, canvasLogicalW, canvasLogicalH);
  
  const tempGroupCanvas = document.createElement('canvas');
  tempGroupCanvas.width = canvasLogicalW;
  tempGroupCanvas.height = canvasLogicalH;
  const tempGroupCtx = tempGroupCanvas.getContext('2d')!;

  // Draw visible layers bottom-to-top with clipping masks
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const isClipped = layer.clipped;
    const nextIsClipped = (i + 1 < layers.length) && layers[i + 1].clipped;

    if (isClipped) {
      if (layer.visible) {
        tempGroupCtx.globalCompositeOperation = 'source-atop';
        tempGroupCtx.drawImage(layer.canvas, 0, 0, canvasLogicalW, canvasLogicalH);
      }
      if (!nextIsClipped) {
        tempCtx.drawImage(tempGroupCanvas, 0, 0);
      }
    } else {
      if (nextIsClipped) {
        tempGroupCtx.clearRect(0, 0, canvasLogicalW, canvasLogicalH);
        if (layer.visible) {
          tempGroupCtx.globalCompositeOperation = 'source-over';
          tempGroupCtx.drawImage(layer.canvas, 0, 0, canvasLogicalW, canvasLogicalH);
        }
      } else {
        if (layer.visible) {
          tempCtx.drawImage(layer.canvas, 0, 0, canvasLogicalW, canvasLogicalH);
        }
      }
    }
  }
  
  const dataUrl = tempCanvas.toDataURL('image/png');
  const link = document.createElement('a');
  link.download = `${currentCanvasId ? currentCanvasId.replace('paint_canvas_', 'canvas_') : 'canvas'}.png`;
  link.href = dataUrl;
  link.click();
  showToast('PNG Downloaded');
});

sizeSlider.addEventListener('input', (e) => {
  const sliderVal = parseFloat((e.target as HTMLInputElement).value);
  const size = Math.pow(10, sliderVal / 50);
  currentSize = Math.max(1, Math.round(size));
  sizeValEl.innerText = currentSize.toString();
});

stabSlider.addEventListener('input', (e) => {
  const sliderVal = parseFloat((e.target as HTMLInputElement).value);
  lazyRadius = Math.round(12.5 * (Math.pow(3, sliderVal / 50) - 1));
  stabValEl.innerText = lazyRadius.toString();
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
    // Ramp up smoothing factor from positionSmoothing (0.07) to 0.35 over 200ms
    const t = Math.min(1, (elapsed - 40) / 200);
    currentSmoothing = positionSmoothing + (0.35 - positionSmoothing) * t;
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

// ===================================================================
// Tap Detection (2-finger undo, 3-finger redo)
// ===================================================================
function addTapRecord(e: PointerEvent) {
  if (drawingPointerId !== null) return;
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
  if (e.pointerType === 'touch') {
    activeTouchPointers.set(e.pointerId, e);
    addTapRecord(e);

    // Gestures (Pan/Zoom) only if not drawing
    if (drawingPointerId === null) {
      if (activeTouchPointers.size === 2) {
        initGesture();
      }
    }
  } else if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
    if (drawingPointerId === null) {
      drawingPointerId = e.pointerId;
      container.setPointerCapture(e.pointerId);

      // Cancel any ongoing tap detection from touch
      tapRecords = [];

      // Save undo state before drawing
      const layer = getActiveLayer();
      if (layer) saveUndoState(layer.id);
      isDrawing = true;
      smootherReset();
      smootherProcessPoint(getCanvasPoint(e.clientX, e.clientY));
    }
  }
});

container.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    if (activeTouchPointers.has(e.pointerId)) {
      activeTouchPointers.set(e.pointerId, e);
    }
    updateTapRecord(e);

    // Gestures (Pan/Zoom) only if not drawing
    if (drawingPointerId === null) {
      if (activeTouchPointers.size >= 2) {
        handleGesture();
      }
    }
  } else if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
    if (drawingPointerId === e.pointerId && isDrawing) {
      smootherProcessPoint(getCanvasPoint(e.clientX, e.clientY));
    }
  }
});

function handlePointerUp(e: PointerEvent) {
  if (e.pointerType === 'touch') {
    activeTouchPointers.delete(e.pointerId);
    try { container.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }

    // Multi-finger tap triggers only if we are not drawing
    if (drawingPointerId === null && activeTouchPointers.size === 0) {
      const fingerCount = checkTapOnAllUp();
      if (fingerCount === 2) {
        performUndo();
      } else if (fingerCount !== null && fingerCount >= 3) {
        performRedo();
      }
    }
  } else if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
    if (drawingPointerId === e.pointerId) {
      try { container.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      drawingPointerId = null;
      tapRecords = []; // Clear any residual touch taps
      if (isDrawing) {
        isDrawing = false;
        smootherReset();
      }
    }
  }
}

container.addEventListener('pointerup', handlePointerUp);
container.addEventListener('pointercancel', handlePointerUp);

// ===================================================================
// Gestures (Pan / Zoom)
// ===================================================================
function getPointers() {
  return Array.from(activeTouchPointers.values());
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
// Init & Storage
// ===================================================================
function initNewCanvas() {
  currentCanvasId = null;
  resetToolToPen();
  
  const startWInput = document.getElementById('start-canvas-w') as HTMLInputElement;
  const startHInput = document.getElementById('start-canvas-h') as HTMLInputElement;
  const w = parseInt(startWInput?.value || '1024', 10) || 1024;
  const h = parseInt(startHInput?.value || '768', 10) || 768;
  
  initCanvasSize(w, h);
  layers.forEach(l => l.canvas.remove());
  layers.length = 0;
  nextLayerId = 0;
  activeLayerId = -1;

  addLayerInternal('Background');
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

async function loadSavedCanvas(id: string, gdriveFileId?: string) {
  let data: SaveData | null = null;
  if (isGDriveConnected() && gdriveFileId) {
    showToast('Google ドライブから読み込み中...');
    try {
      const content = await downloadDriveFile(gdriveFileId);
      data = JSON.parse(content) as SaveData;
    } catch (e) {
      console.error('Failed to load from GDrive', e);
      alert('Google ドライブからの読み込みに失敗しました');
      return;
    }
  } else {
    data = loadCanvas(id);
    if (!data) {
      alert('キャンバスの読み込みに失敗しました');
      return;
    }
  }
  
  currentCanvasId = data.id;
  resetToolToPen();
  startScreen.style.display = 'none';
  paintApp.style.display = 'flex';
  
  initCanvasSize(data.canvas.w, data.canvas.h);
  
  layers.forEach(l => l.canvas.remove());
  layers.length = 0;
  nextLayerId = data.nextLayerId;
  activeLayerId = data.activeLayerId;
  
  let loadedCount = 0;
  data.layers.forEach(ld => {
    const { canvas, ctx } = createLayerCanvas();
    const l: Layer = {
      id: ld.id,
      name: ld.name,
      visible: ld.visible,
      canvas,
      ctx,
      clipped: ld.clipped || false
    };
    layers.push(l);
    
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvasLogicalW, canvasLogicalH);
      loadedCount++;
      if (loadedCount === data.layers.length) {
        renderLayerList();
        compositeAndDisplay();
      }
    };
    img.src = ld.data;
  });
  
  if (data.layers.length === 0) {
    renderLayerList();
    compositeAndDisplay();
  }
  
  updateColorDisplay(new Color('#000000'));
  viewOffsetX = (container.clientWidth - canvasLogicalW) / 2;
  viewOffsetY = (container.clientHeight - canvasLogicalH) / 2;
  updateViewTransform();
}

async function renderStartScreen() {
  const usage = getStorageUsage();
  storageInfoEl.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
      <span>Storage Usage: ${(usage.usedKB / 1024).toFixed(2)}MB / ${(usage.maxKB / 1024).toFixed(2)}MB (${usage.percentage}%)</span>
      <button id="btn-clear-storage" class="icon-btn" style="color: var(--destructive); cursor: pointer; background: transparent; border: none; display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: var(--radius); font-size: 11px;" title="Clear Storage">
        <i data-lucide="trash-2" style="width:14px; height:14px;"></i> Clear All
      </button>
    </div>
    <div class="storage-bar"><div class="storage-bar-fill" style="width: ${usage.percentage}%"></div></div>
  `;

  const btnClearStorage = document.getElementById('btn-clear-storage');
  if (btnClearStorage) {
    btnClearStorage.addEventListener('click', async () => {
      const confirmClear = confirm("本当にすべてのキャンバスデータを削除しますか？\nこの操作は取り消せません。");
      if (confirmClear) {
        if (isGDriveConnected()) {
          const index = await getGDriveIndex();
          showToast('Google ドライブから全削除中...');
          for (const meta of index) {
            if (meta.gdriveFileId) {
              await deleteDriveFile(meta.gdriveFileId);
            }
          }
          await saveGDriveIndex([]);
        }
        clearAllCanvases();
        renderStartScreen();
      }
    });
  }

  let saves: CanvasMetadata[] = [];
  if (isGDriveConnected()) {
    saves = await getGDriveIndex();
    saves.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } else {
    saves = getSavedCanvasesMetadata();
  }
  if (saves.length === 0) {
    savedCanvasesListEl.innerHTML = '<p style="text-align: center; color: var(--muted-foreground); font-size: 14px; margin-top: 24px;">保存されたキャンバスはありません</p>';
  } else {
    let html = '<h3>Saved Canvases</h3>';
    saves.forEach(save => {
      const date = new Date(save.updatedAt).toLocaleString();
      html += `
        <div class="canvas-item" data-id="${save.id}" data-gdrive-id="${save.gdriveFileId || ''}">
          <div class="canvas-item-info">
            <span class="canvas-item-name">${save.name}</span>
            <span class="canvas-item-date">${date}</span>
          </div>
          <i data-lucide="chevron-right" style="width:16px; height:16px; color: var(--muted-foreground);"></i>
        </div>
      `;
    });
    savedCanvasesListEl.innerHTML = html;

    const items = savedCanvasesListEl.querySelectorAll('.canvas-item');
    items.forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        const gdriveId = item.getAttribute('data-gdrive-id');
        if (id) {
          loadSavedCanvas(id, gdriveId || undefined);
        }
      });
    });
  }
  
  if ((window as any).lucide) {
    (window as any).lucide.createIcons();
  }
}

btnNewCanvas.addEventListener('click', () => {
  startScreen.style.display = 'none';
  paintApp.style.display = 'flex';
  initNewCanvas();
});

// Pre-fill width and height with visible screen sizes on load
const startWInput = document.getElementById('start-canvas-w') as HTMLInputElement;
const startHInput = document.getElementById('start-canvas-h') as HTMLInputElement;
if (startWInput && startHInput) {
  startWInput.value = window.innerWidth.toString();
  startHInput.value = window.innerHeight.toString();
}


// Initial render
renderStartScreen();

// GDrive Init
const gdriveClientIdInput = document.getElementById('gdrive-client-id') as HTMLInputElement;
const btnSaveGDriveCreds = document.getElementById('btn-save-gdrive-creds') as HTMLButtonElement;
const btnGDriveConnect = document.getElementById('btn-gdrive-connect') as HTMLButtonElement;
const gdriveStatusEl = document.getElementById('gdrive-status') as HTMLDivElement;

if (gdriveClientIdInput) {
  gdriveClientIdInput.value = localStorage.getItem('gdrive_client_id') || '';
}

if (btnSaveGDriveCreds) {
  btnSaveGDriveCreds.addEventListener('click', () => {
    localStorage.setItem('gdrive_client_id', gdriveClientIdInput.value.trim());
    showToast('クライアントIDを保存しました');
  });
}

if (btnGDriveConnect) {
  btnGDriveConnect.addEventListener('click', async () => {
    if (isGDriveConnected()) {
      // Disconnect
      logoutGDrive();
      localStorage.removeItem('gdrive_connected');
      updateGDriveStatusUI();
      showToast('Google ドライブの接続を解除しました');
      renderStartScreen();
      return;
    }

    const clientId = gdriveClientIdInput.value.trim();
    if (!clientId) {
      alert('クライアントIDを入力してください');
      return;
    }
    localStorage.setItem('gdrive_client_id', clientId);
    
    if (gdriveStatusEl) gdriveStatusEl.textContent = '接続中...';
    try {
      await initAndLoginGDrive(clientId, false);
      localStorage.setItem('gdrive_connected', 'true');
      updateGDriveStatusUI();
      showToast('Google ドライブに接続しました');
      
      await migrateLocalDataToDrive();
      
      renderStartScreen();
    } catch (err: any) {
      if (gdriveStatusEl) {
        gdriveStatusEl.textContent = `エラー: ${err.message}`;
        gdriveStatusEl.style.color = 'red';
      }
    }
  });
}
updateGDriveStatusUI();

// Start Settings Modal Interaction
const btnStartSettings = document.getElementById('btn-start-settings') as HTMLButtonElement;
const btnCloseStartSettings = document.getElementById('btn-close-start-settings') as HTMLButtonElement;
const startSettingsModal = document.getElementById('start-settings-modal') as HTMLDivElement;

if (btnStartSettings && startSettingsModal) {
  btnStartSettings.addEventListener('click', () => {
    startSettingsModal.classList.add('show');
  });
}

if (btnCloseStartSettings && startSettingsModal) {
  btnCloseStartSettings.addEventListener('click', () => {
    startSettingsModal.classList.remove('show');
  });
}

if (startSettingsModal) {
  startSettingsModal.addEventListener('click', (e) => {
    if (e.target === startSettingsModal) {
      startSettingsModal.classList.remove('show');
    }
  });
}

// Attempt silent login if previously connected
const savedClientId = localStorage.getItem('gdrive_client_id') || '';
const wasConnected = localStorage.getItem('gdrive_connected') === 'true';
if (savedClientId && wasConnected) {
  if (gdriveStatusEl) gdriveStatusEl.textContent = '自動接続中...';
  const checkAndSilentLogin = async () => {
    try {
      // 1. Try to restore valid token from localStorage (no network request needed for Auth)
      const restored = await tryRestoreToken();
      if (restored) {
        updateGDriveStatusUI();
        showToast('Google ドライブのセッションを復元しました');
        await renderStartScreen();
        return;
      }
      
      // 2. Otherwise try silent token request
      await initAndLoginGDrive(savedClientId, true);
      localStorage.setItem('gdrive_connected', 'true');
      updateGDriveStatusUI();
      showToast('Google ドライブに自動接続しました');
      await renderStartScreen();
    } catch (err) {
      console.log('Silent login failed (interaction required or offline):', err);
      updateGDriveStatusUI('自動同期に失敗しました（要サインイン）');
    }
  };
  
  if ((window as any).google && (window as any).google.accounts) {
    checkAndSilentLogin();
  } else {
    const timer = setInterval(() => {
      if ((window as any).google && (window as any).google.accounts) {
        clearInterval(timer);
        checkAndSilentLogin();
      }
    }, 100);
    setTimeout(() => clearInterval(timer), 5000);
  }
}


// ===================================================================
// Disable iOS Safari page zoom (viewport zoom) & double-tap zoom
// ===================================================================
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = performance.now();
  if (now - lastTouchEnd <= 300) {
    const target = e.target as HTMLElement;
    // Don't prevent default on UI controls (buttons, inputs) to keep fast-clicks working
    if (target && !['BUTTON', 'INPUT', 'SELECT', 'LABEL'].includes(target.tagName) && !target.closest('.layer-item')) {
      e.preventDefault();
    }
  }
  lastTouchEnd = now;
}, { passive: false });

// Disable right-click / long-press context menu globally
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

