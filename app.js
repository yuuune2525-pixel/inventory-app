/**
 * PWA Stock App V2 (Professional)
 */

// --- Configuration ---
const GAS_API_URL = ''; // GAS V2 URL here

// --- Constants ---
const DB_NAME = 'StockAppDB';
const DB_VERSION = 2; // Upgraded version
const STORE_NAME = 'products';

// --- State ---
let db = null;
let allItems = [];
let filteredItems = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 10;
let isDirty = false; // For data loss prevention

// Scanning State
let isScanning = false;

// Filter State
let sortMode = 'date-desc';
let searchQuery = '';
let hideZero = false;

// --- DOM Cache ---
const dom = {
  jan: document.getElementById('inp-jan'),
  name: document.getElementById('inp-name'),
  maker: document.getElementById('inp-maker'),
  // Stock Inputs
  shelf: document.getElementById('inp-shelf'),
  backroom: document.getElementById('inp-backroom'),
  prefab: document.getElementById('inp-prefab'),
  totalDisplay: document.getElementById('total-stock-display'),

  // UI Containers
  formCard: document.getElementById('input-form-card'),
  modeBadge: document.getElementById('mode-badge'),

  // Buttons
  btnScanToggle: document.getElementById('btn-scan-toggle'),
  btnSave: document.getElementById('btn-save'),
  btnClear: document.getElementById('btn-clear'),
  btnSync: document.getElementById('btn-sync'),
  btnManualPull: document.getElementById('btn-manual-pull'),

  // List
  listContainer: document.getElementById('list-container'),
  inpSearch: document.getElementById('inp-search'),
  selSort: document.getElementById('sel-sort'),
  chkHideZero: document.getElementById('chk-hide-zero'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  pageIndicator: document.getElementById('page-indicator'),

  // Scanner
  scannerWrapper: document.getElementById('scanner-wrapper'),
  scannerMsg: document.getElementById('scanner-msg'),

  // Sync
  syncIndicator: document.getElementById('sync-indicator'),
  toast: document.getElementById('toast'),
};

// --- Init ---
async function init() {
  setupBeforeUnload();
  await initDB();
  setupEventListeners();
  setupServiceWorker();

  await loadAndRender();

  // Auto-sync setup
  if (GAS_API_URL) {
    pullFromGAS(true); // Initial pull
    setInterval(() => pullFromGAS(true), 5 * 60 * 1000); // Every 5 mins
  }
}

// --- DB Logic (V2) ---
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'jan' });
      } else {
        // Migration logic if needed (Version 1 -> 2)
        // Since we are changing structure, let's just ensure store exists.
        // Data format handling is done in code (reading old 'stock' property if needed)
      }
    };

    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
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
    const req = store.get(jan);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function dbPut(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = reject;
  });
}

function dbDelete(jan) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(jan);
    req.onsuccess = () => resolve();
    req.onerror = reject;
  });
}

function dbClear() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = reject;
  });
}

// --- Event Listeners ---
function setupEventListeners() {
  // Setup +/- buttons for all locations
  document.querySelectorAll('.btn-plus').forEach(btn => {
    btn.addEventListener('click', () => adjustStock(btn.dataset.target, 1));
  });
  document.querySelectorAll('.btn-minus').forEach(btn => {
    btn.addEventListener('click', () => adjustStock(btn.dataset.target, -1));
  });

  // Real-time calculation on input
  [dom.shelf, dom.backroom, dom.prefab].forEach(inp => {
    inp.addEventListener('input', updateTotalDisplay);
  });

  // JAN Auto-complete & Mode Switch
  dom.jan.addEventListener('change', async (e) => {
    const jan = e.target.value;
    if (jan.length === 13) {
      const item = await dbGet(jan);
      if (item) {
        setMode('update');
        populateForm(item);
        showToast('登録済みの商品です');
        // Focus on shelf for quick update
        dom.shelf.focus();
      } else {
        setMode('new');
        // Clear other fields but keep JAN
        dom.name.value = '';
        dom.maker.value = '';
        resetStocks();
        dom.name.focus();
      }
    }
  });

  dom.btnSave.addEventListener('click', handleSave);
  dom.btnClear.addEventListener('click', clearForm);
  dom.btnScanToggle.addEventListener('click', toggleScanner);

  // Sync
  dom.btnSync.addEventListener('click', handleSyncPush);
  dom.btnManualPull.addEventListener('click', () => pullFromGAS(false));

  // List Filters
  dom.inpSearch.addEventListener('input', (e) => { searchQuery = e.target.value; currentPage = 1; renderList(); });
  dom.selSort.addEventListener('change', (e) => { sortMode = e.target.value; renderList(); });
  dom.chkHideZero.addEventListener('change', (e) => { hideZero = e.target.checked; currentPage = 1; renderList(); });

  // Pagination
  dom.btnPrev.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderList(false); } });
  dom.btnNext.addEventListener('click', () => {
    const max = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
    if (currentPage < max) { currentPage++; renderList(false); }
  });

  // Delegation
  dom.listContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const jan = btn.dataset.jan;
    if (btn.classList.contains('action-edit')) handleEdit(jan);
    if (btn.classList.contains('action-delete')) handleDelete(jan);
  });
}

function setupBeforeUnload() {
  window.addEventListener('beforeunload', (e) => {
    if (isDirty) {
      e.preventDefault();
      e.returnValue = ''; // Standard browser warning
    }
  });
}

// --- Core Logic ---
function setMode(mode) {
  // mode: 'new' or 'update'
  dom.formCard.classList.remove('mode-new', 'mode-update');
  dom.modeBadge.classList.remove('hidden');

  if (mode === 'new') {
    dom.formCard.classList.add('mode-new');
    dom.modeBadge.textContent = '新規登録';
  } else {
    dom.formCard.classList.add('mode-update');
    dom.modeBadge.textContent = '在庫更新';
  }
}

function adjustStock(targetId, delta) {
  const el = document.getElementById(targetId);
  let val = parseInt(el.value, 10) || 0;
  val += delta;
  if (val < 0) val = 0;
  el.value = val;
  updateTotalDisplay();
  isDirty = true; // User touched data
}

function updateTotalDisplay() {
  const s = parseInt(dom.shelf.value, 10) || 0;
  const b = parseInt(dom.backroom.value, 10) || 0;
  const p = parseInt(dom.prefab.value, 10) || 0;
  dom.totalDisplay.textContent = `合計: ${s + b + p}`;
}

function resetStocks() {
  dom.shelf.value = 0;
  dom.backroom.value = 0;
  dom.prefab.value = 0;
  updateTotalDisplay();
}

function clearForm() {
  dom.jan.value = '';
  dom.name.value = '';
  dom.maker.value = '';
  resetStocks();
  dom.formCard.classList.remove('mode-new', 'mode-update');
  dom.modeBadge.classList.add('hidden');
}

function populateForm(item) {
  dom.jan.value = item.jan;
  dom.name.value = item.name;
  dom.maker.value = item.makerCode;
  dom.shelf.value = item.shelf || 0;
  dom.backroom.value = item.backRoom || 0;
  dom.prefab.value = item.prefab || 0;
  updateTotalDisplay();
}

async function handleSave() {
  const jan = dom.jan.value.trim();
  if (!jan || jan.length !== 13) return showToast('JANコードを確認してください');

  const item = {
    jan,
    name: dom.name.value.trim() || '未登録商品',
    makerCode: dom.maker.value.trim(),
    shelf: parseInt(dom.shelf.value, 10) || 0,
    backRoom: parseInt(dom.backroom.value, 10) || 0,
    prefab: parseInt(dom.prefab.value, 10) || 0,
    updatedAt: new Date().toISOString()
  };

  await dbPut(item);
  isDirty = true; // Data changed relative to cloud
  showToast('保存しました');
  clearForm();
  loadAndRender();
}

async function handleDelete(jan) {
  if (confirm('削除しますか？')) {
    await dbDelete(jan);
    isDirty = true;
    showToast('削除しました');
    loadAndRender();
  }
}

async function handleEdit(jan) {
  const item = await dbGet(jan);
  if (item) {
    populateForm(item);
    setMode('update');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// --- List ---
async function loadAndRender() {
  allItems = await dbGetAll();

  // Migration fallback: if item has 'stock' but no shelf/backroom/prefab, map it
  // (Optional visualization safety)
  allItems = allItems.map(i => {
    if (i.stock !== undefined && i.shelf === undefined) {
      i.shelf = i.stock; // Default old stock to shelf
      delete i.stock;
    }
    return i;
  });

  renderList();
}

function renderList(reFilter = true) {
  if (reFilter) {
    const q = searchQuery.toLowerCase();
    filteredItems = allItems.filter(i => i.jan.includes(q) || i.name.toLowerCase().includes(q));

    // Total calc helper
    const getTotal = (i) => (i.shelf || 0) + (i.backRoom || 0) + (i.prefab || 0);

    // Hide Zero Filter
    if (hideZero) {
      filteredItems = filteredItems.filter(i => getTotal(i) > 0);
    }

    filteredItems.sort((a, b) => {
      const totA = getTotal(a);
      const totB = getTotal(b);
      switch (sortMode) {
        case 'date-desc': return new Date(b.updatedAt) - new Date(a.updatedAt);
        case 'stock-desc': return totB - totA;
        case 'stock-asc': return totA - totB;
        case 'maker-asc': return (a.makerCode || '').localeCompare(b.makerCode || '');
        default: return 0;
      }
    });
  }

  const total = filteredItems.length;
  const maxPage = Math.ceil(total / ITEMS_PER_PAGE) || 1;
  if (currentPage > maxPage) currentPage = maxPage;

  const pageItems = filteredItems.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  dom.listContainer.innerHTML = '';
  pageItems.forEach(item => {
    const totalStock = (item.shelf || 0) + (item.backRoom || 0) + (item.prefab || 0);

    // Build detail string (Only > 0)
    let details = [];
    if ((item.shelf || 0) > 0) details.push(`<span class="detail-box">棚: <b>${item.shelf}</b></span>`);
    if ((item.backRoom || 0) > 0) details.push(`<span class="detail-box">脚注: <b>${item.backRoom}</b></span>`);
    if ((item.prefab || 0) > 0) details.push(`<span class="detail-box">プレ: <b>${item.prefab}</b></span>`);
    if (details.length === 0) details.push(`<span class="detail-box" style="color:#999">在庫なし</span>`);

    const div = document.createElement('div');
    div.className = 'item-card';
    div.innerHTML = `
      <div class="item-header">
        <h3 class="item-title">${escapeHtml(item.name)}</h3>
        <span class="item-total">${totalStock}</span>
      </div>
      <div class="item-detail-row">
        ${details.join('')}
      </div>
      <div class="item-meta">
        <span>JAN: ${item.jan}</span>
        <div class="item-actions">
          <button class="action-edit" data-jan="${item.jan}">編集</button>
          <button class="action-delete" data-jan="${item.jan}">削除</button>
        </div>
      </div>
    `;
    dom.listContainer.appendChild(div);
  });

  dom.pageIndicator.textContent = `${currentPage} / ${maxPage}`;
  dom.btnPrev.disabled = currentPage === 1;
  dom.btnNext.disabled = currentPage === maxPage;
}

// --- Scanner (Quagga2) ---
function toggleScanner() {
  if (isScanning) stopScanner();
  else startScanner();
}

function startScanner() {
  dom.scannerWrapper.classList.remove('hidden');
  dom.btnScanToggle.textContent = '⏹ 読取停止';
  dom.btnScanToggle.style.backgroundColor = 'var(--danger-color)';

  setTimeout(() => {
    Quagga.init({
      inputStream: {
        name: "Live", type: "LiveStream", target: document.querySelector('#scanner-container'),
        constraints: { width: { min: 640 }, height: { min: 480 }, facingMode: "environment", aspectRatio: { min: 1, max: 2 } }
      },
      locator: { patchSize: "medium", halfSample: true },
      numOfWorkers: 2,
      decoder: { readers: ["ean_reader"] },
      locate: true
    }, (err) => {
      if (err) {
        showToast('カメラ起動失敗: ' + err.name);
        stopScanner();
        return;
      }
      Quagga.start();
      isScanning = true;
      const v = document.querySelector('#scanner-container video');
      if (v) v.setAttribute('playsinline', 'true');
    });
    Quagga.onDetected(onBarcodeDetected);
  }, 100);
}

function stopScanner() {
  Quagga.stop();
  Quagga.offDetected(onBarcodeDetected);
  isScanning = false;
  dom.scannerWrapper.classList.add('hidden');
  dom.btnScanToggle.textContent = '📷 バーコード読取開始';
  dom.btnScanToggle.style.backgroundColor = 'var(--text-main)';
}

function onBarcodeDetected(res) {
  const code = res.codeResult.code;
  if (code && code.length === 13) {
    playBeep();
    dom.jan.value = code;
    dom.jan.dispatchEvent(new Event('change'));
    stopScanner();
  }
}

// --- Sync ---
function setSyncing(bool) {
  if (bool) dom.syncIndicator.classList.remove('hidden');
  else dom.syncIndicator.classList.add('hidden');
}

async function handleSyncPush() {
  if (!GAS_API_URL) return showToast('GAS URL未設定');
  if (!confirm('【送信】スプレッドシートを上書きしますか？')) return;

  setSyncing(true);
  try {
    const data = await dbGetAll();
    const payload = { action: 'push', data: data };
    await fetch(GAS_API_URL, { method: 'POST', body: JSON.stringify(payload) });
    showToast('送信完了');
    isDirty = false; // Synced!
  } catch (e) {
    showToast('送信失敗: ' + e.message);
  } finally {
    setSyncing(false);
  }
}

async function pullFromGAS(isAuto = false) {
  if (!GAS_API_URL) return;
  if (isDirty && !isAuto) {
    if (!confirm('未送信データがあります。上書きして受信しますか？')) return;
  }

  if (!isAuto) setSyncing(true); // Don't show indicator for auto unless desired, but user asked for indicator "during sync"
  else {
    // For auto, maybe subtle? But user said "Show indicator"
    setSyncing(true);
  }

  try {
    const res = await fetch(GAS_API_URL);
    if (!res.ok) throw new Error('Network');
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('Format');

    await dbClear();
    for (const item of json) await dbPut(item);

    await loadAndRender();
    isDirty = false;
    if (!isAuto) showToast('受信完了');
    else console.log('Auto-sync done');
  } catch (e) {
    if (!isAuto) showToast('受信失敗: ' + e.message);
  } finally {
    setSyncing(false);
  }
}

// --- Utils ---
function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  setTimeout(() => dom.toast.classList.remove('show'), 3000);
}
function escapeHtml(s) { return s ? s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#039;' }[m])) : ''; }
function playBeep() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.setValueAtTime(800, ctx.currentTime);
  o.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.1);
}
function setupServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js');
}

// Start
init();
