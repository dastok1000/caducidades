/* Caducidades 0.1.3e - avisos con la app cerrada (Web Push). Script clásico: página, service worker y Node.
 * Expone globalThis.CadPush. Requiere CadLogic y self.CAD_CONFIG (config.js).
 * PRIVACIDAD: al servidor solo se le manda la suscripción push del navegador (endpoint y sus claves públicas)
 * y «alertFrom»: el primer día en que habrá algo caducado o que caduca en 3 días o menos (o null).
 * Nunca nombres, fotos, códigos de barras, categorías, cantidades ni cuántos productos hay.
 * El estado local (meta 'push' en IndexedDB) guarda la suscripción y lo último enviado; no sale del móvil.
 * 0.1.3c (N1): si el servidor no acepta un cambio (429, 5xx, sin conexión) queda «pendiente» con una hora de
 * reintento (retryAt) que respeta Retry-After y crece (5 s, 10 s, 20 s... hasta 5 min); se guarda en el móvil,
 * así que también se respeta al cerrar y volver a abrir la app. Hasta que se consigue, y siempre con la fecha
 * más reciente (alertFrom se calcula al enviar, nunca se envía una fecha vieja).
 * 0.1.3d (N5): un cambio queda marcado como pendiente en IndexedDB en cuanto se hace (note), sin esperar a la
 * agrupación de 4 s; al ocultar o cerrar la app (visibilitychange → hidden y pagehide) se manda lo pendiente con
 * fetch keepalive (flush), que el navegador termina aunque se cierre la página, y se pide Background Sync donde
 * existe; si nada de eso llega, se manda al volver a abrir la app (porque está pendiente en IndexedDB).
 * 0.1.3d (N2): la fecha que se manda se acota: si ya pasó, se manda la de hoy (para el servidor es lo mismo: avisar
 * ya) y si está a más de 10 años, null. Para saber si ha cambiado se compara la fecha sin acotar (sentRaw), así
 * una fecha pasada no provoca un envío cada día. */
(function (root) {
  'use strict';
  var META_KEY = 'push';
  var SYNC_TAG = 'cad-push-sync';
  var HEARTBEAT_DAYS = 7; // aunque no cambie nada, se da señales cada semana (el servidor borra lo que lleva 21 días sin noticias y sin avisos pendientes)

  function L() { return root.CadLogic; }

  /** Dirección del servidor de config.js, sin «/» final. Vacía si no hay o no es válida (solo HTTPS, o 127.0.0.1/localhost para pruebas). */
  function serverUrl() {
    var c = root.CAD_CONFIG || {};
    var u = String(c.pushServerUrl || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(u)) return u;
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(u)) return u;
    return '';
  }
  function configured() { return !!serverUrl(); }

  function b64uToBytes(s) {
    var b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = atob(b), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64u(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  var BACKOFF_FIRST_MS = 5000, BACKOFF_MAX_MS = 5 * 60 * 1000, RETRY_AFTER_MAX_S = 3600;
  /** Espera antes del siguiente intento: crece con los fallos seguidos (5 s, 10 s, 20 s... máx. 5 min) y nunca
   *  baja de lo que pida el servidor con Retry-After (hasta 1 h). Un poco de azar (hasta +20 %) para no coincidir. */
  function backoffMs(fails, retryAfterS) {
    var base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * Math.pow(2, Math.max(0, fails - 1)));
    var ra = retryAfterS > 0 ? Math.min(RETRY_AFTER_MAX_S, retryAfterS) * 1000 : 0;
    return Math.round(Math.max(base, ra) * (1 + 0.2 * Math.random()));
  }
  function parseRetryAfter(res) {
    var v = res && res.headers && res.headers.get ? Number(res.headers.get('Retry-After')) : NaN;
    return v > 0 && isFinite(v) ? v : 0;
  }

  function request(method, path, body) {
    var init = { method: method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return root.fetch(serverUrl() + path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, body: j, retryAfter: parseRetryAfter(res) }; });
    });
  }
  function netError(e) { var x = new Error('Sin conexión con el servidor de avisos.'); x.name = 'NetworkError'; x.cause = e; return x; }

  /** Solo lo imprescindible de la suscripción. */
  function subJSON(sub) {
    var j = sub.toJSON ? sub.toJSON() : sub;
    return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
  }
  function keyOf(sub) {
    try { return sub && sub.options && sub.options.applicationServerKey ? bytesToB64u(sub.options.applicationServerKey) : null; } catch (e) { return null; }
  }

  // Copia en memoria del último estado leído o guardado: flush() la necesita sin esperar a IndexedDB.
  var cache = null;
  function getState(db) { return db.getMeta(META_KEY).then(function (s) { cache = s || null; return s || null; }); }
  function setState(db, s) { cache = s; return db.setMeta(META_KEY, s).then(function () { return s; }); }
  function alertFrom(db) { return db.listActive().then(function (items) { return L().alertFromDate(items); }); }
  function today() { return L().todayYMD(); }
  var WIRE_FUTURE_DAYS = 3650;
  /** 0.1.3d (N2): lo que se manda al servidor. Pasada → hoy; a más de 10 años → null; si no, igual. */
  function wire(af, t) {
    t = t || today();
    if (!af) return null;
    if (af < t) return t;
    if (af > L().addDays(t, WIRE_FUTURE_DAYS)) return null;
    return af;
  }
  /** Lo último enviado sin acotar (los estados de la 0.1.3c solo tienen «sent», que entonces era sin acotar). */
  /** Estado tras un envío correcto de «af». Si mientras tanto se apuntó otro cambio (want distinto), sigue pendiente. */
  function sentOk(cur, w, af, t) {
    var s = Object.assign({}, cur, { sent: w, sentRaw: af, day: t, pending: false, fails: 0, retryAt: null });
    if (Object.prototype.hasOwnProperty.call(cur, 'want')) { if (cur.want !== af) s.pending = true; else delete s.want; }
    return s;
  }
  function lastRaw(st) { return st && Object.prototype.hasOwnProperty.call(st, 'sentRaw') ? st.sentRaw : st ? st.sent : undefined; }

  function askBackgroundSync(reg) {
    try { if (reg && reg.sync && reg.sync.register) return reg.sync.register(SYNC_TAG).catch(function () {}); } catch (e) {}
    return Promise.resolve();
  }

  function sendSubscription(db, reg, sub, key, replaces) {
    return alertFrom(db).then(function (af) {
      var body = { subscription: subJSON(sub), alertFrom: wire(af) };
      if (replaces) body.replaces = replaces;
      return request('POST', '/api/subscribe', body).catch(function (e) { throw netError(e); }).then(function (r) {
        if (r.status !== 200 && r.status !== 201) {
          var why = r.body && typeof r.body.error === 'string' ? ': ' + r.body.error.slice(0, 120) : '';
          var e = new Error('El servidor de avisos no ha aceptado la suscripción (' + r.status + why + '). Inténtalo más tarde.'); e.name = 'ServerError'; e.status = r.status; e.retryAfter = r.retryAfter; throw e;
        }
        var j = subJSON(sub);
        return setState(db, { on: true, server: serverUrl(), key: key, endpoint: j.endpoint, auth: j.keys.auth, sent: body.alertFrom, sentRaw: af, day: today(), pending: false, fails: 0, retryAt: null });
      });
    });
  }

  /** Activar (tras el gesto del usuario y con el permiso ya concedido): suscribe y manda la suscripción. */
  function enable(db, reg) {
    if (!configured()) return Promise.reject(new Error('Esta versión no tiene servidor de avisos.'));
    if (!reg || !reg.pushManager) return Promise.reject(Object.assign(new Error('Este navegador no tiene avisos push.'), { name: 'NotSupportedError' }));
    var key;
    return request('GET', '/api/config').catch(function (e) { throw netError(e); }).then(function (r) {
      if (r.status !== 200 || !r.body || !r.body.vapidPublicKey) throw Object.assign(new Error('El servidor de avisos no responde bien (' + r.status + ').'), { name: 'ServerError' });
      key = r.body.vapidPublicKey;
      return reg.pushManager.getSubscription();
    }).then(function (old) {
      if (old && keyOf(old) && keyOf(old) !== key) return old.unsubscribe().then(function () { return null; });
      return old;
    }).then(function (old) {
      return old || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
    }).then(function (sub) {
      return getState(db).then(function (st) {
        var replaces = st && st.on && st.endpoint && st.endpoint !== subJSON(sub).endpoint ? { endpoint: st.endpoint, auth: st.auth } : null;
        return sendSubscription(db, reg, sub, key, replaces);
      });
    });
  }

  /** Desactivar: borra la suscripción en el servidor y en el navegador. Si no hay conexión, el borrado en el
   *  servidor queda pendiente y se reintenta (y aunque no llegara, el servicio push ya no la aceptará). */
  function disable(db, reg) {
    return Promise.all([getState(db), reg && reg.pushManager ? reg.pushManager.getSubscription().catch(function () { return null; }) : null]).then(function (r) {
      var st = r[0], sub = r[1];
      var proof = st && st.endpoint ? { endpoint: st.endpoint, auth: st.auth } : sub ? { endpoint: subJSON(sub).endpoint, auth: subJSON(sub).keys.auth } : null;
      var server = proof && configured() ? request('POST', '/api/unsubscribe', proof).then(function (x) { return x.status === 200; }, function () { return false; }) : Promise.resolve(true);
      return server.then(function (ok) {
        return (sub ? sub.unsubscribe().catch(function () { return false; }) : Promise.resolve(true)).then(function () {
          return setState(db, { on: false, pendingDelete: ok ? null : proof });
        }).then(function (s) { if (!ok) askBackgroundSync(reg); return { serverDeleted: ok, state: s }; });
      });
    });
  }

  /** Manda alertFrom si ha cambiado (o si toca dar señales). Si falla, queda pendiente y se reintenta
   *  al volver la conexión, al abrir la app, con Background Sync (si existe) o al recibir el próximo aviso. */
  function sync(db, reg, opts) {
    opts = opts || {};
    return getState(db).then(function (st) {
      if (!st) return { estado: 'apagado' };
      if (!st.on) {
        if (!st.pendingDelete || !configured()) return { estado: 'apagado' };
        if (!opts.force && !opts.ignoreRetry && st.retryAt && Date.now() < st.retryAt) return { estado: 'baja-pendiente', retryAt: st.retryAt };
        return request('POST', '/api/unsubscribe', st.pendingDelete).then(function (x) {
          if (x.status !== 200) throw Object.assign(new Error(String(x.status)), { status: x.status, retryAfter: x.retryAfter });
          return setState(db, { on: false, pendingDelete: null }).then(function () { return { estado: 'apagado' }; });
        }).catch(function (e) {
          var fails = (st.fails || 0) + 1, retryAt = Date.now() + backoffMs(fails, e && e.retryAfter);
          return setState(db, Object.assign({}, st, { fails: fails, retryAt: retryAt })).then(function () { askBackgroundSync(reg); return { estado: 'baja-pendiente', retryAt: retryAt }; });
        });
      }
      if (!configured()) return { estado: 'sin-servidor' };
      // 0.1.3c: si hay un cambio pendiente y el servidor pidió esperar, se espera (también tras reabrir la app).
      if (st.pending && !opts.force && !opts.ignoreRetry && st.retryAt && Date.now() < st.retryAt) return { estado: 'pendiente', retryAt: st.retryAt };
      return alertFrom(db).then(function (af) {
        var t = today();
        var fresh = !!st.day && L().daysUntil(t, st.day) < HEARTBEAT_DAYS;
        if (!opts.force && !st.pending && st.server === serverUrl() && lastRaw(st) === af && fresh) return { estado: 'al-dia', alertFrom: af };
        var w = wire(af, t);
        var p;
        if (st.server !== serverUrl()) {
          p = enable(db, reg).then(function () { return { status: 200, body: {} }; });
        } else {
          p = request('POST', '/api/update', { endpoint: st.endpoint, auth: st.auth, alertFrom: w }).then(function (r) {
            if (r.status !== 404) return r;
            // El servidor no la conoce (se borró o se perdió): se vuelve a mandar la suscripción que hay.
            return (reg && reg.pushManager ? reg.pushManager.getSubscription() : Promise.resolve(null)).then(function (sub) {
              if (!sub) { var e = new Error('perdida'); e.name = 'LostError'; throw e; }
              return sendSubscription(db, reg, sub, st.key, null).then(function () { return { status: 200, body: {} }; });
            });
          });
        }
        return p.then(function (r) {
          if (r.status !== 200) throw Object.assign(new Error(String(r.status)), { status: r.status, retryAfter: r.retryAfter });
          return getState(db).then(function (cur) {
            var s = sentOk(cur || st, w, af, t);
            return setState(db, s).then(function () { return { estado: 'enviado', alertFrom: af }; });
          });
        }).catch(function (e) {
          if (e && e.name === 'LostError') return setState(db, Object.assign({}, st, { on: false, lost: true })).then(function () { return { estado: 'perdida' }; });
          var fails = (st.fails || 0) + 1, retryAt = Date.now() + backoffMs(fails, e && e.retryAfter);
          return setState(db, Object.assign({}, st, { pending: true, fails: fails, retryAt: retryAt })).then(function () { askBackgroundSync(reg); return { estado: 'pendiente', retryAt: retryAt }; });
        });
      });
    });
  }

  /** 0.1.3d (N5): marca el cambio como pendiente en IndexedDB en cuanto se hace (antes de la espera de 4 s).
   *  No toca retryAt (si el servidor pidió esperar, se sigue esperando). Devuelve true si queda pendiente. */
  function note(db, items) {
    if (!configured() || !items) return Promise.resolve(false);
    var af = L().alertFromDate(items);
    return getState(db).then(function (st) {
      if (!st || !st.on) return false;
      if (st.pending && Object.prototype.hasOwnProperty.call(st, 'want') && st.want === af) return true;
      if (!st.pending && lastRaw(st) === af && st.server === serverUrl()) return false;
      // «want»: la fecha (sin acotar) que falta por mandar; si un envío en curso manda otra, sigue pendiente.
      return setState(db, Object.assign({}, st, { pending: true, want: af })).then(function () { return true; });
    }).catch(function () { return false; });
  }

  /** 0.1.3d (N5): al ocultar o cerrar la app. Empieza YA (sin esperar a nada) un fetch keepalive con lo pendiente,
   *  que el navegador termina aunque se cierre la página, y pide Background Sync. Usa la copia en memoria del
   *  estado; si no la hay, solo pide Background Sync (y queda pendiente para cuando se vuelva a abrir).
   *  Respeta retryAt: si el servidor pidió esperar, no manda nada. */
  function flush(db, reg, items) {
    askBackgroundSync(reg);
    var st = cache;
    if (!configured() || !st || !st.on || !st.endpoint || st.server !== serverUrl() || !items) return Promise.resolve({ estado: 'sin-envio' });
    var af = L().alertFromDate(items), t = today();
    if (!st.pending && lastRaw(st) === af) return Promise.resolve({ estado: 'al-dia' });
    if (st.retryAt && Date.now() < st.retryAt) return Promise.resolve({ estado: 'pendiente', retryAt: st.retryAt });
    var w = wire(af, t), p;
    try {
      p = root.fetch(serverUrl() + '/api/update', { method: 'POST', keepalive: true, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: st.endpoint, auth: st.auth, alertFrom: w }) });
    } catch (e) { return Promise.resolve({ estado: 'pendiente' }); }
    // Si la página sigue viva para ver la respuesta, se apunta; si no, queda pendiente en IndexedDB.
    return Promise.resolve(p).then(function (res) {
      return getState(db).then(function (cur) {
        if (!cur || !cur.on || cur.endpoint !== st.endpoint) return { estado: 'cambiado' };
        if (res.status === 200) return setState(db, sentOk(cur, w, af, t)).then(function () { return { estado: 'enviado', alertFrom: af }; });
        if (res.status === 404) return { estado: 'pendiente' }; // se vuelve a mandar la suscripción en el próximo sync
        var fails = (cur.fails || 0) + 1, retryAt = Date.now() + backoffMs(fails, parseRetryAfter(res));
        return setState(db, Object.assign({}, cur, { pending: true, fails: fails, retryAt: retryAt })).then(function () { return { estado: 'pendiente', retryAt: retryAt }; });
      });
    }, function () { return { estado: 'pendiente' }; });
  }

  /** pushsubscriptionchange (service worker): el navegador cambió la suscripción; se manda la nueva. */
  function renew(db, reg, newSub) {
    return getState(db).then(function (st) {
      if (!st || !st.on || !configured()) return null;
      var p = newSub ? Promise.resolve(newSub) : reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(st.key) });
      return p.then(function (sub) { return sendSubscription(db, reg, sub, st.key, st.endpoint ? { endpoint: st.endpoint, auth: st.auth } : null); });
    }).catch(function () { return null; });
  }

  root.CadPush = {
    META_KEY: META_KEY, SYNC_TAG: SYNC_TAG, HEARTBEAT_DAYS: HEARTBEAT_DAYS, backoffMs: backoffMs,
    serverUrl: serverUrl, configured: configured, b64uToBytes: b64uToBytes, bytesToB64u: bytesToB64u, subJSON: subJSON,
    getState: getState, enable: enable, disable: disable, sync: sync, renew: renew,
    note: note, flush: flush, wire: wire, WIRE_FUTURE_DAYS: WIRE_FUTURE_DAYS
  };
})(typeof self !== 'undefined' ? self : globalThis);
