const CACHE_NAME = 'stock-app-v3.6.2';
const ASSETS = [
    './',
    './index.html?v=3.6.2',
    './style.css?v=3.6.2',
    './app.js?v=3.6.2',
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

// Network First Strategy
self.addEventListener('fetch', (event) => {
    event.respondWith(
        fetch(event.request)
            .then(networkRes => {
                return caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, networkRes.clone());
                    return networkRes;
                });
            })
            .catch(() => caches.match(event.request))
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
