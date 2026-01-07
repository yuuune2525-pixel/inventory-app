const CACHE_NAME = 'stock-app-v4'; // Bumped version
const ASSETS = [
    './',
    './index.html',
    './style.css?v=2.1', // Match the query string in index.html
    './app.js?v=2.1',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/@ericblade/quagga2/dist/quagga.min.js'
];

self.addEventListener('install', (event) => {
    // Force immediate activation
    self.skipWaiting();

    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('activate', (event) => {
    // Claim clients immediately so they use the new SW logic without reload
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cache) => {
                        if (cache !== CACHE_NAME) {
                            return caches.delete(cache);
                        }
                    })
                );
            })
        ])
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            // Network first for HTML to check updates? 
            // Or Cache first. PWA usually Cache first.
            // With skipWaiting, the new HTML will be fetched on next visit/swap.
            // But query params ?v=... help bust the cache for assets.
            return response || fetch(event.request);
        })
    );
});

// Listen for skip waiting message (redundant with self.skipWaiting() in install, but good practice)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
