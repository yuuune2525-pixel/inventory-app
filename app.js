/**
 * PWA Stock App V3 (Independent Modes)
 */

// Config
const GAS_API_URL = ''; // Update this needed

// State
let db = null;
let currentMode = null; // 'shelf', 'kyakuchu', 'prefab', 'view'
let allItems = [];
let isScanning = false;

// DOM
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

  btnScan: document.getElementById('btn-scan-toggle'),
  btnManual: document.getElementById('btn-sync-manual'),
  btnClear: document.getElementById('btn-clear'),

  list: document.getElementById('list-container'),
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

    // Check if URL has mode? (Optional)
    // Default: Show Mode Selector
  },

  async initDB() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('StockAppV3', 1);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        // We store everything in one store, but logic handles separation
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'jan' });
      };
      r.onsuccess = e => { db = e.target.result; resolve(); };
      r.onerror = reject;
    });
  },

  setupEvents() {
    // Global App Object for HTML onclick
    window.app = this;

    dom.btnBack.onclick = () => {
      dom.appContainer.classList.add('hidden');
      dom.modeSelector.classList.remove('hidden');
      currentMode = null;
      document.body.className = '';
    };

    // Inputs
    [dom.name, dom.maker, dom.stock].forEach(el => {
      el.addEventListener('blur', () => this.autoSync());
    });

    // Buttons
    document.getElementById('btn-plus').onclick = () => { this.adjStock(1); this.autoSync(); };
    document.getElementById('btn-minus').onclick = () => { this.adjStock(-1); this.autoSync(); };

    dom.jan.addEventListener('change', () => this.onJanChange());
    dom.btnClear.onclick = () => this.clearForm();

    dom.btnScan.onclick = () => this.toggleScanner();
    dom.btnManual.onclick = () => this.syncAll(true);
  },

  // --- Mode Logic ---
  selectMode(mode) {
    currentMode = mode;
    dom.modeSelector.classList.add('hidden');
    dom.appContainer.classList.remove('hidden');

    // Apply Theme
    document.body.className = `theme-${mode}`;

    // Setup UI
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
    if (GAS_API_URL) this.syncAll(false); // Auto pull for this mode
  },

  // --- Data & Sync ---
  async autoSync() {
    if (currentMode === 'view' || !dom.jan.value) return;
    const jan = dom.jan.value;

    // Save Local
    const item = await this.dbGet(jan) || { jan, name: '', makerCode: '', shelf: 0, kyakuchu: 0, prefab: 0 };

    // Update only current mode's stock
    item.name = dom.name.value;
    item.makerCode = dom.maker.value;

    // Current stock value
    const val = parseInt(dom.stock.value) || 0;

    if (currentMode === 'shelf') item.shelf = val;
    if (currentMode === 'kyakuchu') item.kyakuchu = val;
    if (currentMode === 'prefab') item.prefab = val;

    item.updatedAt = new Date().toISOString();
    await this.dbPut(item);

    this.renderList();

    // Push to GAS
    this.showStatus('syncing', '送信中...');

    // Construct payload for specific sheet
    // We send {jan, name, maker, stock: <val>, updatedAt}
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
        this.showStatus('success', '保存完了');
        setTimeout(() => this.showStatus('hidden'), 2000);
      } else if (json.status === 'conflict') {
        if (confirm('他人が更新しました。統合しますか？')) {
          // Merge Logic: Server Stock + My Delta
          // Delta = Current - LastSynced?
          // Simplified V3: Accept logic -> Server wins + My input? 
          // Smart Merge V3:
          const sItem = json.serverItems[0];
          const serverStock = sItem.stock || 0;
          // Just take server stock for now to be safe, or confirm overwrite
          // "My Delta" logic requires storing _synced base.
          // Let's adopt a "Server Wins, but I re-apply" approach manually or 
          // For now, accept Server.
          dom.stock.value = serverStock;
          this.autoSync(); // Re-save? No, just save local.
        }
      }
    } catch (e) {
      this.showStatus('error', '未送信');
    }
  },

  async syncAll(manual = false) {
    if (!GAS_API_URL) return;
    this.showStatus('syncing', 'データ取得中...');

    // If View Mode: target='all', else target=currentMode
    const target = currentMode === 'view' ? 'all' : currentMode;

    try {
      // GET
      const url = `${GAS_API_URL}?target=${target}`;
      const res = await fetch(url);
      const data = await res.json();

      // Merge into DB
      if (target === 'all') {
        // Data has {shelf, kyakuchu, prefab}
        await this.dbClear();
        for (const i of data) await this.dbPut(i);
      } else {
        // Data has {stock} for specific mode
        // We only update that field in local DB
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
      this.showStatus('success', '完了');
      setTimeout(() => this.showStatus('hidden'), 2000);

    } catch (e) {
      this.showStatus('error', '通信エラー');
    }
  },

  // --- Helpers ---
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
        this.toast('登録済み商品');
      } else {
        dom.name.value = ''; dom.maker.value = ''; dom.stock.value = 0;
      }
    }
  },

  adjStock(d) {
    let v = parseInt(dom.stock.value) || 0;
    v += d; if (v < 0) v = 0; dom.stock.value = v;
  },

  async loadList() {
    allItems = await this.dbGetAll();
    this.renderList();
  },

  renderList() {
    const q = document.getElementById('inp-search').value.toLowerCase();
    const list = allItems.filter(i => i.jan.includes(q) || i.name.toLowerCase().includes(q));

    dom.list.innerHTML = '';

    list.forEach(i => {
      const total = (i.shelf || 0) + (i.kyakuchu || 0) + (i.prefab || 0);
      let html = `<div class="item-card">
        <div class="item-header"><span>${i.name}</span> <span class="item-total">計 ${total}</span></div>
        <div class="item-meta">JAN: ${i.jan}</div>`;

      if (currentMode === 'view') {
        html += `<div class="item-breakdown">
          <span class="badge" style="color:var(--color-shelf)">棚: ${i.shelf || 0}</span>
          <span class="badge" style="color:var(--color-kyakuchu)">客: ${i.kyakuchu || 0}</span>
          <span class="badge" style="color:var(--color-prefab)">プ: ${i.prefab || 0}</span>
        </div>`;
      } else {
        // Show only current mode stock? Or all?
        // User said "Independent". But maybe useful to see.
        // Let's show current mode large.
        let val = 0;
        if (currentMode === 'shelf') val = i.shelf;
        if (currentMode === 'kyakuchu') val = i.kyakuchu;
        if (currentMode === 'prefab') val = i.prefab;
        html += `<div style="font-weight:bold; margin-top:0.5rem; color:var(--text-main)">現在庫: ${val || 0}</div>`;
      }

      html += `</div>`;
      dom.list.innerHTML += html;
    });
  },

  showStatus(type, msg) {
    dom.status.className = `status-bar ${type}`;
    if (type === 'hidden') dom.status.classList.add('hidden');
    dom.statusText.textContent = msg;
  },

  toast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.add('show');
    setTimeout(() => dom.toast.classList.remove('show'), 3000);
  },

  clearForm() {
    dom.jan.value = ''; dom.name.value = ''; dom.maker.value = ''; dom.stock.value = 0;
  },

  // DB
  dbPut(i) { return new Promise(r => { const t = db.transaction('items', 'readwrite'); t.objectStore('items').put(i); t.oncomplete = r; }); },
  dbGet(k) { return new Promise(r => { const t = db.transaction('items', 'readonly'); const q = t.objectStore('items').get(k); q.onsuccess = () => r(q.result); }); },
  dbGetAll() { return new Promise(r => { const t = db.transaction('items', 'readonly'); const q = t.objectStore('items').getAll(); q.onsuccess = () => r(q.result); }); },
  dbClear() { return new Promise(r => { const t = db.transaction('items', 'readwrite'); const q = t.objectStore('items').clear(); q.onsuccess = () => r(); }); },

  // Scanner
  toggleScanner() {
    if (isScanning) { Quagga.stop(); isScanning = false; dom.scannerWrapper.classList.add('hidden'); }
    else {
      dom.scannerWrapper.classList.remove('hidden');
      Quagga.init({ inputStream: { name: "Live", type: "LiveStream", target: document.querySelector('#scanner-container'), constraints: { width: 640, height: 480, facingMode: "environment" } }, decoder: { readers: ["ean_reader"] } }, err => {
        if (!err) { Quagga.start(); isScanning = true; }
      });
      Quagga.onDetected(res => {
        if (res.codeResult.code.length === 13) {
          dom.jan.value = res.codeResult.code;
          this.onJanChange();
          this.toggleScanner(); // stop
        }
      });
    }
  },

  setupSW() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').then(r => {
      r.addEventListener('updatefound', () => {
        const n = r.installing; n.addEventListener('statechange', () => { if (n.state === 'installed' && navigator.serviceWorker.controller) n.postMessage({ type: 'SKIP_WAITING' }); });
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  }
};

app.init();
