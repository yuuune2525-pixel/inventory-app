/**
 * PWA Stock App Main Logic
 */

// --- Configuration ---
// ↓ ここにGASのデプロイURLを貼り付けてください
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzrVqPQPpS5XvKsMdsIT84b3Ff7hSzMlAXsGgQ34s_0Cw2OxEaGK8iMiQIHjUiOwN6S/exec';

// --- Constants & State ---
const DB_NAME = 'StockAppDB';
const DB_VERSION = 1;
const STORE_NAME = 'products';

let db = null;
let codeReader = null;
let currentStream = null;
let isScanning = false;

// State for pagination
let allItems = [];
let filteredItems = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 10;

// Filters
let sortMode = 'date-desc';
let searchQuery = '';

// --- DOM Elements ---
const dom = {
  jan: document.getElementById('inp-jan'),
  name: document.getElementById('inp-name'),
  maker: document.getElementById('inp-maker'),
  stock: document.getElementById('inp-stock'),

  btnScanToggle: document.getElementById('btn-scan-toggle'),
  scannerWrapper: document.getElementById('scanner-wrapper'),
  video: document.getElementById('video'),

  btnMinus: document.getElementById('btn-minus'),
  btnPlus: document.getElementById('btn-plus'),
  btnSave: document.getElementById('btn-save'),
  btnClear: document.getElementById('btn-clear'),

  btnSync: document.getElementById('btn-sync'),
  syncText: document.getElementById('sync-text'),

  search: document.getElementById('inp-search'),
  sort: document.getElementById('sel-sort'),

  listContainer: document.getElementById('list-container'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  pageIndicator: document.getElementById('page-indicator'),

  toast: document.getElementById('toast'),
};

// --- Initialization ---
async function init() {
  await initDB();
  setupEventListeners();
  setupServiceWorker();
  await loadAndRender();
}

// --- IndexedDB ---
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // JAN as key
        db.createObjectStore(STORE_NAME, { keyPath: 'jan' });
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    request.onerror = (e) => {
      console.error('DB Error:', e);
      reject(e);
    };
  });
}

async function dbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbPut(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(item); // Add or Update
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function dbDelete(jan) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(jan);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function dbGet(jan) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(jan);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbClear() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// --- Event Listeners ---
function setupEventListeners() {
  // Barcode
  dom.btnScanToggle.addEventListener('click', toggleScanner);

  // Stock +/-
  dom.btnMinus.addEventListener('click', () => updateStockInput(-1));
  dom.btnPlus.addEventListener('click', () => updateStockInput(1));

  // Input restriction
  dom.maker.addEventListener('input', (e) => {
    // Digits only
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
  });
  dom.stock.addEventListener('input', (e) => {
    // Non-negative integer
    let val = parseInt(e.target.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    e.target.value = val;
  });

  // Save
  dom.btnSave.addEventListener('click', handleSave);
  dom.btnClear.addEventListener('click', clearForm);

  // List Actions (Event Delegation)
  dom.listContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.classList.contains('btn-delete')) {
      const jan = btn.dataset.jan;
      if (jan) handleDelete(jan);
    } else if (btn.classList.contains('btn-edit')) {
      const jan = btn.dataset.jan;
      if (jan) handleEdit(jan);
    }
  });

  // List Filters
  dom.search.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    currentPage = 1;
    renderList();
  });
  dom.sort.addEventListener('change', (e) => {
    sortMode = e.target.value;
    renderList();
  });

  // Pagination
  dom.btnPrev.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderList(false); // Don't re-filter, just slice
    }
  });
  dom.btnNext.addEventListener('click', () => {
    const maxPage = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
    if (currentPage < maxPage) {
      currentPage++;
      renderList(false);
    }
  });

  // Sync
  dom.btnSync.addEventListener('click', handleSync);

  // Auto-fill logic when JAN is typed/scanned
  dom.jan.addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val.length === 13) {
      const existing = await dbGet(val);
      if (existing) {
        populateForm(existing);
        showToast('既存の商品データを読み込みました');
      }
    }
  });
}

// --- UI Logic ---
function updateStockInput(delta) {
  let val = parseInt(dom.stock.value, 10) || 0;
  val += delta;
  if (val < 0) val = 0;
  dom.stock.value = val;
}

function clearForm() {
  dom.jan.value = '';
  dom.name.value = '';
  dom.maker.value = '';
  dom.stock.value = '0';
  dom.jan.disabled = false;
}

function populateForm(item) {
  dom.jan.value = item.jan;
  dom.name.value = item.name;
  dom.maker.value = item.makerCode;
  dom.stock.value = item.stock;
}

async function handleSave() {
  const jan = dom.jan.value.trim();
  const name = dom.name.value.trim();
  const makerCode = dom.maker.value.trim();
  const stock = parseInt(dom.stock.value, 10);

  // Validation
  if (!jan || jan.length !== 13) {
    showToast('JANコードは13桁で入力してください');
    return;
  }
  if (!name) {
    showToast('商品名を入力してください');
    return;
  }

  const item = {
    jan,
    name,
    makerCode,
    stock,
    updatedAt: new Date().toISOString()
  };

  await dbPut(item);
  showToast('保存しました');
  clearForm();
  await loadAndRender();
}

async function handleDelete(jan) {
  if (confirm('本当に削除しますか？\n(JAN: ' + jan + ')')) {
    try {
      await dbDelete(jan);
      showToast('削除しました');
      // Fix: Ensure we reload properly, handle pagination if page becomes empty
      allItems = await dbGetAll(); // Refresh source of truth

      // logic to handle page count reduction
      // We will rely on renderList to re-calc filtering but we need to ensure current page isn't out of bounds
      // We'll reset to page 1 if safe, or keep calling renderList checks
      if (filteredItems.length <= 1 && currentPage > 1) { // rough guess, better to let renderList handle
        // actually re-calling loadAndRender does everything
      }

      renderList();
    } catch (e) {
      console.error(e);
      showToast('削除に失敗しました: ' + e.message);
    }
  }
}

function handleEdit(jan) {
  const item = allItems.find(i => i.jan === jan);
  if (item) {
    populateForm(item);
    window.scrollTo({ top: dom.jan.offsetTop - 100, behavior: 'smooth' });
  }
}

// --- List & Rendering ---
async function loadAndRender() {
  allItems = await dbGetAll();
  renderList();
}

function renderList(reFilter = true) {
  if (reFilter) {
    // 1. Search
    const q = searchQuery.toLowerCase();
    filteredItems = allItems.filter(item => {
      return (item.jan.includes(q) || item.name.toLowerCase().includes(q));
    });

    // 2. Sort
    filteredItems.sort((a, b) => {
      switch (sortMode) {
        case 'date-desc': return new Date(b.updatedAt) - new Date(a.updatedAt);
        case 'date-asc': return new Date(a.updatedAt) - new Date(b.updatedAt);
        case 'stock-desc': return b.stock - a.stock;
        case 'stock-asc': return a.stock - b.stock;
        case 'maker-asc': return (a.makerCode || '').localeCompare(b.makerCode || '');
        case 'maker-desc': return (b.makerCode || '').localeCompare(a.makerCode || '');
        default: return 0;
      }
    });
  }

  // 3. Pagination
  const total = filteredItems.length;
  const maxPage = Math.ceil(total / ITEMS_PER_PAGE) || 1;
  if (currentPage > maxPage) currentPage = maxPage;

  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const pageItems = filteredItems.slice(start, end);

  // Render
  dom.listContainer.innerHTML = '';
  pageItems.forEach(item => {
    const el = document.createElement('div');
    el.className = 'item-card';
    el.innerHTML = `
      <div class="item-info">
        <h3>${escapeHtml(item.name)}</h3>
        <div class="item-meta">
          <span>JAN: ${item.jan}</span>
          ${item.makerCode ? `<span>Maker: ${escapeHtml(item.makerCode)}</span>` : ''}
          <span>📅 ${new Date(item.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="item-stock">
        <span class="stock-badge">${item.stock}</span>
      </div>
      <div class="item-actions">
        <button class="btn-sm btn-edit" data-jan="${item.jan}">編集</button>
        <button class="btn-sm btn-delete" data-jan="${item.jan}">削除</button>
      </div>
    `;
    dom.listContainer.appendChild(el);
  });

  // Update Controls
  dom.pageIndicator.textContent = `${currentPage} / ${maxPage}`;
  dom.btnPrev.disabled = (currentPage === 1);
  dom.btnNext.disabled = (currentPage === maxPage);
}

// --- Barcode Scanner (ZXing) ---
async function toggleScanner() {
  if (isScanning) {
    stopScanner();
  } else {
    startScanner();
  }
}

async function startScanner() {
  if (!codeReader) {
    codeReader = new ZXing.BrowserMultiFormatReader();
  }

  try {
    dom.scannerWrapper.classList.remove('hidden');
    dom.btnScanToggle.textContent = '⏹ 読取停止';
    dom.btnScanToggle.style.backgroundColor = 'var(--danger-color)';
    isScanning = true;

    // Use rear camera
    const constraints = {
      video: { facingMode: 'environment' }
    };

    codeReader.decodeFromVideoDevice(null, 'video', (result, err) => {
      if (result) {
        console.log("Found:", result.text);
        if (result.text.length === 13) { // Basic JAN filter
          // Success tone
          playBeep();

          dom.jan.value = result.text;
          // Trigger change event to load data if exists
          dom.jan.dispatchEvent(new Event('change'));

          stopScanner();
          showToast(`読み取り成功: ${result.text}`);
        }
      }
      if (err && !(err instanceof ZXing.NotFoundException)) {
        console.error(err);
      }
    });

  } catch (err) {
    console.error(err);
    showToast('カメラの起動に失敗しました');
    stopScanner();
  }
}

function stopScanner() {
  if (codeReader) {
    codeReader.reset();
  }
  dom.scannerWrapper.classList.add('hidden');
  dom.btnScanToggle.textContent = '📷 バーコード読取開始';
  dom.btnScanToggle.style.backgroundColor = 'var(--text-main)';
  isScanning = false;
}

// --- Sync Logic (GAS) ---
async function handleSync() {
  if (!GAS_API_URL) {
    showToast('GAS URLが設定されていません');
    return;
  }
  const confirmMsg = "Googleスプレッドシートと同期しますか？\n(注意: ローカルのデータでシートを上書き、またはシートのデータを取り込みます)";
  // Since user asked for Bi-directional, let's keep it simple:
  // "Push Local to Sheet" or "Pull Sheet to Local" options? 
  // Requirement: "双方向（追加・更新・削除）に同期したい"
  // Best effort: Get Sheet Data, Merge with Local? Or simply Push Local?
  // Let's implement a choice or a smart merge.
  // For simplicity and user safety, I will implement "Push to Sheet" and "Pull from Sheet" separately is better, but maybe just one action.
  // Let's try: 
  // 1. Backup local.
  // 2. Fetch Sheet Data. 
  // 3. For now, since no complex conflict resolution, I'll assume "Local is Master" for editing, then syncs to Cloud.
  // But wait, if user edits in Sheet, they want it reflected.
  // Let's prompt user: "Download" or "Upload"?

  // Actually, to fully satisfy "Sync", I'll do a simple "Push" because that's safer for "My App" usually.
  // BUT the prompt asks for "Update/Delete" sync.
  // Let's try to fetch, merge by time?
  // No, let's offer a menu or just "Download (Overwrite Local)" and "Upload (Overwrite Sheet)".
  // Users understand that better than "Magic Sync" that breaks things.
  // However, I can't do a UI menu easily in a button click without a modal.
  // I will just use `confirm`.

  // Implementation: "Push all local data to Sheet" -> Sheet matches local exactly.
  // This supports add/update/delete (since we validly overwrite the sheet).

  if (!confirm('データを同期します。\n\n[OK] = データを送信 (シートを上書き)\n[キャンセル] = データを受信 (ローカルを上書き)')) {
    // User clicked Cancel -> Pull
    await pullFromGAS();
  } else {
    // User clicked OK -> Push
    await pushToGAS();
  }
}

async function pushToGAS() {
  showToast('送信中...');
  try {
    const data = await dbGetAll();
    const payload = {
      action: 'push',
      data: data
    };

    await fetch(GAS_API_URL, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    showToast('送信完了: シートを更新しました');
  } catch (e) {
    console.error(e);
    showToast('送信エラー: ' + e.message);
  }
}

async function pullFromGAS() {
  showToast('受信中...');
  try {
    // GAS fetch needs usually "GET" or POST with action.
    // Let's use POST for consistency or GET if CORS allows. Simple GET usually redirects in GAS.
    // Better to use POST for everything with GAS to avoid 302 redirect issues in some clients.
    const payload = { action: 'pull' };
    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const jsonData = await res.json();
    if (!Array.isArray(jsonData)) throw new Error('Invalid data format');

    await dbClear();
    for (const item of jsonData) {
      // Ensure data types
      item.stock = parseInt(item.stock, 10) || 0;
      await dbPut(item);
    }

    await loadAndRender();
    showToast('受信完了: ローカルデータを更新しました');
  } catch (e) {
    console.error(e);
    showToast('受信エラー: ' + e.message);
  }
}

// --- Utils ---
function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  setTimeout(() => {
    dom.toast.classList.remove('show');
  }, 3000);
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, function (m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[m];
  });
}

function playBeep() {
  // Simple beep logic
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, ctx.currentTime);
  osc.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.1);
}

function setupServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js')
      .then(reg => console.log('SW Registered', reg))
      .catch(err => console.log('SW Failed', err));
  }
}

// Start
init();

// Global handles for HTML access
window.handleDelete = handleDelete;
window.handleEdit = handleEdit;

