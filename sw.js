const CACHE_NAME = 'whiteclaw-v7';
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

// ===== PUSH — receive server-sent push notifications =====
self.addEventListener('push', e => {
  let data = { title: '🐕 Whiteclaw', body: 'Time to check on your tasks!' };
  try {
    if (e.data) {
      const parsed = e.data.json();
      data = { ...data, ...parsed };
    }
  } catch (err) {
    // If not JSON, use text
    if (e.data) data.body = e.data.text();
  }

  const options = {
    body: data.body,
    tag: data.tag || 'whiteclaw-push',
    icon: './icon192.png',
    badge: './icon192.png',
    requireInteraction: true,
    renotify: true,
    data: { taskId: data.taskId || null },
    actions: data.taskId ? [{ action: 'complete', title: 'Mark Done' }] : []
  };

  e.waitUntil(self.registration.showNotification(data.title, options));
});

// Handle notification click — open/focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action;
  const taskId = e.notification.data?.taskId;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If action is 'complete', send message to client to mark task done
      if (action === 'complete' && taskId) {
        for (const client of list) {
          client.postMessage({ type: 'COMPLETE_TASK', taskId });
        }
        // Also notify the Worker server that task was completed
        // (fire and forget — client will sync when it opens)
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
