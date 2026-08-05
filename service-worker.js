// ============================================================
// service-worker.js
// Two jobs:
// 1) Show a real system notification when a push arrives
//    (works even if the app is closed / phone is locked).
// 2) Basic offline caching so it feels like a native app.
// ============================================================

const CACHE_NAME = "pill-tracker-v3";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./pink-bottle-line.png",
  "./pink-bottle-silhouette.png",
  "./black-bottle-line.png",
  "./black-bottle-silhouette.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// --- THE IMPORTANT PART: incoming push -> visible notification ---
self.addEventListener("push", (event) => {
  let data = { title: "Pill Tracker", body: "Update" };
  try {
    data = event.data.json();
  } catch (e) {
    /* fall back to default above */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: "pill-tracker-update", // replaces older notifications instead of stacking
    })
  );
});

// tapping the notification focuses/opens the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow("./");
    })
  );
});
