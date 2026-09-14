/* --------------------------------------------------------------------
   Service Worker

   Zwei Aufgaben:
   1. Die App offline-faehig machen, damit sie installierbar ist.
   2. Push-Nachrichten annehmen, auch wenn lumo geschlossen ist.
-------------------------------------------------------------------- */
/* Diese Nummer bei jeder Aenderung an index.html hochzaehlen. Nur wenn
   sich sw.js selbst aendert, installiert der Browser ihn neu - und nur
   dann wird die alte Seite aus dem Zwischenspeicher geworfen. Sonst
   startet eine installierte App weiter mit der alten Fassung. */
const CACHE = "lumo-v17";
const SHELL = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.startsWith("/socket.io") || url.pathname.startsWith("/api")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

/* Zahl am App-Symbol setzen. Gezaehlt wird, wie viele Benachrichtigungen
   gerade offen sind - das kommt dem Ungelesen-Stand sehr nahe. */
async function refreshBadge() {
  if (!self.navigator.setAppBadge) return;
  try {
    const open = await self.registration.getNotifications();
    const n = open.length;
    if (n > 0) await self.navigator.setAppBadge(n);
    else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
  } catch {}
}

/* Die App meldet sich, sobald sie gelesen wurde. */
self.addEventListener("message", (e) => {
  if (e.data?.type === "clear-badge") {
    if (self.navigator.clearAppBadge) self.navigator.clearAppBadge().catch(() => {});
    self.registration.getNotifications().then((list) => list.forEach((n) => n.close()));
  }
});

/* Nachricht vom Server, auch bei geschlossener App. */
self.addEventListener("push", (e) => {
  let payload = { title: "lumo", body: "Neue Nachricht" };
  try {
    if (e.data) payload = { ...payload, ...e.data.json() };
  } catch {
    if (e.data) payload.body = e.data.text();
  }
  e.waitUntil(
    self.registration
      .showNotification(payload.title, {
        body: payload.body,
        icon: "/icons/icon-192-v2.png",
        badge: "/icons/icon-192-v2.png",
        tag: "lumo-" + (payload.id || Date.now()),
        vibrate: [120, 60, 120],
        data: { url: "/" },
      })
      .then(refreshBadge)
  );
});

/* Tippt jemand auf die Benachrichtigung, kommt lumo nach vorne. */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  if (self.navigator.clearAppBadge) self.navigator.clearAppBadge().catch(() => {});
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
