const CACHE_NAME = 'whiteclaw-v6';
const ASSETS = ['./index.html', './manifest.json', './icon192.png', './icon512.png'];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// Handle notification click — open/focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If action is 'complete', send message to client to mark task done
      if (action === 'complete' && e.notification.data?.taskId) {
        for (const client of list) {
          client.postMessage({ type: 'COMPLETE_TASK', taskId: e.notification.data.taskId });
        }
      }
      if (list.length > 0) {
        return list[0].focus();
      }
      return clients.openWindow('./index.html');
    })
  );
});

// Handle messages from the page for scheduling notifications
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, data, actions } = e.data;
    self.registration.showNotification(title, {
      body, tag, data, actions,
      icon: './icon192.png',
      badge: './icon192.png',
      requireInteraction: true,
      renotify: true
    });
  }
});
