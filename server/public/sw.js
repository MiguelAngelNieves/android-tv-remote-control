// Service worker mínimo: necesario para que Chrome permita instalar la PWA y el "Compartir → TV".
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* siempre red */ });
