// Service worker: notificações (locais e push vindas do teu Worker).
// Não guarda nada em cache, para que as atualizações da app apareçam logo.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// notificação push enviada pelo Worker (descida de preço, preço-alvo, produto novo…)
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { body: event.data && event.data.text() }; }
  const title = msg.title || 'Web Crawler';
  event.waitUntil(self.registration.showNotification(title, {
    body: msg.body || 'Há novidades nos teus produtos.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: msg.tag || undefined,
    renotify: !!msg.tag,
    data: { url: msg.url || './' },
  }));
});

// tocar na notificação abre o produto (ou a app)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameApp = new URL(url, self.registration.scope).href.startsWith(self.registration.scope);
    if (sameApp) {
      for (const c of list) if ('focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});
