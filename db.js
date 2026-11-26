/* Caducidades - almacenamiento local en IndexedDB (solo en este dispositivo).
 * Script clásico: página, service worker y Node (con fake-indexeddb).
 * Expone globalThis.CadDB.open({ indexedDB, name }). Requiere CadLogic. */
(function (root) {
  'use strict';
  var DB_NAME = 'caducidades';
  var DB_VERSION = 1;
  var ITEMS = 'items';
  var META = 'meta';

  function L() { return root.CadLogic; }

  function reqP(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onabort = function () { reject(tx.error || new Error('Transacción cancelada')); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function newId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function nowISO(now) { return (now instanceof Date ? now : new Date()).toISOString(); }

  function open(opts) {
    opts = opts || {};
    var idb = opts.indexedDB || root.indexedDB;
    if (!idb) return Promise.reject(new Error('Este navegador no tiene IndexedDB.'));
    var name = opts.name || DB_NAME;
    return new Promise(function (resolve, reject) {
      var req = idb.open(name, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(ITEMS)) {
          var s = db.createObjectStore(ITEMS, { keyPath: 'id' });
          s.createIndex('state', 'state', { unique: false });
          s.createIndex('barcode', 'barcode', { unique: false });
        }
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(wrap(req.result)); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('La base de datos está bloqueada por otra pestaña.')); };
    });
  }

  function wrap(db) {
    db.onversionchange = function () { db.close(); };

    function store(mode) {
      var tx = db.transaction([ITEMS], mode);
      return { tx: tx, s: tx.objectStore(ITEMS) };
    }

    function get(id) { return reqP(store('readonly').s.get(id)).then(function (v) { return v || null; }); }

    function put(item) {
      var t = store('readwrite');
      t.s.put(item);
      return txDone(t.tx).then(function () { return item; });
    }

    function byState(state) {
      return reqP(store('readonly').s.index('state').getAll(state));
    }

    function validated(input) {
      var r = L().validateItem(input);
      if (!r.ok) { var e = new Error('Datos no válidos'); e.name = 'ValidationError'; e.errors = r.errors; throw e; }
      return r.value;
    }

    function photoOf(input) {
      var p = input && input.photo;
      if (!p) return null;
      if (typeof Blob !== 'undefined' && p instanceof Blob) return p;
      throw new TypeError('La foto debe ser un Blob.');
    }

    return {
      raw: db,
      close: function () { db.close(); },

      add: function (input, now) {
        return Promise.resolve().then(function () {
          var v = validated(input);
          var item = {
            id: newId(), name: v.name, expiry: v.expiry, quantity: v.quantity, category: v.category,
            barcode: v.barcode, photo: photoOf(input), state: L().STATES.ACTIVE,
            createdAt: nowISO(now), updatedAt: nowISO(now), doneAt: null, schema: 1
          };
          return put(item);
        });
      },

      update: function (id, input, now) {
        return get(id).then(function (old) {
          if (!old) throw new Error('No existe el producto.');
          var v = validated(input);
          var item = Object.assign({}, old, v, { updatedAt: nowISO(now) });
          if (input.removePhoto) item.photo = null;
          else if (input.photo) item.photo = photoOf(input);
          return put(item);
        });
      },

      get: get,

      listActive: function () { return byState(L().STATES.ACTIVE).then(L().sortItems); },

      /** Consumidos y tirados, lo más reciente primero. 'offset' permite paginar. */
      listHistory: function (limit, offset) {
        var S = L().STATES;
        return Promise.all([byState(S.CONSUMED), byState(S.DISCARDED)]).then(function (r) {
          var all = r[0].concat(r[1]).sort(function (a, b) { return a.doneAt < b.doneAt ? 1 : a.doneAt > b.doneAt ? -1 : 0; });
          var from = offset || 0;
          return typeof limit === 'number' ? all.slice(from, from + limit) : all.slice(from);
        });
      },

      /** Recuento de todo el historial (no solo de lo que se ve). */
      historyCounts: function () {
        var S = L().STATES;
        var idx = store('readonly').s.index('state');
        return Promise.all([reqP(idx.count(S.CONSUMED)), reqP(idx.count(S.DISCARDED))]).then(function (r) {
          return { consumido: r[0], tirado: r[1], total: r[0] + r[1] };
        });
      },

      /** Marca como 'consumido' o 'tirado'. Devuelve el producto actualizado. */
      mark: function (id, state, now) {
        var S = L().STATES;
        if (state !== S.CONSUMED && state !== S.DISCARDED) return Promise.reject(new Error('Estado no válido: ' + state));
        return get(id).then(function (old) {
          if (!old) throw new Error('No existe el producto.');
          if (old.state !== S.ACTIVE) throw new Error('El producto ya no está en la lista.');
          return put(Object.assign({}, old, { state: state, doneAt: nowISO(now), updatedAt: nowISO(now) }));
        });
      },

      /** Deshace consumido/tirado: el producto vuelve a la lista. */
      undo: function (id, now) {
        var S = L().STATES;
        return get(id).then(function (old) {
          if (!old) throw new Error('No existe el producto.');
          if (old.state === S.ACTIVE) return old;
          return put(Object.assign({}, old, { state: S.ACTIVE, doneAt: null, updatedAt: nowISO(now) }));
        });
      },

      remove: function (id) {
        var t = store('readwrite');
        t.s.delete(id);
        return txDone(t.tx);
      },

      /** Último producto guardado con ese código de barras (para rellenar nombre y categoría). */
      findByBarcode: function (code) {
        if (!code) return Promise.resolve(null);
        return reqP(store('readonly').s.index('barcode').getAll(code)).then(function (list) {
          list.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
          return list[0] || null;
        });
      },

      getMeta: function (key) {
        var tx = db.transaction([META], 'readonly');
        return reqP(tx.objectStore(META).get(key)).then(function (r) { return r ? r.value : undefined; });
      },

      setMeta: function (key, value) {
        var tx = db.transaction([META], 'readwrite');
        tx.objectStore(META).put({ key: key, value: value });
        return txDone(tx);
      },

      /** Todos los productos (lista e historial), para exportar. */
      exportAll: function () { return reqP(store('readonly').s.getAll()); },

      /** Qué pasaría al importar, sin cambiar nada (para preguntar antes). */
      previewImport: function (items) {
        return reqP(store('readonly').s.getAll()).then(function (existing) {
          var c = L().planImport(existing, items, 'combinar'), r = L().planImport(existing, items, 'sustituir');
          return {
            existing: existing.length,
            combinar: { added: c.added, updated: c.updated, kept: c.kept, removed: 0 },
            sustituir: { added: r.added, updated: r.updated, kept: 0, removed: r.removed }
          };
        });
      },

      /** Importa una copia ya validada (CadLogic.parseBackup) en UNA sola transacción: o entra todo o no cambia nada.
       *  La lectura de lo que hay, el cálculo de repetidos y la escritura van en la misma transacción. */
      importBackup: function (items, mode) {
        var S = L().STATES;
        var records;
        try {
          if (mode !== 'combinar' && mode !== 'sustituir') throw new Error('Modo de importación no válido: ' + mode);
          records = items.map(function (it) {
            var r = {};
            Object.keys(it).forEach(function (k) { r[k] = it[k]; });
            r.photo = it.photo ? new Blob([it.photo.bytes], { type: it.photo.type }) : null;
            if (r.state === S.ACTIVE) r.doneAt = null;
            return r;
          });
        } catch (e) { return Promise.reject(e); }
        return new Promise(function (resolve, reject) {
          var tx = db.transaction([ITEMS], 'readwrite');
          var s = tx.objectStore(ITEMS);
          var plan = null, failure = null;
          tx.oncomplete = function () {
            resolve({ mode: mode, added: plan.added, updated: plan.updated, kept: plan.kept, removed: plan.removed, total: plan.total });
          };
          tx.onabort = function () { reject(failure || tx.error || new Error('La importación se ha cancelado.')); };
          tx.onerror = function (ev) { failure = failure || tx.error || (ev && ev.target && ev.target.error); };
          var g = s.getAll();
          g.onsuccess = function () {
            try {
              plan = L().planImport(g.result, records, mode);
              if (mode === 'sustituir') s.clear();
              plan.put.forEach(function (r) { s.put(r); });
            } catch (e) {
              failure = e;
              try { tx.abort(); } catch (x) {}
            }
          };
        });
      },

      count: function () { return reqP(store('readonly').s.count()); }
    };
  }

  root.CadDB = { open: open, DB_NAME: DB_NAME, DB_VERSION: DB_VERSION };
})(typeof self !== 'undefined' ? self : globalThis);
