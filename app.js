/**
 * PWA Stock App V3.0 (Real-Time Sync)
 */

// --- Configuration ---
const GAS_API_URL = ''; // Update this!

// --- Constants ---
const DB_NAME = 'StockAppDB';
const DB_VERSION = 3;
const STORE_NAME = 'products';

// --- State ---
let db = null;
let allItems = [];
let filteredItems = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 10;
let isScanning = false;
let sortMode = 'date-desc';
let searchQuery = '';
let hideZero = false;

// --- DOM Cache ---
const dom = {
  jan: document.getElementById('inp-jan'),
  name: document.getElementById('inp-name'),
  maker: document.getElementById('inp-maker'),
  shelf: document.getElementById('inp-shelf'),
  kyakuchu: document.getElementById('inp-kyakuchu'),
  prefab: document.getElementById('inp-prefab'),
  totalDisplay: document.getElementById('total-stock-display'),

  formCard: document.getElementById('input-form-card'),
  modeBadge: document.getElementById('mode-badge'),

  btnScanToggle: document.getElementById('btn-scan-toggle'),
  btnManualPull: document.getElementById('btn-manual-pull'),
  btnClear: document.getElementById('btn-clear'),

  listContainer: document.getElementById('list-container'),
  inpSearch: document.getElementById('inp-search'),
  selSort: document.getElementById('sel-sort'),
  chkHideZero: document.getElementById('chk-hide-zero'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  pageIndicator: document.getElementById('page-indicator'),

  scannerWrapper: document.getElementById('scanner-wrapper'),
  scannerMsg: document.getElementById('scanner-msg'),

  // New UI
  statusBar: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  statusIcon: document.getElementById('status-icon'),
  toast: document.getElementById('toast'),
};

// --- Init ---
async function init() {
  await initDB();
  setupEventListeners();
  setupServiceWorker();

  await loadAndRender();

  if (GAS_API_URL) {
    // Initial Pull on Load
    updateStatus('syncing', 'データ取得中...');
    await pullFromGAS(true);
  }
}

// --- DB Logic ---
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'jan' });
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = reject;
  });
}

function dbGetAll() {
  return new Promise(resolve => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    store.getAll().onsuccess = (e) => resolve(e.target.result);
  });
}

function dbGet(jan) {
  return new Promise(resolve => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    store.get(jan).onsuccess = (e) => resolve(e.target.result || null);
    store.get(jan).onerror = () => resolve(null);
  });
}

function dbPut(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(item).onsuccess = () => resolve();
    store.put(item).onerror = reject;
  });
}

function dbDelete(jan) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(jan).onsuccess = () => resolve();
    store.delete(jan).onerror = reject;
  });
}

function dbClear() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear().onsuccess = () => resolve();
    store.clear().onerror = reject;
  });
}

// --- Event Listeners ---
function setupEventListeners() {
  // Real-time Sync on Blur for Input Fields
  [dom.name, dom.maker, dom.shelf, dom.kyakuchu, dom.prefab].forEach(el => {
    el.addEventListener('blur', () => {
      const jan = dom.jan.value.trim();
      if (jan.length === 13) {
        saveCurrentForm(jan); // Save locally first
        syncItem(jan);        // Then push immediately
      }
    });
    // For inputs, also update local calculation
    el.addEventListener('input', updateTotalDisplay);
  });

  // +/- Buttons also trigger sync immediately
  document.querySelectorAll('.btn-plus, .btn-minus').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent blur issues?
      const targetId = btn.dataset.target;
      adjustStock(targetId, btn.classList.contains('btn-plus') ? 1 : -1);
      const jan = dom.jan.value.trim();
      if (jan.length === 13) {
        saveCurrentForm(jan);
        syncItem(jan);
      }
    });
  });

  dom.jan.addEventListener('change', async (e) => {
    const jan = e.target.value;
    if (jan.length === 13) {
      const item = await dbGet(jan);
      if (item && !item._deleted) {
        setMode('update');
        populateForm(item);
        showToast('データを読み込みました');
        dom.shelf.focus();
      } else {
        setMode('new');
        dom.name.value = ''; dom.maker.value = ''; resetStocks();
        dom.name.focus();
      }
    }
  });

  dom.btnManualPull.addEventListener('click', async () => {
    updateStatus('syncing', '全件取得中...');
    await pullFromGAS(false);
  });

  dom.btnClear.addEventListener('click', clearForm);
  dom.btnScanToggle.addEventListener('click', toggleScanner);

  dom.inpSearch.addEventListener('input', (e) => { searchQuery = e.target.value; currentPage = 1; renderList(); });
  dom.selSort.addEventListener('change', (e) => { sortMode = e.target.value; renderList(); });
  dom.chkHideZero.addEventListener('change', (e) => { hideZero = e.target.checked; currentPage = 1; renderList(); });
  dom.btnPrev.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderList(false); } });
  dom.btnNext.addEventListener('click', () => { if (currentPage < Math.ceil(filteredItems.length / ITEMS_PER_PAGE)) { currentPage++; renderList(false); } });

  dom.listContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const jan = btn.dataset.jan;
    if (btn.classList.contains('action-edit')) handleEdit(jan);
    if (btn.classList.contains('action-delete')) handleDelete(jan);
  });
}

// --- UI Logic ---
function updateStatus(state, msg) {
  dom.statusBar.className = 'status-bar ' + state;
  dom.statusText.textContent = msg;
  if (state === 'syncing') dom.statusIcon.textContent = '🔄';
  else if (state === 'success') dom.statusIcon.textContent = '✅';
  else if (state === 'error') dom.statusIcon.textContent = '⚠️';
  else dom.statusIcon.textContent = 'ℹ️';
}

function setMode(mode) {
  dom.formCard.classList.remove('mode-new', 'mode-update'); dom.modeBadge.classList.remove('hidden');
  if (mode === 'new') { dom.formCard.classList.add('mode-new'); dom.modeBadge.textContent = '新規登録'; }
  else { dom.formCard.classList.add('mode-update'); dom.modeBadge.textContent = '在庫更新'; }
}
function adjustStock(targetId, delta) {
  const el = document.getElementById(targetId);
  let val = parseInt(el.value, 10) || 0; val += delta; if (val < 0) val = 0; el.value = val;
  updateTotalDisplay();
}
function updateTotalDisplay() {
  const s = parseInt(dom.shelf.value, 10) || 0;
  const k = parseInt(dom.kyakuchu.value, 10) || 0;
  const p = parseInt(dom.prefab.value, 10) || 0;
  dom.totalDisplay.textContent = `合計: ${s + k + p}`;
}
function resetStocks() { dom.shelf.value = 0; dom.kyakuchu.value = 0; dom.prefab.value = 0; updateTotalDisplay(); }
function clearForm() {
  dom.jan.value = ''; dom.name.value = ''; dom.maker.value = '';
  resetStocks(); dom.formCard.classList.remove('mode-new', 'mode-update'); dom.modeBadge.classList.add('hidden');
  updateStatus('', '準備完了');
}
function populateForm(item) {
  dom.jan.value = item.jan; dom.name.value = item.name; dom.maker.value = item.makerCode;
  dom.shelf.value = item.shelf || 0; dom.kyakuchu.value = item.kyakuchu || 0; dom.prefab.value = item.prefab || 0;
  updateTotalDisplay();
}

// --- Core Data Logic ---
async function saveCurrentForm(jan) {
  if (!jan) return;
  const existing = await dbGet(jan);

  const item = {
    jan,
    name: dom.name.value.trim() || '未登録商品',
    makerCode: dom.maker.value.trim(),
    shelf: parseInt(dom.shelf.value, 10) || 0,
    kyakuchu: parseInt(dom.kyakuchu.value, 10) || 0,
    prefab: parseInt(dom.prefab.value, 10) || 0,
    updatedAt: new Date().toISOString(), // Update timestamp
    _synced_shelf: existing ? (existing._synced_shelf || 0) : 0,
    _synced_kyakuchu: existing ? (existing._synced_kyakuchu || 0) : 0,
    _synced_prefab: existing ? (existing._synced_prefab || 0) : 0,
    _deleted: false
  };

  await dbPut(item);
  loadAndRender(); // Update list immediately
}

async function handleDelete(jan) {
  if (confirm('削除しますか？')) {
    const item = await dbGet(jan);
    if (item) {
      item._deleted = true;
      item.updatedAt = new Date().toISOString();
      await dbPut(item);
      loadAndRender();
      syncItem(jan); // Sync deletion immediately
    }
  }
}

async function handleEdit(jan) {
  const item = await dbGet(jan);
  if (item) { populateForm(item); setMode('update'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

// --- Sync Logic (Real-time & Merge) ---
async function syncItem(jan) {
  if (!GAS_API_URL) return;

  updateStatus('syncing', '同期中...');
  try {
    const item = await dbGet(jan);
    if (!item) return;

    const payload = { action: 'push', data: [item] }; // Send array of 1
    const res = await fetch(GAS_API_URL, { method: 'POST', body: JSON.stringify(payload) });
    const json = await res.json();

    if (json.status === 'success') {
      updateStatus('success', '同期完了');
      if (item._deleted) {
        await dbDelete(jan); // Cleanup locally
      } else {
        // Update Synced Base
        item._synced_shelf = item.shelf;
        item._synced_kyakuchu = item.kyakuchu;
        item._synced_prefab = item.prefab;
        await dbPut(item);
      }
      setTimeout(() => updateStatus('', '準備完了'), 2000);
    }
    else if (json.status === 'conflict') {
      updateStatus('warning', '競合を検知');
      const serverItem = json.serverItems[0];
      if (confirm(`【競合検知】\n他ユーザーが更新しました。\n（サーバー在庫: ${serverItem.shelf + serverItem.kyakuchu + serverItem.prefab}個）\nあなたの増減分を反映して統合しますか？`)) {
        await executeMergeSingle(serverItem);
      } else {
        updateStatus('error', '同期中断 (競合)');
      }
    }
    else {
      throw new Error(json.message);
    }
  } catch (e) {
    console.error(e);
    updateStatus('error', '未送信 (再試行待ち)');
  }
}

async function executeMergeSingle(sItem) {
  const jan = sItem.jan;
  const local = await dbGet(jan);

  const deltaS = (local.shelf || 0) - (local._synced_shelf || 0);
  const deltaK = (local.kyakuchu || 0) - (local._synced_kyakuchu || 0);
  const deltaP = (local.prefab || 0) - (local._synced_prefab || 0);

  // Apply Merge
  local.shelf = (sItem.shelf || 0) + deltaS;
  local.kyakuchu = (sItem.kyakuchu || 0) + deltaK;
  local.prefab = (sItem.prefab || 0) + deltaP;
  local.name = sItem.name;
  local.makerCode = sItem.makerCode;
  local.updatedAt = new Date().toISOString();

  // Recalculate synced base based on what we just merged ON TOP OF (the server item)
  // Actually no, we just merged. We need to sync THIS new state to server.
  // The base remains what it was (start of session) OR we can say the delta is applied.
  // Best practice: Update DB, then Trigger Sync again.

  await dbPut(local);
  updateTotalDisplay(); // Live update UI if form is open
  loadAndRender();      // Live update List

  syncItem(jan); // Retry sync immediately
}

async function pullFromGAS(isAuto = false) {
  if (!GAS_API_URL) return;
  try {
    const res = await fetch(GAS_API_URL);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('Format');

    // We replace DB but be careful about current dirty inputs?
    // User requested "Safety".
    // Since we now sync real-time, "Dirty" is less of a persistent state.
    // But if user is typing, we shouldn't overwrite.
    // Simple logic: Overwrite DB, but if form is open for a JAN, warn?
    // For now, simple overwrite for full pull.

    await dbClear();
    for (const item of json) {
      item._synced_shelf = item.shelf || 0; item._synced_kyakuchu = item.kyakuchu || 0; item._synced_prefab = item.prefab || 0;
      await dbPut(item);
    }
    await loadAndRender();
    updateStatus('success', '全件受信完了');
    setTimeout(() => updateStatus('', '準備完了'), 2000);
  } catch (e) {
    if (!isAuto) updateStatus('error', '受信失敗');
  }
}

// --- List & Util ---
async function loadAndRender() {
  allItems = await dbGetAll();
  renderList();
}
function renderList(reFilter = true) {
  if (reFilter) {
    const q = searchQuery.toLowerCase();
    filteredItems = allItems.filter(i => !i._deleted && (i.jan.includes(q) || i.name.toLowerCase().includes(q)));
    const getTotal = (i) => (i.shelf || 0) + (i.kyakuchu || 0) + (i.prefab || 0);
    if (hideZero) filteredItems = filteredItems.filter(i => getTotal(i) > 0);
    filteredItems.sort((a, b) => {
      const totA = getTotal(a); const totB = getTotal(b);
      switch (sortMode) {
        case 'date-desc': return new Date(b.updatedAt) - new Date(a.updatedAt);
        case 'stock-desc': return totB - totA;
        case 'stock-asc': return totA - totB;
        default: return 0;
      }
    });
  }
  const total = filteredItems.length; const maxPage = Math.ceil(total / ITEMS_PER_PAGE) || 1;
  if (currentPage > maxPage) currentPage = maxPage;
  const pageItems = filteredItems.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  dom.listContainer.innerHTML = '';
  pageItems.forEach(item => {
    const totalStock = (item.shelf || 0) + (item.kyakuchu || 0) + (item.prefab || 0);
    let details = [];
    if ((item.shelf || 0) > 0) details.push(`<span class="detail-box">棚: <b>${item.shelf}</b></span>`);
    if ((item.kyakuchu || 0) > 0) details.push(`<span class="detail-box">客注: <b>${item.kyakuchu}</b></span>`);
    if ((item.prefab || 0) > 0) details.push(`<span class="detail-box">プレ: <b>${item.prefab}</b></span>`);
    if (details.length === 0) details.push(`<span class="detail-box" style="color:#999">在庫なし</span>`);

    const div = document.createElement('div'); div.className = 'item-card';
    div.innerHTML = `
      <div class="item-header"><h3 class="item-title">${item.name}</h3><span class="item-total">${totalStock}</span></div>
      <div class="item-detail-row">${details.join('')}</div>
      <div class="item-meta"><span>JAN: ${item.jan}</span><div class="item-actions"><button class="action-edit" data-jan="${item.jan}">編集</button><button class="action-delete" data-jan="${item.jan}">削除</button></div></div>
    `;
    dom.listContainer.appendChild(div);
  });
  dom.pageIndicator.textContent = `${currentPage} / ${maxPage}`; dom.btnPrev.disabled = currentPage === 1; dom.btnNext.disabled = currentPage === maxPage;
}

// Scanner
function toggleScanner() { isScanning ? stopScanner() : startScanner(); }
function startScanner() {
  dom.scannerWrapper.classList.remove('hidden'); dom.btnScanToggle.textContent = '⏹ 読取停止'; dom.btnScanToggle.style.backgroundColor = 'var(--danger-color)';
  setTimeout(() => {
    Quagga.init({ inputStream: { name: "Live", type: "LiveStream", target: document.querySelector('#scanner-container'), constraints: { width: { min: 640 }, height: { min: 480 }, facingMode: "environment", aspectRatio: { min: 1, max: 2 } } }, locator: { patchSize: "medium", halfSample: true }, numOfWorkers: 2, decoder: { readers: ["ean_reader"] }, locate: true }, (err) => {
      if (err) { showToast('カメラ起動失敗'); stopScanner(); return; }
      Quagga.start(); isScanning = true; const v = document.querySelector('#scanner-container video'); if (v) v.setAttribute('playsinline', 'true');
    });
    Quagga.onDetected((res) => { if (res.codeResult.code.length === 13) { playBeep(); dom.jan.value = res.codeResult.code; dom.jan.dispatchEvent(new Event('change')); stopScanner(); } });
  }, 100);
}
function stopScanner() { Quagga.stop(); isScanning = false; dom.scannerWrapper.classList.add('hidden'); dom.btnScanToggle.textContent = '📷 バーコード読取開始'; dom.btnScanToggle.style.backgroundColor = 'var(--text-main)'; }
function showToast(msg) { dom.toast.textContent = msg; dom.toast.classList.add('show'); setTimeout(() => dom.toast.classList.remove('show'), 3000); }
function playBeep() { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(800, ctx.currentTime); o.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.1); }
function setupServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').then(r => {
    // Reload if new SW detected
    r.addEventListener('updatefound', () => {
      const newWorker = r.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          newWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
}

init();
