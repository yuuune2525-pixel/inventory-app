/**
 * PWA Stock App V3.1 (Restored Features)
 */

// Configuration
const GAS_API_URL = ''; // Update this!

// State
let db = null;
let currentMode = null; // 'shelf', 'kyakuchu', 'prefab', 'view'
let allItems = [];
let filteredItems = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 10;
let isScanning = false;
let sortMode = 'date-desc';

// DOM Elements
const dom = {
  modeSelector: document.getElementById('mode-selector'),
  appContainer: document.getElementById('app-container'),
  appHeader: document.getElementById('app-header'),
  headerTitle: document.getElementById('header-title'),
  btnBack: document.getElementById('btn-back'),

  // Cards
  cardScanner: document.getElementById('card-scanner'),
  cardInput: document.getElementById('card-input'),
  badgeMode: document.getElementById('badge-mode'),

  // Input
  jan: document.getElementById('inp-jan'),
  name: document.getElementById('inp-name'),
  maker: document.getElementById('inp-maker'),
  stock: document.getElementById('inp-stock'),
  lblStock: document.getElementById('lbl-stock-location'),

  // Buttons
  btnScan: document.getElementById('btn-scan-toggle'),
  btnManual: document.getElementById('btn-sync-manual'),
  btnSave: document.getElementById('btn-save-confirm'),
  btnClear: document.getElementById('btn-clear'),

  // List
  list: document.getElementById('list-container'),
  inpSearch: document.getElementById('inp-search'),
  selSort: document.getElementById('sel-sort'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  pageIndicator: document.getElementById('page-indicator'),

  // Status
  status: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  toast: document.getElementById('toast'),
  scannerWrapper: document.getElementById('scanner-wrapper'),
};

const app = {
  async init() {
    await this.initDB();
    this.setupEvents();
    this.setupSW();
    this.setupCommonUI();
  },

  async initDB() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('StockAppV3', 1);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'jan' });
      };
      r.onsuccess = e => { db = e.target.result; resolve(); };
      r.onerror = reject;
    });
  },

  setupCommonUI() {
    // Prevent double tap zoom
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  },

  setupEvents() {
    window.app = this;

    // Mode Switching
    dom.btnBack.onclick = () => {
      dom.appContainer.classList.add('hidden');
      dom.modeSelector.classList.remove('hidden');
      currentMode = null;
      document.body.className = '';
    };

    // Manual Save
    dom.btnSave.onclick = () => this.saveAndSync();

    // Blur = Local Save. Button = Sync.
    [dom.name, dom.maker, dom.stock].forEach(el => {
      el.addEventListener('blur', () => this.saveLocalOnly());
    });

    // Stock Adjustment
    document.getElementById('btn-plus').onclick = () => { this.adjStock(1); this.saveLocalOnly(); };
    document.getElementById('btn-minus').onclick = () => { this.adjStock(-1); this.saveLocalOnly(); };

    // Input Logic
    dom.jan.addEventListener('change', () => this.onJanChange());
    dom.btnClear.onclick = () => this.clearForm();

    // Scanner
    dom.btnScan.onclick = () => this.toggleScanner();
    dom.btnManual.onclick = () => this.syncAll(true);

    // List Controls
    dom.inpSearch.addEventListener('input', () => { currentPage = 1; this.renderList(); });
    dom.selSort.addEventListener('change', (e) => { sortMode = e.target.value; this.renderList(); });
    dom.btnPrev.onclick = () => { if (currentPage > 1) { currentPage--; this.renderList(false); } };
    dom.btnNext.onclick = () => {
      const max = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
      if (currentPage < max) { currentPage++; this.renderList(false); }
    };

    // List Actions
    dom.list.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const jan = btn.dataset.jan;
      if (btn.classList.contains('action-delete')) this.handleDelete(jan);
      if (btn.classList.contains('action-edit')) this.handleEdit(jan);
    });
  },

  // --- Mode Logic ---
  selectMode(mode) {
    currentMode = mode;
    dom.modeSelector.classList.add('hidden');
    dom.appContainer.classList.remove('hidden');
    document.body.className = `theme-${mode}`;

    if (mode === 'view') {
      dom.cardScanner.classList.add('hidden');
      dom.cardInput.classList.add('hidden');
      dom.headerTitle.textContent = '全在庫確認';
    } else {
      dom.cardScanner.classList.remove('hidden');
      dom.cardInput.classList.remove('hidden');
      const labels = { shelf: '棚上', kyakuchu: '客注部屋', prefab: 'プレハブ' };
      dom.headerTitle.textContent = labels[mode] || '在庫管理';
      dom.lblStock.textContent = `在庫数 (${labels[mode]})`;
      dom.badgeMode.textContent = labels[mode] + ' モード';
    }

    this.loadList();
    if (GAS_API_URL) this.syncAll(false); // Silent sync on entry
  },

  // --- Data Logic ---

  async saveLocalOnly() {
    if (currentMode === 'view' || !dom.jan.value) return;
    const jan = dom.jan.value;
    const item = await this.dbGet(jan) || { jan, name: '', makerCode: '', shelf: 0, kyakuchu: 0, prefab: 0 };

    item.name = dom.name.value;
    item.makerCode = dom.maker.value;
    const val = parseInt(dom.stock.value) || 0;

    if (currentMode === 'shelf') item.shelf = val;
    if (currentMode === 'kyakuchu') item.kyakuchu = val;
    if (currentMode === 'prefab') item.prefab = val;

    item.updatedAt = new Date().toISOString();
    await this.dbPut(item);
    this.renderList();
  },

  async saveAndSync() {
    await this.saveLocalOnly();
    const jan = dom.jan.value;
    if (!jan) return;

    this.showStatus('syncing', '送信中...');
    const item = await this.dbGet(jan);

    // Construct payload
    let val = 0;
    if (currentMode === 'shelf') val = item.shelf;
    if (currentMode === 'kyakuchu') val = item.kyakuchu;
    if (currentMode === 'prefab') val = item.prefab;

    const payloadItem = {
      jan: item.jan, name: item.name, makerCode: item.makerCode,
      stock: val, updatedAt: item.updatedAt
    };

    try {
      const res = await fetch(GAS_API_URL, {
        method: 'POST',
        body: JSON.stringify({ target: currentMode, data: [payloadItem] })
      });
      const json = await res.json();

      if (json.status === 'success') {
        this.showStatus('hidden');
        this.toast('登録完了');
      } else if (json.status === 'conflict') {
        if (confirm('他人が更新しました。サーバーの値で上書きしますか？')) {
          const s = json.serverItems[0];
          dom.stock.value = s.stock || 0;
          this.saveLocalOnly();
        }
      }
    } catch (e) {
      this.showStatus('error', '未送信');
    }
  },

  async handleDelete(jan) {
    if (currentMode === 'view') return; // Cannot delete in view mode (which sheet?)
    if (!confirm('この場所の在庫データを削除しますか？')) return;

    // Logical delete for this sheet
    this.showStatus('syncing', '削除中...');

    // We send _deleted flag
    const payloadItem = { jan, _deleted: true, updatedAt: new Date().toISOString() };

    try {
      const res = await fetch(GAS_API_URL, {
        method: 'POST',
        body: JSON.stringify({ target: currentMode, data: [payloadItem] })
      });
      const json = await res.json();
      if (json.status === 'success') {
        this.toast('削除しました');
        // Update local: set stock to 0 for this mode? Or remove item entirely?
        // Since local DB is unified, maybe we just set stock to 0 or remove if all stocks 0.
        // For independent mode, let's just set THIS mode stock to 0.
        const item = await this.dbGet(jan);
        if (item) {
          if (currentMode === 'shelf') item.shelf = 0;
          if (currentMode === 'kyakuchu') item.kyakuchu = 0;
          if (currentMode === 'prefab') item.prefab = 0;
          await this.dbPut(item);
          this.renderList();
        }
      }
    } catch (e) {
      this.toast('削除失敗: 通信エラー');
    } finally {
      this.showStatus('hidden');
    }
  },

  async syncAll(manual = false) {
    if (!GAS_API_URL) return;
    if (manual) this.showStatus('syncing', 'データ取得中...');

    const target = currentMode === 'view' ? 'all' : currentMode;
    try {
      const res = await fetch(`${GAS_API_URL}?target=${target}`);
      const data = await res.json();
      if (target === 'all') {
        await this.dbClear();
        for (const i of data) await this.dbPut(i);
      } else {
        for (const row of data) {
          const local = await this.dbGet(row.jan) || { jan: row.jan, name: row.name, makerCode: row.makerCode, shelf: 0, kyakuchu: 0, prefab: 0 };
          if (target === 'shelf') local.shelf = row.stock;
          if (target === 'kyakuchu') local.kyakuchu = row.stock;
          if (target === 'prefab') local.prefab = row.stock;
          local.name = row.name;
          await this.dbPut(local);
        }
      }
      this.loadList();
      if (manual) this.toast('受信完了');
      if (manual) this.showStatus('hidden');
    } catch (e) {
      if (manual) this.showStatus('error', '受信失敗');
    }
  },

  // --- List & Pagination ---
  async loadList() {
    allItems = await this.dbGetAll();
    this.renderList();
  },

  renderList(reFilter = true) {
    if (reFilter) {
      const q = document.getElementById('inp-search').value.toLowerCase();

      // Filter Logic:
      // If View Mode: Show ALL items (match search)
      // If Mode X: Show items where Stock X > 0 OR user manually searched?
      // User request: "Log of current mode". Usually means history of actions OR just items in that location.
      // Let's show items that have stock in this location OR match search query.

      filteredItems = allItems.filter(i => {
        const matchesQ = i.jan.includes(q) || i.name.toLowerCase().includes(q);
        if (currentMode === 'view') return matchesQ;

        // Mode Specific Filter
        let hasStock = false;
        if (currentMode === 'shelf' && (i.shelf > 0)) hasStock = true;
        if (currentMode === 'kyakuchu' && (i.kyakuchu > 0)) hasStock = true;
        if (currentMode === 'prefab' && (i.prefab > 0)) hasStock = true;

        // Return if matches Query OR (No Query & Has Stock)
        // If Query exists, show regardless of stock to allow finding.
        if (q) return matchesQ;
        return hasStock;
      });

      // Sort
      filteredItems.sort((a, b) => {
        const dateA = new Date(a.updatedAt).getTime();
        const dateB = new Date(b.updatedAt).getTime();
        const stockA = this.getTotal(a);
        const stockB = this.getTotal(b);

        switch (sortMode) {
          case 'date-desc': return dateB - dateA;
          case 'name-asc': return a.name.localeCompare(b.name);
          case 'stock-asc': return stockA - stockB;
          default: return 0;
        }
      });
    }

    // Pagination
    const maxPage = Math.ceil(filteredItems.length / ITEMS_PER_PAGE) || 1;
    if (currentPage > maxPage) currentPage = maxPage;
    const pageItems = filteredItems.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    dom.list.innerHTML = '';

    pageItems.forEach(i => {
      let html = `<div class="item-card">`;
      const displayName = i.name || '(未登録)';

      if (currentMode === 'view') {
        const total = this.getTotal(i);
        html += `<div class="item-header"><span>${displayName}</span> <span class="item-total">計 ${total}</span></div>
        <div class="item-breakdown">
           <span class="badge" style="color:var(--color-shelf)">棚:${i.shelf || 0}</span>
           <span class="badge" style="color:var(--color-kyakuchu)">客:${i.kyakuchu || 0}</span>
           <span class="badge" style="color:var(--color-prefab)">プ:${i.prefab || 0}</span>
        </div>`;
      } else {
        // Edit Mode Log
        let val = 0;
        if (currentMode === 'shelf') val = i.shelf;
        if (currentMode === 'kyakuchu') val = i.kyakuchu;
        if (currentMode === 'prefab') val = i.prefab;

        html += `<div class="item-header"><span>${displayName}</span> <span class="item-total" style="font-size:1.2rem">${val || 0}</span></div>`;
      }

      html += `<div class="item-meta">JAN: ${i.jan}`;
      html += `<button class="action-edit" data-jan="${i.jan}" style="margin-left:auto; margin-right:5px;">編集</button>`;
      if (currentMode !== 'view') {
        html += `<button class="action-delete" data-jan="${i.jan}">削除</button>`;
      }
      html += `</div></div>`;

      dom.list.innerHTML += html;
    });

    dom.pageIndicator.textContent = `${currentPage} / ${maxPage}`;
    dom.btnPrev.disabled = currentPage === 1;
    dom.btnNext.disabled = currentPage === maxPage;
  },

  getTotal(i) { return (i.shelf || 0) + (i.kyakuchu || 0) + (i.prefab || 0); },

  // Helpers
  adjStock(d) { let v = parseInt(dom.stock.value) || 0; v += d; if (v < 0) v = 0; dom.stock.value = v; },
  async onJanChange() {
    const jan = dom.jan.value;
    if (jan.length === 13) {
      const item = await this.dbGet(jan);
      if (item) {
        dom.name.value = item.name;
        dom.maker.value = item.makerCode;
        if (currentMode === 'shelf') dom.stock.value = item.shelf || 0;
        if (currentMode === 'kyakuchu') dom.stock.value = item.kyakuchu || 0;
        if (currentMode === 'prefab') dom.stock.value = item.prefab || 0;
        this.toast('読込完了');
      } else {
        dom.name.value = ''; dom.maker.value = ''; dom.stock.value = 0;
      }
    }
  },
  handleEdit(jan) {
    if (currentMode === 'view') return alert('閲覧モード中は編集できません。場所を選択してください。');
    dom.jan.value = jan;
    this.onJanChange();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  // UI Utils
  showStatus(type, msg) {
    dom.status.className = `status-bar ${type}`;
    if (type === 'hidden') dom.status.classList.add('hidden');
    dom.statusText.textContent = msg || '';
  },
  toast(msg) {
    dom.toast.textContent = msg; dom.toast.classList.add('show');
    setTimeout(() => dom.toast.classList.remove('show'), 3000);
  },
  clearForm() { dom.jan.value = ''; dom.name.value = ''; dom.maker.value = ''; dom.stock.value = 0; },

  // DB & Scanner (Standard)
  dbPut(i) { return new Promise(r => { const t = db.transaction('items', 'readwrite'); t.objectStore('items').put(i); t.oncomplete = r; }); },
  dbGet(k) { return new Promise(r => { const t = db.transaction('items', 'readonly'); const q = t.objectStore('items').get(k); q.onsuccess = () => r(q.result); }); },
  dbGetAll() { return new Promise(r => { const t = db.transaction('items', 'readonly'); const q = t.objectStore('items').getAll(); q.onsuccess = () => r(q.result); }); },
  dbClear() { return new Promise(r => { const t = db.transaction('items', 'readwrite'); const q = t.objectStore('items').clear(); q.onsuccess = () => r(); }); },
  toggleScanner() {
    if (isScanning) { Quagga.stop(); isScanning = false; dom.scannerWrapper.classList.add('hidden'); }
    else {
      dom.scannerWrapper.classList.remove('hidden');
      Quagga.init({ inputStream: { name: "Live", type: "LiveStream", target: document.querySelector('#scanner-container'), constraints: { width: 640, height: 480, facingMode: "environment" } }, decoder: { readers: ["ean_reader"] } }, err => {
        if (!err) { Quagga.start(); isScanning = true; }
      });
      Quagga.onDetected(res => { if (res.codeResult.code.length === 13) { dom.jan.value = res.codeResult.code; this.onJanChange(); this.toggleScanner(); } });
    }
  },
  setupSW() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').then(r => {
      r.addEventListener('updatefound', () => { const n = r.installing; n.addEventListener('statechange', () => { if (n.state === 'installed' && navigator.serviceWorker.controller) n.postMessage({ type: 'SKIP_WAITING' }); }); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  }
};

app.init();
