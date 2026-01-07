const CACHE_NAME = 'stock-app-v3.5';
const ASSETS = [
    './',
    './index.html',
    './style.css?v=3.5',
    './app.js?v=3.5',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/@ericblade/quagga2/dist/quagga.min.js'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys => Promise.all(keys.map(k => {
                if (k !== CACHE_NAME) return caches.delete(k);
            })))
        ])
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(caches.match(event.request).then(r => r || fetch(event.request)));
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
