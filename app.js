/**
 * PWA Stock App V2.3 (Delete Sync Fix)
 */

// --- Configuration ---
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbxq1k70Ey9HIjHhINKbmQDS8_YLCuBFEOggy_4HEw4MB6pZ_W_PFiqP3B380p25eKu7Ww/exec'; // Update this!

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
    setSyncing(true);
    await pullFromGAS(true); // Auto-pull on start
    setInterval(() => pullFromGAS(true), 5 * 60 * 1000);
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
  document.querySelectorAll('.btn-plus').forEach(btn => btn.addEventListener('click', () => adjustStock(btn.dataset.target, 1)));
  document.querySelectorAll('.btn-minus').forEach(btn => btn.addEventListener('click', () => adjustStock(btn.dataset.target, -1)));
  [dom.shelf, dom.kyakuchu, dom.prefab].forEach(inp => inp.addEventListener('input', updateTotalDisplay));

  dom.jan.addEventListener('change', async (e) => {
    const jan = e.target.value;
    if (jan.length === 13) {
      const item = await dbGet(jan);
      if (item && !item._deleted) { // Don't revive deleted items unless explicitly re-saving
        setMode('update');
        populateForm(item);
        showToast('登録済みの商品です');
        dom.shelf.focus();
      } else {
        setMode('new');
        dom.name.value = ''; dom.maker.value = ''; resetStocks();
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
  dom.btnNext.addEventListener('click', () => { if (currentPage < Math.ceil(filteredItems.length / ITEMS_PER_PAGE)) { currentPage++; renderList(false); } });

  dom.listContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const jan = btn.dataset.jan;
    if (btn.classList.contains('action-edit')) handleEdit(jan);
    if (btn.classList.contains('action-delete')) handleDelete(jan);
  });
}

function setupBeforeUnload() {
  window.addEventListener('beforeunload', (e) => { if (isDirty) { e.preventDefault(); e.returnValue = ''; } });
}

// --- UI Logic ---
function setMode(mode) {
  dom.formCard.classList.remove('mode-new', 'mode-update'); dom.modeBadge.classList.remove('hidden');
  if (mode === 'new') { dom.formCard.classList.add('mode-new'); dom.modeBadge.textContent = '新規登録'; }
  else { dom.formCard.classList.add('mode-update'); dom.modeBadge.textContent = '在庫更新'; }
}
function adjustStock(targetId, delta) {
  const el = document.getElementById(targetId);
  let val = parseInt(el.value, 10) || 0; val += delta; if (val < 0) val = 0; el.value = val;
  updateTotalDisplay(); isDirty = true;
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
}
function populateForm(item) {
  dom.jan.value = item.jan; dom.name.value = item.name; dom.maker.value = item.makerCode;
  dom.shelf.value = item.shelf || 0; dom.kyakuchu.value = item.kyakuchu || 0; dom.prefab.value = item.prefab || 0;
  updateTotalDisplay();
}

async function handleSave() {
  const jan = dom.jan.value.trim();
  if (!jan || jan.length !== 13) return showToast('JANコードを確認してください');
  const existing = await dbGet(jan);

  const item = {
    jan,
    name: dom.name.value.trim() || '未登録商品',
    makerCode: dom.maker.value.trim(),
    shelf: parseInt(dom.shelf.value, 10) || 0,
    kyakuchu: parseInt(dom.kyakuchu.value, 10) || 0,
    prefab: parseInt(dom.prefab.value, 10) || 0,
    updatedAt: new Date().toISOString(),
    _synced_shelf: existing ? (existing._synced_shelf || 0) : 0,
    _synced_kyakuchu: existing ? (existing._synced_kyakuchu || 0) : 0,
    _synced_prefab: existing ? (existing._synced_prefab || 0) : 0,
    _deleted: false // resurrect if it was deleted
  };

  await dbPut(item);
  isDirty = true;
  showToast('保存しました');
  clearForm(); loadAndRender();
}

// --- Soft Delete Logic ---
async function handleDelete(jan) {
  if (confirm('削除しますか？\n(次回同期時にサーバーからも削除されます)')) {
    // Instead of dbDelete, we set _deleted: true
    const item = await dbGet(jan);
    if (item) {
      item._deleted = true;
      item.updatedAt = new Date().toISOString(); // Update timestamp to win conflict check
      await dbPut(item);
      isDirty = true;
      showToast('削除しました');
      loadAndRender();
    }
  }
}

async function handleEdit(jan) {
  const item = await dbGet(jan);
  if (item) { populateForm(item); setMode('update'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

async function loadAndRender() {
  allItems = await dbGetAll();
  // Filter out soft-deleted items for the view
  // But keep them in allItems if you need them for something? 
  // Better to filter `filteredItems` but base allItems might need clean up.
  // Actually, let's keep allItems as-is (source of truth) and filter in `renderList`.

  allItems = allItems.map(i => {
    if (i.backRoom !== undefined && i.kyakuchu === undefined) { i.kyakuchu = i.backRoom; delete i.backRoom; }
    return i;
  });
  renderList();
}

function renderList(reFilter = true) {
  if (reFilter) {
    const q = searchQuery.toLowerCase();
    // Exclude _deleted items from list
    filteredItems = allItems.filter(i => !i._deleted && (i.jan.includes(q) || i.name.toLowerCase().includes(q)));

    const getTotal = (i) => (i.shelf || 0) + (i.kyakuchu || 0) + (i.prefab || 0);
    if (hideZero) filteredItems = filteredItems.filter(i => getTotal(i) > 0);

    filteredItems.sort((a, b) => {
      const totA = getTotal(a); const totB = getTotal(b);
      switch (sortMode) {
        case 'date-desc': return new Date(b.updatedAt) - new Date(a.updatedAt);
        case 'stock-desc': return totB - totA;
        case 'stock-asc': return totA - totB;
        case 'maker-asc': return (a.makerCode || '').localeCompare(b.makerCode || '');
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
      <div class="item-header"><h3 class="item-title">${escapeHtml(item.name)}</h3><span class="item-total">${totalStock}</span></div>
      <div class="item-detail-row">${details.join('')}</div>
      <div class="item-meta"><span>JAN: ${item.jan}</span><div class="item-actions"><button class="action-edit" data-jan="${item.jan}">編集</button><button class="action-delete" data-jan="${item.jan}">削除</button></div></div>
    `;
    dom.listContainer.appendChild(div);
  });
  dom.pageIndicator.textContent = `${currentPage} / ${maxPage}`; dom.btnPrev.disabled = currentPage === 1; dom.btnNext.disabled = currentPage === maxPage;
}

// --- Sync Logic (Delete + Conflict) ---
function setSyncing(bool) { bool ? dom.syncIndicator.classList.remove('hidden') : dom.syncIndicator.classList.add('hidden'); }

async function handleSyncPush() {
  if (!GAS_API_URL) return showToast('GAS URL未設定');
  setSyncing(true);
  try {
    const data = await dbGetAll(); // Includes _deleted items
    const payload = { action: 'push', data: data };
    const res = await fetch(GAS_API_URL, { method: 'POST', body: JSON.stringify(payload) });
    const json = await res.json();

    if (json.status === 'success') {
      showToast('同期完了');
      isDirty = false;
      // Success? Physically remove deleted items now
      await cleanupDeletedItems();
      // Update synced state
      await updateSyncedState(data.filter(i => !i._deleted));
      await loadAndRender(); // refresh to show cleanup
    }
    else if (json.status === 'conflict') {
      if (confirm(`【競合検知】\n他ユーザーによる更新があります。\n統合しますか？`)) {
        await executeSmartMerge(json.serverItems);
        setTimeout(handleSyncPush, 500); return;
      } else {
        showToast('同期中断');
      }
    }
    else throw new Error(json.message);
  } catch (e) { showToast('同期失敗: ' + e.message); } finally { setSyncing(false); }
}

async function cleanupDeletedItems() {
  const all = await dbGetAll();
  const deleted = all.filter(i => i._deleted);
  for (const item of deleted) {
    await dbDelete(item.jan);
  }
}

async function executeSmartMerge(serverItems) {
  for (const sItem of serverItems) {
    const local = await dbGet(sItem.jan);
    if (!local) continue;

    // If local was deleted, but server is newer (meaning someone updated it), resurrect it?
    // Or if I deleted it and they updated it -> conflict window. 
    // "Server date > Client date". So server wins.
    // If I wanted to delete, but they updated stock, maybe I shouldn't delete?
    // Let's assume resurrection if server update is newer.

    const deltaShelf = (local.shelf || 0) - (local._synced_shelf || 0);
    const deltaKyakuchu = (local.kyakuchu || 0) - (local._synced_kyakuchu || 0);
    const deltaPrefab = (local.prefab || 0) - (local._synced_prefab || 0);

    local.shelf = (sItem.shelf || 0) + deltaShelf;
    local.kyakuchu = (sItem.kyakuchu || 0) + deltaKyakuchu;
    local.prefab = (sItem.prefab || 0) + deltaPrefab;
    local.name = sItem.name;
    local.makerCode = sItem.makerCode;
    local.updatedAt = new Date().toISOString();
    local._deleted = false; // Conflict implies server item exists, so we resurrect

    await dbPut(local);
  }
  showToast('マージ完了。再送信します...');
  await loadAndRender();
}

async function updateSyncedState(items) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  for (const item of items) {
    item._synced_shelf = item.shelf; item._synced_kyakuchu = item.kyakuchu; item._synced_prefab = item.prefab;
    store.put(item);
  }
  return new Promise(resolve => tx.oncomplete = resolve);
}

async function pullFromGAS(isAuto = false) {
  if (!GAS_API_URL) return;
  if (isDirty && !isAuto) if (!confirm('未送信データがあります。上書きして受信しますか？')) return;
  setSyncing(true);
  try {
    const res = await fetch(GAS_API_URL);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('Format');
    await dbClear();
    for (const item of json) {
      item._synced_shelf = item.shelf || 0; item._synced_kyakuchu = item.kyakuchu || 0; item._synced_prefab = item.prefab || 0;
      await dbPut(item);
    }
    await loadAndRender();
    isDirty = false;
    if (!isAuto) showToast('受信完了');
  } catch (e) { if (!isAuto) showToast('受信失敗: ' + e.message); } finally { setSyncing(false); }
}

// --- Utils ---
function toggleScanner() { isScanning ? stopScanner() : startScanner(); }
function startScanner() {
  dom.scannerWrapper.classList.remove('hidden'); dom.btnScanToggle.textContent = '⏹ 読取停止'; dom.btnScanToggle.style.backgroundColor = 'var(--danger-color)';
  setTimeout(() => {
    Quagga.init({ inputStream: { name: "Live", type: "LiveStream", target: document.querySelector('#scanner-container'), constraints: { width: { min: 640 }, height: { min: 480 }, facingMode: "environment", aspectRatio: { min: 1, max: 2 } } }, locator: { patchSize: "medium", halfSample: true }, numOfWorkers: 2, decoder: { readers: ["ean_reader"] }, locate: true }, (err) => {
      if (err) { showToast('カメラ起動失敗: ' + err.name); stopScanner(); return; }
      Quagga.start(); isScanning = true; const v = document.querySelector('#scanner-container video'); if (v) v.setAttribute('playsinline', 'true');
    });
    Quagga.onDetected((res) => { if (res.codeResult.code.length === 13) { playBeep(); dom.jan.value = res.codeResult.code; dom.jan.dispatchEvent(new Event('change')); stopScanner(); } });
  }, 100);
}
function stopScanner() { Quagga.stop(); isScanning = false; dom.scannerWrapper.classList.add('hidden'); dom.btnScanToggle.textContent = '📷 バーコード読取開始'; dom.btnScanToggle.style.backgroundColor = 'var(--text-main)'; }
function showToast(msg) { dom.toast.textContent = msg; dom.toast.classList.add('show'); setTimeout(() => dom.toast.classList.remove('show'), 3000); }
function escapeHtml(s) { return s ? s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#039;' }[m])) : ''; }
function playBeep() { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(800, ctx.currentTime); o.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.1); }
function setupServiceWorker() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').then(r => { if (r.waiting) r.waiting.postMessage({ type: 'SKIP_WAITING' }) }); }

init();

