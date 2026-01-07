/**
 * PWA Stock App Main Logic (Quagga2 + GAS Sync)
 */

// --- Configuration ---
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbxkDLmpPBodGZeVnXB8lsnIRIQ2W8SR89otF5oKbZ5ZqAzZfTnHZpXJDZTZo1LzsRYhRg/exec'; // ここにGASのWebアプリURLを貼り付けてください

// --- Constants & State ---
const DB_NAME = 'StockAppDB';
const DB_VERSION = 1;
const STORE_NAME = 'products';

let db = null;
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
  scannerMsg: document.getElementById('scanner-msg'),

  btnMinus: document.getElementById('btn-minus'),
  btnPlus: document.getElementById('btn-plus'),
  btnSave: document.getElementById('btn-save'),
  btnClear: document.getElementById('btn-clear'),

  btnSync: document.getElementById('btn-sync'),
  btnManualPull: document.getElementById('btn-manual-pull'),

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

  // Load local data first
  await loadAndRender();

  // Auto-Sync (Pull) on Start if URL is present
  if (GAS_API_URL) {
    console.log('Auto-sync starting...');
    // We don't block the UI, just run in bg
    pullFromGAS(true);
  }
}

// --- IndexedDB ---
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'jan' });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => reject(e);
  });
}

async function dbGetAll() {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve([]);
  });
}

function dbPut(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(jan) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(jan);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbClear() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbGet(jan) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(jan);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

// --- Event Listeners ---
function setupEventListeners() {
  // Barcode
  dom.btnScanToggle.addEventListener('click', toggleScanner);

  // Stock +/-
  dom.btnMinus.addEventListener('click', () => updateStockInput(-1));
  dom.btnPlus.addEventListener('click', () => updateStockInput(1));

  // Input validations
  dom.maker.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
  });
  dom.stock.addEventListener('input', (e) => {
    let val = parseInt(e.target.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    e.target.value = val;
  });

  // Save/Clear
  dom.btnSave.addEventListener('click', handleSave);
  dom.btnClear.addEventListener('click', clearForm);

  // Sync
  dom.btnSync.addEventListener('click', handlePushSync); // Send to Sheet
  dom.btnManualPull.addEventListener('click', () => pullFromGAS(false)); // Get from Sheet

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
      renderList(false);
    }
  });
  dom.btnNext.addEventListener('click', () => {
    const maxPage = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
    if (currentPage < maxPage) {
      currentPage++;
      renderList(false);
    }
  });

  // List Delegation (Edit/Delete)
  dom.listContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const jan = btn.dataset.jan;

    if (btn.classList.contains('btn-delete')) {
      handleDelete(jan);
    } else if (btn.classList.contains('btn-edit')) {
      handleEdit(jan);
    }
  });

  // Auto-fill
  dom.jan.addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val.length === 13) {
      const existing = await dbGet(val);
      if (existing) {
        populateForm(existing);
        showToast('データを読み込みました');
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
  if (confirm(`本当に削除しますか？\n(JAN: ${jan})`)) {
    await dbDelete(jan);
    showToast('削除しました');
    await loadAndRender();
  }
}

async function handleEdit(jan) {
  const item = await dbGet(jan);
  if (item) {
    populateForm(item);
    window.scrollTo({ top: dom.jan.offsetTop - 100, behavior: 'smooth' });
  }
}

// --- List Logic ---
async function loadAndRender() {
  allItems = await dbGetAll();
  renderList();
}

function renderList(reFilter = true) {
  if (reFilter) {
    const q = searchQuery.toLowerCase();
    filteredItems = allItems.filter(i => i.jan.includes(q) || i.name.toLowerCase().includes(q));

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

  const total = filteredItems.length;
  const maxPage = Math.ceil(total / ITEMS_PER_PAGE) || 1;
  if (currentPage > maxPage) currentPage = maxPage;

  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filteredItems.slice(start, start + ITEMS_PER_PAGE);

  dom.listContainer.innerHTML = '';
  pageItems.forEach(item => {
    const div = document.createElement('div');
    div.className = 'item-card';
    div.innerHTML = `
      <div class="item-info">
        <h3>${escapeHtml(item.name)}</h3>
        <div class="item-meta">
          <span>JAN: ${item.jan}</span>
          <span>${item.makerCode ? 'Maker: ' + escapeHtml(item.makerCode) : ''}</span>
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
    dom.listContainer.appendChild(div);
  });

  dom.pageIndicator.textContent = `${currentPage} / ${maxPage}`;
  dom.btnPrev.disabled = (currentPage === 1);
  dom.btnNext.disabled = (currentPage === maxPage);
}

// --- Barcode (Quagga2) ---
function toggleScanner() {
  if (isScanning) {
    stopScanner();
  } else {
    startScanner();
  }
}

function startScanner() {
  // Config for Quagga
  dom.scannerWrapper.classList.remove('hidden');
  dom.btnScanToggle.textContent = '⏹ 読取停止';
  dom.btnScanToggle.style.backgroundColor = 'var(--danger-color)';

  Quagga.init({
    inputStream: {
      name: "Live",
      type: "LiveStream",
      target: document.querySelector('#scanner-container'),
      constraints: {
        width: 480,
        height: 320,
        facingMode: "environment" // Rear Camera
      }
    },
    decoder: {
      readers: ["ean_reader"] // JAN = EAN-13
    }
  }, function (err) {
    if (err) {
      console.error(err);
      showToast('カメラの起動に失敗しました: ' + err.name);
      stopScanner();
      return;
    }
    console.log("Quagga Init Success");
    Quagga.start();
    isScanning = true;

    // Ensure playsinline for iOS (Quagga usually handles it, but let's force check)
    const videos = document.querySelectorAll('video');
    videos.forEach(v => v.setAttribute('playsinline', 'true'));
  });

  Quagga.onDetected(onBarcodeDetected);
}

function stopScanner() {
  Quagga.stop();
  Quagga.offDetected(onBarcodeDetected);
  isScanning = false;
  dom.scannerWrapper.classList.add('hidden');
  dom.btnScanToggle.textContent = '📷 バーコード読取開始';
  dom.btnScanToggle.style.backgroundColor = 'var(--text-main)';
}

function onBarcodeDetected(result) {
  const code = result.codeResult.code;
  if (!code) return;

  // Basic debounce or check could go here
  console.log("Detected:", code);

  if (code.length === 13) {
    playBeep();
    dom.jan.value = code;
    dom.jan.dispatchEvent(new Event('change')); // Trigger autofill
    showToast(`読み取り: ${code}`);
    stopScanner();
  }
}

// --- Sync Logic ---
// 1. Push: App -> Sheet
async function handlePushSync() {
  if (!GAS_API_URL) {
    showToast('GAS URLが未設定です');
    return;
  }
  if (!confirm('【送信】\n現在のアプリ内データでスプレッドシートを上書きしますか？')) {
    return;
  }

  showToast('送信中...');
  try {
    const data = await dbGetAll();
    const payload = {
      action: 'push',
      data: data
    };

    await fetch(GAS_API_URL, {
      method: 'POST', // Always POST for Apps Script execution
      body: JSON.stringify(payload)
    });

    showToast('送信完了: シートを更新しました');
  } catch (e) {
    console.error(e);
    showToast('送信失敗: ' + e.message);
  }
}

// 2. Pull: Sheet -> App
async function pullFromGAS(isAuto = false) {
  if (!GAS_API_URL) return;

  if (!isAuto && !confirm('【受信】\nスプレッドシートのデータを取り込みますか？\n(アプリ内の現在のデータは上書きされます)')) {
    return;
  }

  if (!isAuto) showToast('データ受信中...');

  try {
    // GET request (Apps Script doGet)
    const res = await fetch(GAS_API_URL);
    if (!res.ok) throw new Error('Network Error');

    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('Format Error');

    // Success: Replace DB
    await dbClear();
    for (const item of json) {
      await dbPut(item);
    }

    await loadAndRender();
    if (!isAuto) showToast(`受信完了: ${json.length}件取り込みました`);
    else console.log(`Auto-sync success: ${json.length} items`);
  } catch (e) {
    console.error(e);
    if (!isAuto) showToast('受信失敗: ' + e.message);
  }
}

// --- Utils ---
function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  setTimeout(() => dom.toast.classList.remove('show'), 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[m]);
}

function playBeep() {
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
      .then(reg => console.log('SW Registered'))
      .catch(err => console.log('SW Fail', err));
  }
}

// Init
init();
