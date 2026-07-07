import re

with open('src/main.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Insert GDrive Index logic
index_logic = """
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
    
    // Upload file
    const fileId = await saveToDrive(`${id}.json`, JSON.stringify(saveData));
    
    let thumbnail = '';
    if (saveData.layers && saveData.layers.length > 0) {
      thumbnail = saveData.layers[0].data; // Bottom layer as thumbnail
    }
    
    const existingIdx = index.findIndex(m => m.id === id);
    const meta: CanvasMetadata = {
      id,
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

function updateGDriveStatusUI() {
  const gdriveStatusEl = document.getElementById('gdrive-status');
  const btnGDriveConnect = document.getElementById('btn-gdrive-connect') as HTMLButtonElement;
  if (!gdriveStatusEl || !btnGDriveConnect) return;
  
  if (isGDriveConnected()) {
    const user = getGDriveUserInfo();
    gdriveStatusEl.textContent = `接続中 (${user?.email || 'Unknown'})`;
    gdriveStatusEl.style.color = '#34A853';
    btnGDriveConnect.textContent = '同期完了';
    btnGDriveConnect.disabled = true;
  } else {
    gdriveStatusEl.textContent = '未接続';
    gdriveStatusEl.style.color = 'var(--muted-foreground)';
    btnGDriveConnect.textContent = 'ドライブと接続';
    btnGDriveConnect.disabled = false;
  }
}
"""

content = content.replace('// ===================================================================\n// HTML', index_logic + '\n// ===================================================================\n// HTML')

# 2. Modify save handler
save_old = """  if (saveCanvas(saveData)) {
    showToast('Saved successfully');
    renderStartScreen(); // Update list in background
  } else {
    showToast('Failed to save (Storage full)');
  }
});"""

save_new = """  if (isGDriveConnected()) {
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
});"""
content = content.replace("btnSave.addEventListener('click', () => {", "btnSave.addEventListener('click', async () => {")
content = content.replace(save_old, save_new)

# 3. Modify loadSavedCanvas to be async and handle GDrive
load_old = """function loadSavedCanvas(id: string) {
  const data = loadCanvas(id);
  if (!data) {
    alert('キャンバスの読み込みに失敗しました');
    return;
  }"""
load_new = """async function loadSavedCanvas(id: string, gdriveFileId?: string) {
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
  }"""
content = content.replace(load_old, load_new)

# 4. Modify renderStartScreen to be async
render_old = """function renderStartScreen() {
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
    btnClearStorage.addEventListener('click', () => {
      const confirmClear = confirm("本当にすべてのキャンバスデータを削除しますか？\\nこの操作は取り消せません。");
      if (confirmClear) {
        clearAllCanvases();
        renderStartScreen();
      }
    });
  }

  const saves = getSavedCanvasesMetadata();"""

render_new = """async function renderStartScreen() {
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
      const confirmClear = confirm("本当にすべてのキャンバスデータを削除しますか？\\nこの操作は取り消せません。");
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
  }"""
content = content.replace(render_old, render_new)

# 5. Fix loadSavedCanvas call inside renderStartScreen
call_old = """      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        if (id) {
          loadSavedCanvas(id);
        }
      });"""
call_new = """      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        const gdriveId = item.getAttribute('data-gdrive-id');
        if (id) {
          loadSavedCanvas(id, gdriveId || undefined);
        }
      });"""
content = content.replace(call_old, call_new)

# 6. Add data-gdrive-id to the canvas item HTML
html_old = """        <div class="canvas-item" data-id="${save.id}">"""
html_new = """        <div class="canvas-item" data-id="${save.id}" data-gdrive-id="${save.gdriveFileId || ''}">"""
content = content.replace(html_old, html_new)


# 7. Add initialization for GDrive settings inputs
init_code = """
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
    const clientId = gdriveClientIdInput.value.trim();
    if (!clientId) {
      alert('クライアントIDを入力してください');
      return;
    }
    localStorage.setItem('gdrive_client_id', clientId);
    
    if (gdriveStatusEl) gdriveStatusEl.textContent = '接続中...';
    try {
      await initAndLoginGDrive(clientId);
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
"""
content = content.replace("// Initial render\nrenderStartScreen();", init_code)


with open('src/main.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Patch applied")
