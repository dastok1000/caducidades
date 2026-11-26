/* Caducidades - service worker: precachea todo para funcionar sin conexión
 * y muestra avisos locales (sin servidor push). Solo atiende peticiones del propio origen.
 * El bloque entre las marcas lo genera `node tools/build-sw.mjs`: BUILD es un hash del contenido de todos
 * los archivos precacheados, así que cualquier cambio en ellos crea una caché nueva sin tocar nada a mano. */
'use strict';
// <generado por tools/build-sw.mjs: no editar a mano>
var BUILD = '32f3a039ec6c7a37';
var PRECACHE = [
  './',
  'app.js',
  'db.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'index.html',
  'logic.js',
  'manifest.webmanifest',
  'styles.css'
];
// </generado>
var CACHE = 'caducidades-' + BUILD;

importScripts('logic.js', 'db.js');

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) {
    // cache: 'reload' evita copiar a la caché nueva algo viejo de la caché HTTP del navegador.
    return c.addAll(PRECACHE.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () {
    // La 0.1.0 no sabía mostrar el aviso «Actualizar»: si viene de ella, se activa sola.
    return caches.keys().then(function (keys) {
      if (keys.indexOf('caducidades-0.1.0') >= 0) return self.skipWaiting();
    });
  }));
});

// La versión nueva espera hasta que el usuario pulsa «Actualizar» (mensaje desde la página).
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('caducidades-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // nunca se cachea ni se pide nada de fuera
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html', { cacheName: CACHE }).then(function (r) {
      return r || fetch(req);
    }));
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true, cacheName: CACHE }).then(function (r) {
    return r || fetch(req);
  }));
});

function checkAndNotify() {
  var L = self.CadLogic;
  var today = L.todayYMD();
  return self.CadDB.open().then(function (db) {
    return Promise.all([db.listActive(), db.getMeta('lastNotified')]).then(function (r) {
      var body = L.alertMessage(L.summarizeAlerts(r[0], today));
      if (!body || r[1] === today) { db.close(); return; }
      return self.registration.showNotification('Caducidades', {
        body: body, tag: 'caducidades-resumen', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'es'
      }).then(function () { return db.setMeta('lastNotified', today); }).then(function () { db.close(); });
    });
  }).catch(function () {});
}

// Solo existe en algunos navegadores (Chrome/Edge en Android con la app instalada); no está garantizado.
self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'revisar-caducidades') event.waitUntil(checkAndNotify());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow ? self.clients.openWindow('./') : undefined;
  }));
});
