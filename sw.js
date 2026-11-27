/* Caducidades - service worker: precachea todo para funcionar sin conexión, muestra los avisos locales y,
 * desde la 0.1.3, los avisos push con la app cerrada (si hay servidor en config.js). Solo atiende (y cachea)
 * peticiones GET del propio origen; las llamadas al servidor de avisos no pasan por la caché.
 * El bloque entre las marcas lo genera `node tools/build-sw.mjs`: BUILD es un hash del contenido de todos
 * los archivos precacheados, así que cualquier cambio en ellos crea una caché nueva sin tocar nada a mano. */
'use strict';
// <generado por tools/build-sw.mjs: no editar a mano>
var BUILD = 'd814afb52fdd98dd';
var PRECACHE = [
  './',
  'app.js',
  'config.js',
  'db.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'index.html',
  'logic.js',
  'manifest.webmanifest',
  'push.js',
  'styles.css'
];
// </generado>
var CACHE = 'caducidades-' + BUILD;

importScripts('config.js');
importScripts('logic.js', 'db.js');
importScripts('push.js');

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

/* ---------- 0.1.3: avisos push con la app cerrada ----------
 * El servidor manda cada día a las 9:00 (Madrid) un mensaje cifrado y genérico, sin nombres. Aquí se
 * compone el texto con los datos del propio móvil. SIEMPRE se muestra un aviso (Safari en iPhone lo exige
 * y Chrome mostraría uno suyo): si no se pueden leer los datos, uno genérico. */
var GENERIC = 'Puede que tengas productos caducados o a punto de caducar. Ábrela para revisarlos.';

function readPushData(event) {
  try { var d = event.data ? event.data.json() : null; return d && typeof d === 'object' ? d : {}; } catch (e) { return {}; }
}

function onPush(event) {
  var L = self.CadLogic;
  var d = readPushData(event); // el contenido no lleva datos de productos: solo el tipo y el día
  var today = L.todayYMD();
  // 0.1.3b: al activar, el servidor comprueba la suscripción con un aviso de tipo «alta» (iOS exige enseñarlo).
  if (d.tipo === 'alta') {
    return self.registration.showNotification('Caducidades', {
      body: 'Avisos activados: cada día a las 9:00 te avisaré si hay algo caducado o a punto de caducar.',
      tag: 'caducidades-alta', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'es', silent: true, data: { origen: 'push' }
    });
  }
  function show(body, silent) {
    return self.registration.showNotification('Caducidades', {
      body: body, tag: 'caducidades-resumen', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'es',
      silent: !!silent, data: { origen: 'push' }
    });
  }
  return self.CadDB.open().then(function (db) {
    return Promise.all([db.listActive(), db.getMeta('lastNotified')]).then(function (r) {
      var body = L.alertMessage(L.summarizeAlerts(r[0], today));
      // Ya avisado hoy al abrir la app: se sustituye el aviso sin volver a sonar.
      return show(body || 'Hoy no hay nada caducado ni a punto de caducar.', r[1] === today)
        .then(function () { return body ? db.setMeta('lastNotified', today) : null; })
        .then(function () { return self.CadPush.sync(db, self.registration, { force: !body }); }) // corrige el servidor si iba atrasado
        .catch(function () {})
        .then(function () { db.close(); });
    }, function (e) { db.close(); throw e; });
  }).catch(function () { return show(GENERIC, false); });
}

self.addEventListener('push', function (event) { event.waitUntil(onPush(event)); });

self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(self.CadDB.open().then(function (db) {
    return self.CadPush.renew(db, self.registration, event.newSubscription || null).then(function () { db.close(); });
  }).catch(function () {}));
});

// Background Sync (solo navegadores Chromium): reintenta lo que no se pudo mandar sin conexión.
self.addEventListener('sync', function (event) {
  if (event.tag !== self.CadPush.SYNC_TAG) return;
  event.waitUntil(self.CadDB.open().then(function (db) {
    return self.CadPush.sync(db, self.registration).then(function (r) { db.close(); if (r.estado === 'pendiente' || r.estado === 'baja-pendiente') throw new Error('reintentar'); });
  }));
});

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
