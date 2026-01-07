/**
 * PWA Stock App V2.2 (Conflict Resolution & Smart Merge)
 */

// --- Configuration ---
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzWVB7RYJgxkiYTOCzHwpox665B313ZntYIpVWF7XIrXX8yP2JfYktnV0cnwC3ms2KRtw/exec'; // Update this!

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
let isDirty = false;

// Scanning
let isScanning = false;

// Filter
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
  btnSave: document.getElementById('btn-save'),
  btnClear: document.getElementById('btn-clear'),
  btnSync: document.getElementById('btn-sync'),
  btnManualPull: document.getElementById('btn-manual-pull'),

  listContainer: document.getElementById('list-container'),
  inpSearch: document.getElementById('inp-search'),
  selSort: document.getElementById('sel-sort'),
  chkHideZero: document.getElementById('chk-hide-zero'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  pageIndicator: document.getElementById('page-indicator'),

  scannerWrapper: document.getElementById('scanner-wrapper'),
  scannerMsg: document.getElementById('scanner-msg'),

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

  if (GAS_API_URL) {
    // Initial Pull
    setSyncing(true);
    await pullFromGAS(true);
    // Auto-sync interval
    setInterval(() => pullFromGAS(true), 5 * 60 * 1000);
  }
}

// --- DB Logic ---
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'jan' });
      }
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
  document.querySelectorAll('.btn-plus').forEach(btn => {
    btn.addEventListener('click', () => adjustStock(btn.dataset.target, 1));
  });
  document.querySelectorAll('.btn-minus').forEach(btn => {
    btn.addEventListener('click', () => adjustStock(btn.dataset.target, -1));
  });

  [dom.shelf, dom.kyakuchu, dom.prefab].forEach(inp => {
    inp.addEventListener('input', updateTotalDisplay);
  });

  dom.jan.addEventListener('change', async (e) => {
    const jan = e.target.value;
    if (jan.length === 13) {
      const item = await dbGet(jan);
      if (item) {
        setMode('update');
        populateForm(item);
        showToast('登録済みの商品です');
        dom.shelf.focus();
      } else {
        setMode('new');
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

  dom.btnSync.addEventListener('click', handleSyncPush);
  dom.btnManualPull.addEventListener('click', () => pullFromGAS(false));

  dom.inpSearch.addEventListener('input', (e) => { searchQuery = e.target.value; currentPage = 1; renderList(); });
  dom.selSort.addEventListener('change', (e) => { sortMode = e.target.value; renderList(); });
  dom.chkHideZero.addEventListener('change', (e) => { hideZero = e.target.checked; currentPage = 1; renderList(); });

  dom.btnPrev.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderList(false); } });
  dom.btnNext.addEventListener('click', () => {
    const max = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
    if (currentPage < max) { currentPage++; renderList(false); }
  });

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
      e.returnValue = '';
    }
  });
}

// --- Logic ---
function setMode(mode) {
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
  isDirty = true;
}

function updateTotalDisplay() {
  const s = parseInt(dom.shelf.value, 10) || 0;
  const k = parseInt(dom.kyakuchu.value, 10) || 0;
  const p = parseInt(dom.prefab.value, 10) || 0;
  dom.totalDisplay.textContent = `合計: ${s + k + p}`;
}

function resetStocks() {
  dom.shelf.value = 0;
  dom.kyakuchu.value = 0;
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
  dom.kyakuchu.value = item.kyakuchu || 0;
  dom.prefab.value = item.prefab || 0;

  updateTotalDisplay();
}

async function handleSave() {
  const jan = dom.jan.value.trim();
  if (!jan || jan.length !== 13) return showToast('JANコードを確認してください');

  // 1. Get existing item to preserve "_synced" properties if any
  const existing = await dbGet(jan);

  const item = {
    jan,
    name: dom.name.value.trim() || '未登録商品',
    makerCode: dom.maker.value.trim(),
    shelf: parseInt(dom.shelf.value, 10) || 0,
    kyakuchu: parseInt(dom.kyakuchu.value, 10) || 0,
    prefab: parseInt(dom.prefab.value, 10) || 0,
    updatedAt: new Date().toISOString(),

    // Preserve synced base values !!
    _synced_shelf: existing ? (existing._synced_shelf || 0) : 0,
    _synced_kyakuchu: existing ? (existing._synced_kyakuchu || 0) : 0,
    _synced_prefab: existing ? (existing._synced_prefab || 0) : 0,
  };

  // If new item, init synced to 0 (delta will be absolute)

  await dbPut(item);
  isDirty = true;
  showToast('保存しました (未同期)');
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

  // Rename backRoom -> kyakuchu legacy check
  allItems = allItems.map(i => {
    if (i.backRoom !== undefined && i.kyakuchu === undefined) {
      i.kyakuchu = i.backRoom;
      delete i.backRoom;
    }
    return i;
  });

  renderList();
}

function renderList(reFilter = true) {
  if (reFilter) {
    const q = searchQuery.toLowerCase();
    filteredItems = allItems.filter(i => i.jan.includes(q) || i.name.toLowerCase().includes(q));

    const getTotal = (i) => (i.shelf || 0) + (i.kyakuchu || 0) + (i.prefab || 0);

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
    const totalStock = (item.shelf || 0) + (item.kyakuchu || 0) + (item.prefab || 0);

    let details = [];
    if ((item.shelf || 0) > 0) details.push(`<span class="detail-box">棚: <b>${item.shelf}</b></span>`);
    if ((item.kyakuchu || 0) > 0) details.push(`<span class="detail-box">客注: <b>${item.kyakuchu}</b></span>`);
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

// --- Sync Logic (Enhanced) ---

function setSyncing(bool) {
  if (bool) dom.syncIndicator.classList.remove('hidden');
  else dom.syncIndicator.classList.add('hidden');
}

async function handleSyncPush() {
  if (!GAS_API_URL) return showToast('GAS URL未設定');
  setSyncing(true);

  try {
    const data = await dbGetAll();
    const payload = { action: 'push', data: data };

    const res = await fetch(GAS_API_URL, { method: 'POST', body: JSON.stringify(payload) });
    const json = await res.json();

    if (json.status === 'success') {
      showToast('同期完了');
      isDirty = false;
      // Update synced state to match current state
      await updateSyncedState(data);
    }
    else if (json.status === 'conflict') {
      // SMART MERGE LOGIC
      if (confirm(`【競合検知】\n他ユーザーによる更新があります。\nあなたの入力分（増減）を最新データに統合しますか？`)) {
        await executeSmartMerge(json.serverItems);
        // Retry push automatically after merge
        setTimeout(handleSyncPush, 500);
        return; // Exit this run
      } else {
        showToast('同期を中断しました');
      }
    }
    else {
      throw new Error(json.message);
    }

  } catch (e) {
    showToast('同期失敗: ' + e.message);
  } finally {
    setSyncing(false);
  }
}

async function executeSmartMerge(serverItems) {
  for (const sItem of serverItems) {
    const local = await dbGet(sItem.jan);
    if (!local) continue; // Shouldn't happen if we pushed it

    // Calculate Deltas
    // Delta = LocalCurrent - LocalSyncedBase
    const deltaShelf = (local.shelf || 0) - (local._synced_shelf || 0);
    const deltaKyakuchu = (local.kyakuchu || 0) - (local._synced_kyakuchu || 0);
    const deltaPrefab = (local.prefab || 0) - (local._synced_prefab || 0);

    // Merge: ServerCurrent + Delta
    local.shelf = (sItem.shelf || 0) + deltaShelf;
    local.kyakuchu = (sItem.kyakuchu || 0) + deltaKyakuchu;
    local.prefab = (sItem.prefab || 0) + deltaPrefab;
    local.name = sItem.name; // Prefer server name? Or keep local? Usually server master is stronger.
    local.makerCode = sItem.makerCode;

    // Update synced base to the NEW combined value (so next diff is clean)
    // Actually, getting ready to push again, but we treat this merged state as 'current'
    // The timestamp should be updated to now so we win next race or validly update
    local.updatedAt = new Date().toISOString();

    // Note: We don't update _synced_* yet, that happens on Success.

    await dbPut(local);
  }
  showToast('マージ完了。再送信します...');
  await loadAndRender();
}

async function updateSyncedState(items) {
  // Mark all current items as "synced base"
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  for (const item of items) {
    item._synced_shelf = item.shelf;
    item._synced_kyakuchu = item.kyakuchu;
    item._synced_prefab = item.prefab;
    store.put(item);
  }
  return new Promise(resolve => tx.oncomplete = resolve);
}

async function pullFromGAS(isAuto = false) {
  if (!GAS_API_URL) return;

  if (isDirty && !isAuto) {
    if (!confirm('未送信データがあります。上書きして受信しますか？')) return;
  }

  setSyncing(true);

  try {
    const res = await fetch(GAS_API_URL);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('Format');

    await dbClear();

    // When pulling, set _synced_* properties
    for (const item of json) {
      item._synced_shelf = item.shelf || 0;
      item._synced_kyakuchu = item.kyakuchu || 0; // mapped in GAS already? GAS returns kyakuchu key
      item._synced_prefab = item.prefab || 0;
      await dbPut(item);
    }

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

// --- Scanner ---
function toggleScanner() { isScanning ? stopScanner() : startScanner(); }
function startScanner() {
  dom.scannerWrapper.classList.remove('hidden');
  dom.btnScanToggle.textContent = '⏹ 読取停止';
  dom.btnScanToggle.style.backgroundColor = 'var(--danger-color)';
  setTimeout(() => {
    Quagga.init({
      inputStream: { name: "Live", type: "LiveStream", target: document.querySelector('#scanner-container'), constraints: { width: { min: 640 }, height: { min: 480 }, facingMode: "environment", aspectRatio: { min: 1, max: 2 } } },
      locator: { patchSize: "medium", halfSample: true }, numOfWorkers: 2, decoder: { readers: ["ean_reader"] }, locate: true
    }, (err) => {
      if (err) { showToast('カメラ起動失敗: ' + err.name); stopScanner(); return; }
      Quagga.start(); isScanning = true;
      const v = document.querySelector('#scanner-container video'); if (v) v.setAttribute('playsinline', 'true');
    });
    Quagga.onDetected((res) => { if (res.codeResult.code.length === 13) { playBeep(); dom.jan.value = res.codeResult.code; dom.jan.dispatchEvent(new Event('change')); stopScanner(); } });
  }, 100);
}
function stopScanner() { Quagga.stop(); isScanning = false; dom.scannerWrapper.classList.add('hidden'); dom.btnScanToggle.textContent = '📷 バーコード読取開始'; dom.btnScanToggle.style.backgroundColor = 'var(--text-main)'; }

// --- Utils ---
function showToast(msg) { dom.toast.textContent = msg; dom.toast.classList.add('show'); setTimeout(() => dom.toast.classList.remove('show'), 3000); }
function escapeHtml(s) { return s ? s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#039;' }[m])) : ''; }
function playBeep() { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(800, ctx.currentTime); o.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.1); }
function setupServiceWorker() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').then(r => { if (r.waiting) r.waiting.postMessage({ type: 'SKIP_WAITING' }) }); }

init();

