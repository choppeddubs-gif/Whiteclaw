const CACHE_NAME = 'whiteclaw-v8';
const ASSETS = ['./index.html', './manifest.json', './icon192.png', './icon512.png'];
const PUSH_WORKER_URL = 'https://whiteclaw-push.choppeddubs.workers.dev';

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

// ===== IndexedDB helper for background completions =====
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteclaw-sw', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('completions')) {
        db.createObjectStore('completions', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeCompletion(taskId, timestamp) {
  try {
    const db = await openDB();
    const tx = db.transaction('completions', 'readwrite');
    tx.objectStore('completions').add({ taskId, timestamp, synced: false });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) {
    console.warn('SW: Failed to store completion in IndexedDB:', e);
  }
}

// ===== Notify Cloudflare Worker of task completion (background) =====
async function backgroundCompleteTask(taskId, subscription) {
  // 1. Store in IndexedDB so the app picks it up when opened
  await storeCompletion(taskId, Date.now());

  // 2. Notify the Cloudflare Worker server
  if (subscription?.endpoint) {
    try {
      await fetch(PUSH_WORKER_URL + '/complete-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint, taskId })
      });
    } catch (e) {
      console.warn('SW: Failed to notify worker of completion:', e);
    }
  }

  // 3. Cancel all notifications for this task
  const notifications = await self.registration.getNotifications();
  for (const n of notifications) {
    if (n.data?.taskId === taskId) {
      n.close();
    }
  }
}

// ===== Get push subscription for server calls =====
async function getSubscription() {
  try {
    return await self.registration.pushManager.getSubscription();
  } catch (e) {
    return null;
  }
}

// ===== PUSH — receive server-sent push notifications =====
self.addEventListener('push', e => {
  let data = { title: 'Whiteclaw', body: 'Time to check on your tasks!' };
  try {
    if (e.data) {
      const parsed = e.data.json();
      data = { ...data, ...parsed };
    }
  } catch (err) {
    if (e.data) data.body = e.data.text();
  }

  const actions = [];
  if (data.taskId) {
    actions.push({ action: 'complete', title: 'Complete Task' });
    actions.push({ action: 'snooze', title: 'Snooze 15m' });
  }

  const options = {
    body: data.body,
    tag: data.tag || 'whiteclaw-push',
    icon: './icon192.png',
    badge: './icon192.png',
    requireInteraction: true,
    renotify: true,
    data: { taskId: data.taskId || null, timestamp: Date.now() },
    actions
  };

  e.waitUntil(self.registration.showNotification(data.title, options));
});

// ===== Handle notification click — CRITICAL: works when app is closed =====
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action;
  const taskId = e.notification.data?.taskId;

  e.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    if (action === 'complete' && taskId) {
      // === COMPLETE TASK ===
      const sub = await getSubscription();

      if (windowClients.length > 0) {
        // App is open — tell it to complete the task
        for (const client of windowClients) {
          client.postMessage({ type: 'COMPLETE_TASK', taskId });
        }
        return windowClients[0].focus();
      } else {
        // App is CLOSED — handle completion entirely in the SW
        await backgroundCompleteTask(taskId, sub);
        // Show confirmation notification
        await self.registration.showNotification('Done!', {
          body: 'Task marked complete. Good dog parent!',
          tag: 'completion-confirm',
          icon: './icon192.png',
          badge: './icon192.png',
          requireInteraction: false
        });
        // Don't open the app — user just wanted to complete from notification
        return;
      }
    }

    if (action === 'snooze' && taskId) {
      // === SNOOZE 15 MINUTES ===
      // Schedule a new notification in 15 minutes via setTimeout
      // (SW will stay alive for the waitUntil promise)
      const snoozeMs = 15 * 60 * 1000;
      await new Promise(resolve => {
        setTimeout(async () => {
          await self.registration.showNotification(e.notification.title || 'Whiteclaw Reminder', {
            body: 'Snoozed reminder — time to do this now!',
            tag: `snooze-${taskId}-${Date.now()}`,
            icon: './icon192.png',
            badge: './icon192.png',
            requireInteraction: true,
            renotify: true,
            data: { taskId, timestamp: Date.now() },
            actions: [
              { action: 'complete', title: 'Complete Task' },
              { action: 'snooze', title: 'Snooze 15m' }
            ]
          });
          resolve();
        }, snoozeMs);
      });
      return;
    }

    // === DEFAULT TAP (no action button) — open/focus the app ===
    if (action === 'complete' && taskId && windowClients.length > 0) {
      // Already handled above
    }
    if (windowClients.length > 0) {
      return windowClients[0].focus();
    }
    return clients.openWindow('./index.html');
  })());
});

// Handle messages from the page for scheduling notifications
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, data, actions } = e.data;
    self.registration.showNotification(title, {
      body, tag,
      data: data || {},
      actions: actions || [],
      icon: './icon192.png',
      badge: './icon192.png',
      requireInteraction: true,
      renotify: true
    });
  }

  // App asking for any background completions
  if (e.data && e.data.type === 'GET_BG_COMPLETIONS') {
    (async () => {
      try {
        const db = await openDB();
        const tx = db.transaction('completions', 'readwrite');
        const store = tx.objectStore('completions');
        const all = await new Promise((res, rej) => {
          const req = store.getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = rej;
        });
        // Clear them after reading
        store.clear();
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        db.close();

        // Send back to the page
        if (e.source) {
          e.source.postMessage({ type: 'BG_COMPLETIONS', completions: all });
        }
      } catch (err) {
        console.warn('SW: Failed to read completions:', err);
      }
    })();
  }
});
