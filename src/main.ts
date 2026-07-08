import Color from 'colorjs.io';
import type { Layer } from './types';
import type { SaveData, LayerData, CanvasMetadata } from './storage';
import { getStorageUsage, getSavedCanvasesMetadata, saveCanvas, loadCanvas, clearAllCanvases, deleteLocalCanvas } from './storage';
import { isGDriveConnected, downloadDriveFile, deleteDriveFile, saveToDrive } from './gdrive';
import { layers, activeLayerId, nextLayerId, setActiveLayerId, setNextLayerId, canvasLogicalW, canvasLogicalH, currentCanvasId, setCurrentCanvasId, setViewOffsetX, setViewOffsetY, undoStack, redoStack } from './state';
import { startScreen, paintApp, btnNewCanvas, storageInfoEl, savedCanvasesListEl, btnSettings, settingsDropdown, btnSave, btnDownload, btnBackToStart, displayCanvas, container } from './dom';
import { initCanvasSize, compositeAndDisplay, updateViewTransform, createLayerCanvas, generateThumbnail } from './canvas';
import { addLayerInternal, getActiveLayer, renderLayerList, initLayerListeners } from './layers';
import { showToast } from './undo';
import { updateColorDisplay, resetToolToPen, initDrawingListeners } from './drawing';
import { initInputListeners } from './input';
import { getGDriveIndex, saveGDriveIndex, generateNewCanvasIdAsync, initGDriveListeners, setRenderStartScreenCallback } from './gdrive-ui';

// ===================================================================
// Init & Storage
// ===================================================================
function initNewCanvas() {
  setCurrentCanvasId(null);
  undoStack.length = 0;
  redoStack.length = 0;
  resetToolToPen();
  
  const startWInput = document.getElementById('start-canvas-w') as HTMLInputElement;
  const startHInput = document.getElementById('start-canvas-h') as HTMLInputElement;
  const w = parseInt(startWInput?.value || '1024', 10) || 1024;
  const h = parseInt(startHInput?.value || '768', 10) || 768;
  
  initCanvasSize(w, h);
  layers.forEach(l => l.canvas.remove());
  layers.length = 0;
  setNextLayerId(0);
  setActiveLayerId(-1);

  addLayerInternal('Background');
  const bg = getActiveLayer()!;
  bg.ctx.fillStyle = '#ffffff';
  bg.ctx.fillRect(0, 0, canvasLogicalW, canvasLogicalH);
  addLayerInternal('Layer 1');
  compositeAndDisplay();

  updateColorDisplay(new Color('#000000'));

  setViewOffsetX((container.clientWidth - canvasLogicalW) / 2);
  setViewOffsetY((container.clientHeight - canvasLogicalH) / 2);
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
  
  setCurrentCanvasId(data.id);
  undoStack.length = 0;
  redoStack.length = 0;
  resetToolToPen();
  startScreen.style.display = 'none';
  paintApp.style.display = 'flex';
  
  initCanvasSize(data.canvas.w, data.canvas.h);
  
  layers.forEach(l => l.canvas.remove());
  layers.length = 0;
  setNextLayerId(data.nextLayerId);
  setActiveLayerId(data.activeLayerId);
  
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
  setViewOffsetX((container.clientWidth - canvasLogicalW) / 2);
  setViewOffsetY((container.clientHeight - canvasLogicalH) / 2);
  updateViewTransform();
}

// ===================================================================
// Start Screen Rendering
// ===================================================================
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
      const thumbHtml = save.thumbnail
        ? `<div class="canvas-thumbnail"><img src="${save.thumbnail}" alt="thumbnail" /></div>`
        : `<div class="canvas-thumbnail fallback"><i data-lucide="image" style="width:24px; height:24px; color: var(--muted-foreground);"></i></div>`;

      html += `
        <div class="canvas-item" data-id="${save.id}" data-gdrive-id="${save.gdriveFileId || ''}">
          ${thumbHtml}
          <div class="canvas-item-info">
            <span class="canvas-item-name">${save.name}</span>
            <span class="canvas-item-date">${date}</span>
          </div>
          <button class="canvas-item-delete" title="削除">
            <i data-lucide="trash-2" style="width:16px; height:16px;"></i>
          </button>
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

      const btnDelete = item.querySelector('.canvas-item-delete');
      if (btnDelete) {
        btnDelete.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = item.getAttribute('data-id')!;
          const gdriveId = item.getAttribute('data-gdrive-id');
          const name = item.querySelector('.canvas-item-name')?.textContent || '無題のキャンバス';

          const confirmClear = confirm(`本当にキャンバス「${name}」を削除しますか？\nこの操作は取り消せません。`);
          if (confirmClear) {
            if (isGDriveConnected() && gdriveId) {
              showToast('Google ドライブから削除中...');
              try {
                await deleteDriveFile(gdriveId);
                const index = await getGDriveIndex();
                const newIndex = index.filter(m => m.id !== id);
                await saveGDriveIndex(newIndex);
                showToast('削除しました');
              } catch (err: any) {
                showToast(`削除に失敗しました: ${err.message}`);
              }
            } else {
              deleteLocalCanvas(id);
              showToast('削除しました');
            }
            renderStartScreen();
          }
        });
      }
    });
  }
  
  if ((window as any).lucide) {
    (window as any).lucide.createIcons();
  }
}

// Register renderStartScreen callback for GDrive UI
setRenderStartScreenCallback(renderStartScreen);

// ===================================================================
// UI Listeners
// ===================================================================
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
  let canvasId = currentCanvasId;
  if (!canvasId) {
    canvasId = await generateNewCanvasIdAsync();
    setCurrentCanvasId(canvasId);
  }
  
  const layerData: LayerData[] = layers.map(l => ({
    id: l.id,
    name: l.name,
    visible: l.visible,
    data: l.canvas.toDataURL('image/png'),
    clipped: l.clipped
  }));
  
  const thumbnailDataUrl = generateThumbnail(displayCanvas);

  const saveData: SaveData = {
    version: 1,
    id: canvasId,
    name: '無題のキャンバス',
    updatedAt: new Date().toISOString(),
    canvas: { w: canvasLogicalW, h: canvasLogicalH },
    activeLayerId,
    nextLayerId,
    layers: layerData,
    thumbnail: thumbnailDataUrl
  };
  
  if (isGDriveConnected()) {
    showToast('Google ドライブへ保存中...');
    try {
      const fileId = await saveToDrive(`${canvasId}.json`, JSON.stringify(saveData));
      let thumbnail = saveData.thumbnail || '';
      if (!thumbnail && saveData.layers && saveData.layers.length > 0) {
        thumbnail = saveData.layers[0].data;
      }
      const index = await getGDriveIndex();
      const existingIdx = index.findIndex(m => m.id === canvasId);
      const meta: CanvasMetadata = {
        id: canvasId as string,
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
      
      showToast('Google ドライブに保存しました');
      renderStartScreen();
    } catch (err: any) {
      showToast(`保存に失敗しました: ${err.message}`);
    }
  } else {
    if (saveCanvas(saveData)) {
      showToast('ローカルに保存しました');
      renderStartScreen();
    } else {
      showToast('保存に失敗しました（ストレージ容量不足）');
    }
  }
});

btnDownload.addEventListener('click', () => {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvasLogicalW;
  tempCanvas.height = canvasLogicalH;
  const tempCtx = tempCanvas.getContext('2d')!;
  
  tempCtx.fillStyle = '#ffffff';
  tempCtx.fillRect(0, 0, canvasLogicalW, canvasLogicalH);
  
  const tempGroupCanvas = document.createElement('canvas');
  tempGroupCanvas.width = canvasLogicalW;
  tempGroupCanvas.height = canvasLogicalH;
  const tempGroupCtx = tempGroupCanvas.getContext('2d')!;

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

// Back to Start screen event listener
if (btnBackToStart) {
  btnBackToStart.addEventListener('click', async () => {
    if (undoStack.length > 0) {
      const confirmBack = confirm("キャンバスを閉じてスタート画面に戻りますか？\n保存していない変更は失われます。");
      if (!confirmBack) return;
    }
    
    undoStack.length = 0;
    redoStack.length = 0;
    setCurrentCanvasId(null);
    
    paintApp.style.display = 'none';
    startScreen.style.display = 'flex';
    
    await renderStartScreen();
  });
}

// ===================================================================
// Initialize all listeners
// ===================================================================
initDrawingListeners();
initLayerListeners();
initInputListeners();
initGDriveListeners();

// Initial render
renderStartScreen();

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
