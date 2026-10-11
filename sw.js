// Internet uzilsa ham ilova ochilishi uchun: oxirgi muvaffaqiyatli yuklangan nusxani saqlaydi
const C = "dokon-v2";
const SKIP = ["supabase.co", "openfoodfacts.org", "openproductsfacts.org", "openbeautyfacts.org"];
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if(r.method !== "GET" || SKIP.some(h => u.hostname.endsWith(h))) return;
  e.respondWith(
    fetch(r).then(res => {
      if(res.ok || res.type === "opaque"){ const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); }
      return res;
    }).catch(() => caches.match(r).then(m => m || caches.match("./index.html") || caches.match("./")))
  );
});
