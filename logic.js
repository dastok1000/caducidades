/* Caducidades - lógica pura (fechas, estados, orden, validación).
 * Script clásico: funciona en la página, en el service worker (importScripts)
 * y en Node (import con efecto lateral). Expone globalThis.CadLogic.
 * Las fechas se guardan como texto 'YYYY-MM-DD' y se comparan por día local:
 * nunca se usa new Date('YYYY-MM-DD') (eso se interpreta en UTC). */
(function (root) {
  'use strict';

  var APP_VERSION = '0.1.2';
  var SOON_DAYS = 3; // fijo (no configurable): 0..3 días => "pronto"; 4 o más => "bien"
  var CATEGORIES = [
    'Lácteos', 'Carne y pescado', 'Fruta y verdura', 'Panadería',
    'Despensa', 'Congelados', 'Bebidas', 'Medicamentos', 'Higiene', 'Otros'
  ];
  var STATES = { ACTIVE: 'activo', CONSUMED: 'consumido', DISCARDED: 'tirado' };
  var YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function daysInMonth(y, m) { // m: 1..12 (calendario gregoriano)
    if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].indexOf(m) >= 0 ? 30 : 31;
  }

  /** Devuelve {y,m,d} o null si el texto no es una fecha real YYYY-MM-DD. */
  function parseYMD(s) {
    if (typeof s !== 'string') return null;
    var r = YMD_RE.exec(s);
    if (!r) return null;
    var y = +r[1], m = +r[2], d = +r[3];
    if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return { y: y, m: m, d: d };
  }

  function isValidYMD(s) { return parseYMD(s) !== null; }

  /** Fecha local de hoy (o de 'now') como 'YYYY-MM-DD', usando la zona del dispositivo. */
  function todayYMD(now) {
    var t = now instanceof Date ? now : new Date();
    return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
  }

  /** Número de día absoluto (aritmética de calendario pura, sin zona horaria). */
  function dayNumber(ymd) {
    var p = parseYMD(ymd);
    if (!p) throw new RangeError('Fecha no válida: ' + ymd);
    // Algoritmo de días civiles (Howard Hinnant); entero exacto, no depende de TZ ni de cambios de hora.
    var y = p.y - (p.m <= 2 ? 1 : 0);
    var era = Math.floor(y / 400);
    var yoe = y - era * 400;
    var mp = (p.m + 9) % 12;
    var doy = Math.floor((153 * mp + 2) / 5) + p.d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  /** Días desde 'today' hasta 'expiry' (negativo = ya caducado). */
  function daysUntil(expiry, today) {
    return dayNumber(expiry) - dayNumber(today || todayYMD());
  }

  /** Suma n días a una fecha YYYY-MM-DD (sin Date). */
  function addDays(ymd, n) {
    var z = dayNumber(ymd) + n + 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp < 10 ? mp + 3 : mp - 9;
    if (m <= 2) y += 1;
    return y + '-' + pad2(m) + '-' + pad2(d);
  }

  /** 'caducado' | 'pronto' | 'bien' según los días que faltan. */
  function statusFromDays(days) {
    if (days < 0) return 'caducado';
    if (days <= SOON_DAYS) return 'pronto';
    return 'bien';
  }

  function statusOf(expiry, today) { return statusFromDays(daysUntil(expiry, today)); }

  /** Texto en español que acompaña al color (no depende solo del color). */
  function statusText(days) {
    if (days < -1) return 'Caducado hace ' + (-days) + ' días';
    if (days === -1) return 'Caducado ayer';
    if (days === 0) return 'Caduca hoy';
    if (days === 1) return 'Caduca mañana';
    if (days <= SOON_DAYS) return 'Caduca en ' + days + ' días';
    return 'Bien: quedan ' + days + ' días';
  }

  var STATUS_META = {
    caducado: { icon: '✖', label: 'Caducado' },
    pronto: { icon: '!', label: 'Caduca pronto' },
    bien: { icon: '✓', label: 'Bien' }
  };

  var MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  /** '2026-11-26' -> '26 nov 2026' (sin Date). */
  function formatYMD(ymd) {
    var p = parseYMD(ymd);
    if (!p) return '';
    return p.d + ' ' + MONTHS[p.m - 1].slice(0, 3) + ' ' + p.y;
  }

  function cmpStr(a, b) {
    a = a || ''; b = b || '';
    try { return a.localeCompare(b, 'es', { sensitivity: 'base' }); } catch (e) { return a < b ? -1 : a > b ? 1 : 0; }
  }

  /** Orden: caducidad más próxima primero; empate por nombre y luego por alta. No muta. */
  function sortItems(items) {
    return items.slice().sort(function (a, b) {
      var da = dayNumber(a.expiry), db = dayNumber(b.expiry);
      if (da !== db) return da - db;
      var n = cmpStr(a.name, b.name);
      if (n !== 0) return n;
      return cmpStr(a.createdAt, b.createdAt) || cmpStr(a.id, b.id);
    });
  }

  /** Para el aviso: listas de caducados y de "pronto" entre los activos. */
  function summarizeAlerts(items, today) {
    var t = today || todayYMD();
    var out = { expired: [], soon: [] };
    sortItems(items.filter(function (i) { return !i.state || i.state === STATES.ACTIVE; })).forEach(function (i) {
      var s = statusOf(i.expiry, t);
      if (s === 'caducado') out.expired.push(i);
      else if (s === 'pronto') out.soon.push(i);
    });
    return out;
  }

  function alertMessage(summary) {
    var parts = [];
    function names(list) {
      var n = list.slice(0, 4).map(function (i) { return i.name; }).join(', ');
      return list.length > 4 ? n + ' y ' + (list.length - 4) + ' más' : n;
    }
    if (summary.expired.length) parts.push((summary.expired.length === 1 ? '1 caducado: ' : summary.expired.length + ' caducados: ') + names(summary.expired));
    if (summary.soon.length) parts.push((summary.soon.length === 1 ? '1 caduca pronto: ' : summary.soon.length + ' caducan pronto: ') + names(summary.soon));
    return parts.join('. ');
  }

  var BARCODE_MAX = 32;
  var BARCODE_RE = /^[0-9A-Za-z\-.]+$/;

  /** Motivo (texto) por el que algo no vale como código de barras, o '' si vale. */
  function barcodeProblem(code) {
    if (/^[a-z][a-z0-9+.\-]*:|^www\./i.test(code) || /:\/\//.test(code)) return 'Eso parece una dirección web o un código QR, no un código de barras de producto.';
    if (/\s/.test(code)) return 'Eso parece un texto, no un código de barras de producto.';
    if (!BARCODE_RE.test(code)) return 'El código de barras solo puede tener números y letras.';
    if (code.length > BARCODE_MAX) return 'El código es demasiado largo (máximo ' + BARCODE_MAX + ' caracteres).';
    return '';
  }

  /** Comprueba lo leído por la cámara (sin quitar espacios). {ok, code} o {ok:false, reason}. */
  function checkScannedCode(raw) {
    var code = String(raw == null ? '' : raw).trim();
    if (!code) return { ok: false, reason: 'No se ha leído ningún código.' };
    var p = barcodeProblem(code);
    return p ? { ok: false, reason: p } : { ok: true, code: code };
  }

  /** '1 unidad', '2 unidades'. */
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /** Resumen de la lista activa, con plurales correctos. */
  function listSummary(items, today) {
    if (!items.length) return '';
    var s = summarizeAlerts(items, today);
    var units = items.reduce(function (a, i) { return a + (i.quantity || 0); }, 0);
    return plural(items.length, 'producto', 'productos') + ' (' + plural(units, 'unidad', 'unidades') + ') · ' +
      plural(s.expired.length, 'caducado', 'caducados') + ' · ' + s.soon.length + ' en ' + SOON_DAYS + ' días o menos';
  }

  function historySummary(counts) {
    if (!counts || !(counts.consumido + counts.tirado)) return '';
    return 'Consumidos: ' + counts.consumido + ' · Tirados: ' + counts.tirado;
  }

  /** Valida y normaliza la entrada del formulario. Devuelve {ok, value} o {ok:false, errors}. */
  function validateItem(input) {
    var errors = {};
    var name = String((input && input.name) || '').replace(/\s+/g, ' ').trim();
    if (!name) errors.name = 'Escribe el nombre del producto.';
    else if (name.length > 80) errors.name = 'El nombre es demasiado largo (máximo 80 letras).';
    var expiry = String((input && input.expiry) || '').trim();
    if (!isValidYMD(expiry)) errors.expiry = 'Elige una fecha de caducidad válida.';
    var qRaw = input && input.quantity;
    // Sin el campo (llamada desde código) vale 1; vacío o no numérico desde el formulario es un error visible.
    var quantity = (qRaw === undefined || qRaw === null) ? 1 : (typeof qRaw === 'string' ? qRaw.trim() : qRaw);
    if (quantity === '') errors.quantity = 'Escribe la cantidad (un número entero entre 1 y 999).';
    else {
      quantity = Number(quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) errors.quantity = 'La cantidad debe ser un número entero entre 1 y 999.';
    }
    var category = String((input && input.category) || 'Otros');
    if (CATEGORIES.indexOf(category) < 0) errors.category = 'Elige una categoría de la lista.';
    var barcode = String((input && input.barcode) || '').replace(/\s+/g, '');
    if (barcode) { var be = barcodeProblem(barcode); if (be) errors.barcode = be; }
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    return { ok: true, value: { name: name, expiry: expiry, quantity: quantity, category: category, barcode: barcode } };
  }


  /* ---------- Copia de seguridad (exportar / importar) ----------
   * Formato JSON, versión 1:
   * { format: 'caducidades-copia', formatVersion: 1, app: 'Caducidades', appVersion: '0.1.2',
   *   exportedAt: ISO, counts: { items, photos }, items: [ { id, name, expiry, quantity, category, barcode,
   *   state, createdAt, updatedAt, doneAt, schema, photo: null | { type, data (base64) } } ] }
   * La validación es estricta: cualquier campo de más, de menos o con un valor raro rechaza el archivo entero. */
  var BACKUP_FORMAT = 'caducidades-copia';
  var BACKUP_FORMAT_VERSION = 1;
  var BACKUP_MAX_BYTES = 100 * 1024 * 1024;  // tamaño máximo del archivo
  var BACKUP_MAX_ITEMS = 20000;
  var PHOTO_MAX_BYTES = 4 * 1024 * 1024;     // por foto (las de la app ocupan unas decenas de KB)
  var LEGACY_BARCODE_RE = /^[0-9A-Za-z\-.]{1,48}$/; // la 0.1.0 admitía hasta 48: esos datos se pueden importar
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
  var B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
  var TOP_KEYS = ['format', 'formatVersion', 'app', 'appVersion', 'exportedAt', 'counts', 'items'];
  var ITEM_KEYS = ['id', 'name', 'expiry', 'quantity', 'category', 'barcode', 'state', 'createdAt', 'updatedAt', 'doneAt', 'schema', 'photo'];
  var ITEM_REQUIRED = ['id', 'name', 'expiry', 'quantity', 'category', 'barcode', 'state', 'createdAt', 'updatedAt', 'doneAt', 'photo'];

  /** Milisegundos de una marca de tiempo ISO en UTC ('2026-11-26T20:00:00.000Z'), o NaN si no es válida.
   *  Sin Date.parse: aritmética de calendario, igual que las fechas de caducidad. */
  function isoMs(s) {
    var r = typeof s === 'string' ? ISO_RE.exec(s) : null;
    if (!r || !isValidYMD(r[1])) return NaN;
    var hh = +r[2], mi = +r[3], ss = +r[4], ms = r[5] ? +((r[5] + '00').slice(0, 3)) : 0;
    if (hh > 23 || mi > 59 || ss > 59) return NaN;
    return ((dayNumber(r[1]) * 24 + hh) * 60 + mi) * 60000 + ss * 1000 + ms;
  }
  function isISO(s) { return !isNaN(isoMs(s)); }
  function isPlainObject(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

  /** Bytes -> base64 (por trozos, para no desbordar la pila con fotos grandes). */
  function bytesToBase64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Tipo de imagen por sus primeros bytes (no por lo que diga el archivo). */
  function sniffImage(b) {
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return '';
  }

  function backupFileName(now) { return 'caducidades-copia-' + todayYMD(now) + '.json'; }

  /** Monta el objeto de la copia. 'items' son los registros de IndexedDB con la foto ya en bytes
   *  ({ ...item, photoBytes: Uint8Array | null }). */
  function buildBackup(items, now) {
    var photos = 0;
    var out = items.map(function (it) {
      var photo = null;
      if (it.photoBytes && it.photoBytes.length) {
        var type = sniffImage(it.photoBytes);
        if (!type) throw new Error('La foto de «' + it.name + '» no es una imagen que se pueda copiar.');
        photo = { type: type, data: bytesToBase64(it.photoBytes) };
        photos++;
      }
      return {
        id: it.id, name: it.name, expiry: it.expiry, quantity: it.quantity, category: it.category,
        barcode: it.barcode || '', state: it.state, createdAt: it.createdAt, updatedAt: it.updatedAt || it.createdAt,
        doneAt: it.doneAt || null, schema: 1, photo: photo
      };
    });
    return {
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, app: 'Caducidades', appVersion: APP_VERSION,
      exportedAt: (now instanceof Date ? now : new Date()).toISOString(),
      counts: { items: out.length, photos: photos }, items: out
    };
  }

  function validateBackupItem(it, n) {
    var where = 'Producto ' + n + ': ';
    if (!isPlainObject(it)) return { error: where + 'no tiene el formato de un producto.' };
    var k = Object.keys(it);
    for (var i = 0; i < k.length; i++) if (ITEM_KEYS.indexOf(k[i]) < 0) return { error: where + 'tiene un dato desconocido («' + k[i] + '»).' };
    for (i = 0; i < ITEM_REQUIRED.length; i++) if (!(ITEM_REQUIRED[i] in it)) return { error: where + 'le falta el dato «' + ITEM_REQUIRED[i] + '».' };
    if (typeof it.id !== 'string' || !ID_RE.test(it.id)) return { error: where + 'el identificador no es válido.' };
    if (typeof it.name !== 'string' || typeof it.expiry !== 'string' || typeof it.category !== 'string' || typeof it.barcode !== 'string')
      return { error: where + 'el nombre, la fecha, la categoría y el código tienen que ser texto.' };
    if (typeof it.quantity !== 'number') return { error: where + 'la cantidad tiene que ser un número.' };
    var r = validateItem({ name: it.name, expiry: it.expiry, quantity: it.quantity, category: it.category, barcode: '' });
    if (!r.ok) { var f = Object.keys(r.errors)[0]; return { error: where + r.errors[f].charAt(0).toLowerCase() + r.errors[f].slice(1) }; }
    if (it.barcode && !LEGACY_BARCODE_RE.test(it.barcode)) return { error: where + 'el código de barras no es válido.' };
    var states = [STATES.ACTIVE, STATES.CONSUMED, STATES.DISCARDED];
    if (states.indexOf(it.state) < 0) return { error: where + 'el estado no es válido.' };
    if (!isISO(it.createdAt) || !isISO(it.updatedAt)) return { error: where + 'las fechas de alta o de cambio no son válidas.' };
    if (it.state === STATES.ACTIVE ? it.doneAt !== null : !isISO(it.doneAt)) return { error: where + 'la fecha de consumido o tirado no cuadra con su estado.' };
    if ('schema' in it && it.schema !== 1) return { error: where + 'tiene una versión de datos desconocida.' };
    var photo = null;
    if (it.photo !== null) {
      var p = it.photo;
      if (!isPlainObject(p) || Object.keys(p).sort().join(',') !== 'data,type' || typeof p.data !== 'string' || typeof p.type !== 'string')
        return { error: where + 'la foto no tiene el formato correcto.' };
      if (!p.data || p.data.length % 4 !== 0 || !B64_RE.test(p.data)) return { error: where + 'la foto está dañada.' };
      if (p.data.length / 4 * 3 > PHOTO_MAX_BYTES + 3) return { error: where + 'la foto es demasiado grande.' };
      var bytes;
      try { bytes = base64ToBytes(p.data); } catch (e) { return { error: where + 'la foto está dañada.' }; }
      var t = sniffImage(bytes);
      if (!t || t !== p.type) return { error: where + 'la foto no es una imagen JPEG, PNG o WebP.' };
      photo = { type: t, bytes: bytes };
    }
    return {
      value: {
        id: it.id, name: r.value.name, expiry: r.value.expiry, quantity: r.value.quantity, category: r.value.category,
        barcode: it.barcode, state: it.state, createdAt: it.createdAt, updatedAt: it.updatedAt, doneAt: it.doneAt,
        schema: 1, photo: photo
      }
    };
  }

  /** Lee y valida el texto de una copia. Devuelve { ok, backup } o { ok:false, error }. No toca ningún dato. */
  function parseBackup(text) {
    var NOT = 'Este archivo no es una copia de Caducidades';
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'El archivo está vacío.' };
    if (text.length > BACKUP_MAX_BYTES) return { ok: false, error: 'El archivo es demasiado grande para ser una copia de Caducidades.' };
    var obj;
    try { obj = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); }
    catch (e) { return { ok: false, error: NOT + ' (no es un archivo JSON válido o está incompleto).' }; }
    if (!isPlainObject(obj) || obj.format !== BACKUP_FORMAT) return { ok: false, error: NOT + '.' };
    if (typeof obj.formatVersion !== 'number' || !Number.isInteger(obj.formatVersion) || obj.formatVersion < 1)
      return { ok: false, error: 'La copia está dañada: la versión del formato no es válida.' };
    if (obj.formatVersion > BACKUP_FORMAT_VERSION)
      return { ok: false, error: 'Esta copia se hizo con una versión más nueva de la app (formato ' + obj.formatVersion + '). Actualiza la app y vuelve a intentarlo.' };
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) if (TOP_KEYS.indexOf(keys[i]) < 0) return { ok: false, error: 'La copia tiene un dato desconocido («' + keys[i] + '»).' };
    if (obj.app !== 'Caducidades' || typeof obj.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(obj.appVersion))
      return { ok: false, error: 'La copia está dañada: falta la versión de la app.' };
    if (!isISO(obj.exportedAt)) return { ok: false, error: 'La copia está dañada: falta la fecha en que se hizo.' };
    if (!Array.isArray(obj.items)) return { ok: false, error: 'La copia está dañada: falta la lista de productos.' };
    if (obj.items.length > BACKUP_MAX_ITEMS) return { ok: false, error: 'La copia tiene demasiados productos (máximo ' + BACKUP_MAX_ITEMS + ').' };
    var items = [], seen = {}, photos = 0;
    for (i = 0; i < obj.items.length; i++) {
      var r = validateBackupItem(obj.items[i], i + 1);
      if (r.error) return { ok: false, error: 'La copia no es válida. ' + r.error + ' No se ha cambiado nada.' };
      if (seen[r.value.id]) return { ok: false, error: 'La copia no es válida: el producto ' + (i + 1) + ' está repetido dentro del archivo. No se ha cambiado nada.' };
      seen[r.value.id] = true;
      if (r.value.photo) photos++;
      items.push(r.value);
    }
    if ('counts' in obj) {
      var c = obj.counts;
      if (!isPlainObject(c) || Object.keys(c).sort().join(',') !== 'items,photos' || c.items !== items.length || c.photos !== photos)
        return { ok: false, error: 'La copia está incompleta: el número de productos o de fotos no cuadra. No se ha cambiado nada.' };
    }
    return { ok: true, backup: { appVersion: obj.appVersion, exportedAt: obj.exportedAt, items: items, photos: photos } };
  }

  /** Regla de repetidos. Un producto es «el mismo» si tiene el mismo identificador (id), que se conserva al exportar.
   *  - 'combinar': los nuevos se añaden; si ya existe, gana el que se cambió más tarde (updatedAt); si es igual o el
   *    del móvil es más reciente, se queda el del móvil. No se borra nada del móvil.
   *  - 'sustituir': se borra todo lo del móvil y queda exactamente lo del archivo.
   *  Dos productos con distinto id son distintos aunque tengan el mismo nombre o código (pueden ser dos paquetes). */
  function planImport(existing, incoming, mode) {
    var byId = {};
    existing.forEach(function (e) { byId[e.id] = e; });
    var plan = { mode: mode, put: [], added: 0, updated: 0, kept: 0, removed: 0, total: incoming.length };
    if (mode === 'sustituir') {
      var inIds = {};
      incoming.forEach(function (it) { inIds[it.id] = true; if (byId[it.id]) plan.updated++; else plan.added++; plan.put.push(it); });
      plan.removed = existing.filter(function (e) { return !inIds[e.id]; }).length;
      return plan;
    }
    if (mode !== 'combinar') throw new Error('Modo de importación no válido: ' + mode);
    incoming.forEach(function (it) {
      var old = byId[it.id];
      if (!old) { plan.added++; plan.put.push(it); }
      else if (isoMs(it.updatedAt) > (isoMs(old.updatedAt || old.createdAt) || 0)) { plan.updated++; plan.put.push(it); }
      else plan.kept++;
    });
    return plan;
  }

  root.CadLogic = {
    APP_VERSION: APP_VERSION, SOON_DAYS: SOON_DAYS, CATEGORIES: CATEGORIES, STATES: STATES, STATUS_META: STATUS_META,
    parseYMD: parseYMD, isValidYMD: isValidYMD, todayYMD: todayYMD, dayNumber: dayNumber,
    daysUntil: daysUntil, addDays: addDays, statusFromDays: statusFromDays, statusOf: statusOf,
    statusText: statusText, formatYMD: formatYMD, sortItems: sortItems,
    summarizeAlerts: summarizeAlerts, alertMessage: alertMessage, validateItem: validateItem,
    BARCODE_MAX: BARCODE_MAX, barcodeProblem: barcodeProblem, checkScannedCode: checkScannedCode,
    plural: plural, listSummary: listSummary, historySummary: historySummary,
    BACKUP_FORMAT: BACKUP_FORMAT, BACKUP_FORMAT_VERSION: BACKUP_FORMAT_VERSION, BACKUP_MAX_BYTES: BACKUP_MAX_BYTES,
    PHOTO_MAX_BYTES: PHOTO_MAX_BYTES, bytesToBase64: bytesToBase64, base64ToBytes: base64ToBytes, sniffImage: sniffImage,
    backupFileName: backupFileName, isoMs: isoMs, buildBackup: buildBackup, parseBackup: parseBackup, planImport: planImport
  };
})(typeof self !== 'undefined' ? self : globalThis);
