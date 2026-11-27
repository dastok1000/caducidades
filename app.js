/* Caducidades - interfaz. Sin dependencias: todo se guarda en IndexedDB del dispositivo. La única red opcional
 * es el servidor de avisos de config.js (0.1.3), que solo recibe la suscripción push y una fecha (push.js). */
(function () {
  'use strict';
  var L = self.CadLogic;
  var P = self.CadPush;
  var db = null;
  var VIEWS = ['lista', 'anadir', 'historial', 'avisos', 'instalar', 'copia'];
  var ALERT_VIEWS = ['lista', 'avisos']; // N3: la franja «Revisa tu despensa» solo sale aquí
  var HIST_PAGE = 50;
  var DRAFT_KEY = 'caducidades-borrador';
  var ui = {
    view: 'lista',
    pushed: false,          // hay una entrada de historial propia por encima de «Lista»
    photo: undefined,       // Blob nuevo elegido en el formulario
    removePhoto: false,
    urls: [],
    formUrl: null,
    toastTimer: null,
    lastMarkedId: null,
    scan: { stream: null, timer: null, detector: null, formats: [] },
    scanInfoDefault: '',
    histShown: HIST_PAGE,
    midnightTimer: null,
    reg: null,
    waitingWorker: null,
    updateRequested: false,
    installPrompt: null,
    formGen: 0,             // B7: sube con cada resetForm; una búsqueda de código vieja no rellena nada
    exportFile: null,
    importData: null,
    pushKey: null,          // clave pública VAPID del servidor (se pide al abrir «Avisos» para no perder el gesto)
    pushTimer: null,
    pushBusy: false
  };

  function $(id) { return document.getElementById(id); }
  function noop() {}

  function h(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  /* ---------- Errores (H1): junto a donde está el usuario, con scroll y foco; se quitan al cerrar o corregir ---------- */
  function showError(msg, el) {
    var box = el || $('err-' + ui.view) || $('err-lista');
    var p = box.querySelector('.error-text') || box;
    p.textContent = msg;
    box.hidden = false;
    try { box.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { box.scrollIntoView(); }
    if (box.getAttribute('tabindex') === null) box.setAttribute('tabindex', '-1');
    box.focus({ preventScroll: true });
  }
  /** N4: mensajes de error claros, en español y sin jerga técnica. */
  function friendly(e) {
    var name = e && e.name, msg = (e && e.message) || String(e || '');
    if (name === 'QuotaExceededError') return 'No queda espacio en el dispositivo para guardar los datos. Libera espacio (o quita fotos) y vuelve a intentarlo.';
    if (name === 'InvalidStateError' || name === 'TransactionInactiveError') return 'El navegador ha cerrado la base de datos. Recarga la página y vuelve a intentarlo.';
    if (name === 'NotFoundError' || name === 'UnknownError' || name === 'DataError' || name === 'DataCloneError') return 'El navegador no ha podido guardar los datos. Recarga la página y vuelve a intentarlo.';
    if (name === 'ValidationError') return 'Hay datos que no son válidos. Revisa el formulario.';
    if (!msg) return 'Ha fallado algo inesperado. Recarga la página y vuelve a intentarlo.';
    return /[.!?]$/.test(msg) ? msg : msg + '.';
  }

  function clearError(view) {
    (view ? [view] : VIEWS).forEach(function (v) {
      var b = $('err-' + v);
      if (b) { b.hidden = true; b.querySelector('.error-text').textContent = ''; }
    });
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isAndroid() { return /Android/i.test(navigator.userAgent || ''); }
  /** Brave se identifica igual que Chrome en el user agent; solo navigator.brave lo distingue. */
  function isBrave() { return !!(navigator.brave && typeof navigator.brave.isBrave === 'function'); }
  function isStandalone() {
    return (self.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }

  /* ---------- Vistas e historial del navegador (botón Atrás de Android) ---------- */
  function setView(v, opts) {
    if (VIEWS.indexOf(v) < 0) v = 'lista';
    var prev = ui.view;
    ui.view = v;
    VIEWS.forEach(function (name) { $('view-' + name).hidden = name !== v; });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      if (b.getAttribute('data-view') === v) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (prev !== v) clearError();
    $('aviso').classList.toggle('fuera', ALERT_VIEWS.indexOf(v) < 0);
    if (v === 'copia') updateBackupUI();
    if (v === 'avisos') updateNotifUI();
    if (v === 'instalar') updateInstallUI();
    if (v !== 'anadir') stopScan();
    if (!(opts && opts.noFocus)) {
      var hd = $('view-' + v).querySelector('h2');
      if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: true }); }
      window.scrollTo(0, 0);
    }
  }

  function baseUrl() { return location.pathname + location.search; }

  /** Navegación del usuario. Desde «Lista» se apila una entrada; entre otras pestañas se sustituye;
   *  volver a «Lista» deshace la entrada. Así Atrás lleva a «Lista» y, desde «Lista», sale de la app. */
  function navigate(v) {
    if (v === ui.view) { setView(v); return; }
    try {
      if (v === 'lista') {
        if (ui.pushed) { history.back(); return; }   // popstate pinta la lista
        history.replaceState({ view: 'lista' }, '', baseUrl());
      } else if (ui.view === 'lista' && !ui.pushed) {
        history.pushState({ view: v, depth: 1 }, '', baseUrl() + '#' + v);
        ui.pushed = true;
      } else {
        history.replaceState({ view: v, depth: 1 }, '', baseUrl() + '#' + v);
      }
    } catch (e) { /* sin history API: solo se cambia la vista */ }
    setView(v);
  }

  function onPopState(e) {
    var st = e.state || {};
    var v = st.view || 'lista';
    if (!st.scanner && !$('scanner').hidden) stopScan();
    ui.pushed = v !== 'lista' && !!st.depth;
    if (v !== ui.view) setView(v);
  }

  /* ---------- Pintado ---------- */
  function freeUrls() { ui.urls.forEach(function (u) { URL.revokeObjectURL(u); }); ui.urls = []; }

  var CAT_ICON = {
    'Lácteos': '🥛', 'Carne y pescado': '🍗', 'Fruta y verdura': '🥕', 'Panadería': '🍞', 'Despensa': '🥫',
    'Congelados': '🧊', 'Bebidas': '🧃', 'Medicamentos': '💊', 'Higiene': '🧴', 'Otros': '📦'
  };

  function photoNode(item) {
    if (item.photo && typeof Blob !== 'undefined' && item.photo instanceof Blob) {
      var u = URL.createObjectURL(item.photo);
      ui.urls.push(u);
      return h('img', { class: 'foto', src: u, alt: 'Foto de ' + item.name });
    }
    return h('div', { class: 'sin-foto', 'aria-hidden': 'true', text: CAT_ICON[item.category] || '📦' });
  }

  function badge(status, text) {
    var meta = L.STATUS_META[status] || { icon: '•' };
    return h('p', { class: 'badge ' + status }, [h('span', { class: 'ico', 'aria-hidden': 'true', text: meta.icon }), h('span', { text: text })]);
  }

  function detailText(item) {
    return 'Cantidad: ' + item.quantity + ' · ' + item.category + ' · Fecha: ' + L.formatYMD(item.expiry);
  }

  function renderList(items, today) {
    var ul = $('lista');
    ul.textContent = '';
    items.forEach(function (item) {
      var days = L.daysUntil(item.expiry, today);
      var st = L.statusFromDays(days);
      ul.appendChild(h('li', { class: 'item ' + st, 'data-id': item.id, 'data-status': st }, [
        photoNode(item),
        h('div', null, [
          h('p', { class: 'nombre', text: item.name }),
          badge(st, L.statusText(days)),
          h('p', { class: 'detalle', text: detailText(item) }),
          item.barcode ? h('p', { class: 'detalle', text: 'Código: ' + item.barcode }) : null
        ]),
        h('div', { class: 'botones' }, [
          h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'consumido', 'aria-label': 'Consumido: ' + item.name, text: '✓ Consumido', onclick: function () { mark(item, 'consumido'); } }),
          h('button', { type: 'button', class: 'btn btn-danger', 'data-act': 'tirado', 'aria-label': 'Tirado: ' + item.name, text: '🗑 Tirado', onclick: function () { mark(item, 'tirado'); } }),
          h('button', { type: 'button', class: 'btn', 'data-act': 'editar', 'aria-label': 'Editar: ' + item.name, text: 'Editar', onclick: function () { editItem(item); } })
        ])
      ]));
    });
    $('vacia').hidden = items.length > 0;
    $('resumen').textContent = L.listSummary(items, today);
    $('pie-instalar').hidden = isStandalone();
  }

  function doneDate(iso) { try { return L.formatYMD(L.todayYMD(new Date(iso))); } catch (e) { return ''; } }

  function renderHistory(items, counts) {
    var ul = $('historial');
    ul.textContent = '';
    items.forEach(function (item) {
      var label = (item.state === 'consumido' ? 'Consumido' : 'Tirado') + ' el ' + doneDate(item.doneAt);
      ul.appendChild(h('li', { class: 'item hecho', 'data-id': item.id, 'data-state': item.state }, [
        photoNode(item),
        h('div', null, [
          h('p', { class: 'nombre', text: item.name }),
          h('p', { class: 'badge hecho' }, [h('span', { class: 'ico', 'aria-hidden': 'true', text: item.state === 'consumido' ? '✓' : '🗑' }), h('span', { text: label })]),
          h('p', { class: 'detalle', text: detailText(item) })
        ]),
        h('div', { class: 'botones' }, [
          h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'deshacer', 'aria-label': 'Deshacer y volver a la lista: ' + item.name, text: '↩ Deshacer', onclick: function () { undo(item.id); } }),
          h('button', { type: 'button', class: 'btn btn-danger', 'data-act': 'borrar', 'aria-label': 'Borrar del historial: ' + item.name, text: 'Borrar', onclick: function () { removeItem(item); } })
        ])
      ]));
    });
    $('hist-vacio').hidden = items.length > 0;
    $('resumen-hist').textContent = L.historySummary(counts) + (counts.total > items.length ? ' · se ven ' + items.length + ' de ' + counts.total : '');
    var rest = counts.total - items.length;
    var more = $('btn-mas-hist');
    more.hidden = rest <= 0;
    more.textContent = 'Ver más (' + (rest === 1 ? 'queda 1' : 'quedan ' + rest) + ')';
  }

  function renderAlert(items, today) {
    var box = $('aviso');
    var s = L.summarizeAlerts(items, today);
    box.textContent = '';
    if (!s.expired.length && !s.soon.length) { box.hidden = true; return s; }
    box.className = 'aviso' + (s.expired.length ? '' : ' solo-pronto');
    box.appendChild(h('p', { text: '⚠ Revisa tu despensa' }));
    if (s.expired.length) box.appendChild(h('p', { text: '✖ ' + L.alertMessage({ expired: s.expired, soon: [] }) }));
    if (s.soon.length) box.appendChild(h('p', { text: '! ' + L.alertMessage({ expired: [], soon: s.soon }) }));
    box.hidden = false;
    return s;
  }

  function refresh() {
    if (!db) return Promise.resolve();
    var today = L.todayYMD();
    return Promise.all([db.listActive(), db.listHistory(ui.histShown), db.historyCounts()]).then(function (r) {
      freeUrls();
      renderList(r[0], today);
      renderHistory(r[1], r[2]);
      renderAlert(r[0], today);
      document.documentElement.setAttribute('data-ready', '1');
      // 0.1.3d (N5): el cambio queda pendiente en IndexedDB ya, no a los 4 s; y se guarda la lista para flush().
      ui.activeItems = r[0];
      if (P.configured()) P.note(db, r[0]).catch(noop);
      pushSync();
      return r[0];
    }).catch(function (e) { showError('No he podido leer tus datos. ' + friendly(e)); });
  }

  /* ---------- Acciones ---------- */
  function toast(text, withUndo) {
    $('toast-text').textContent = text;
    $('toast-undo').hidden = !withUndo;
    $('toast').hidden = false;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(function () { $('toast').hidden = true; }, withUndo ? 8000 : 3500);
  }

  function mark(item, state) {
    return db.mark(item.id, state).then(function () {
      clearError('lista');
      ui.lastMarkedId = item.id;
      toast((state === 'consumido' ? 'Consumido: ' : 'Tirado: ') + item.name, true);
      return refresh();
    }).catch(function (e) {
      var gone = /ya no está en la lista|No existe/.test(e && e.message || '');
      return refresh().then(function () {
        showError(gone ? '«' + item.name + '» ya no está en la lista: quizá lo marcaste o lo borraste en otra pestaña. He actualizado la lista.'
          : 'No he podido marcar «' + item.name + '». ' + friendly(e));
      });
    });
  }

  function undo(id) {
    return db.undo(id).then(function (it) {
      clearError();
      ui.lastMarkedId = null;
      toast('De vuelta en la lista: ' + it.name, false);
      return refresh();
    }).catch(function (e) {
      return refresh().then(function () {
        showError(/No existe/.test(e && e.message || '') ? 'Ese producto ya no existe: quizá lo borraste en otra pestaña. He actualizado el historial.'
          : 'No he podido devolverlo a la lista. ' + friendly(e));
      });
    });
  }

  function removeItem(item) {
    if (!window.confirm('¿Borrar «' + item.name + '» del historial? No se puede deshacer.')) return;
    db.remove(item.id).then(function () { clearError('historial'); return refresh(); })
      .catch(function (e) { showError('No he podido borrarlo. ' + friendly(e)); });
  }

  /* ---------- Formulario ---------- */
  var FIELDS = ['name', 'expiry', 'quantity', 'category', 'barcode'];

  function fillCategories() {
    var sel = $('f-category');
    L.CATEGORIES.forEach(function (c) { sel.appendChild(h('option', { value: c, text: c })); });
    sel.value = 'Otros';
  }

  function setFieldError(k, msg) {
    var e = $('e-' + k);
    e.textContent = msg || '';
    e.hidden = !msg;
    if (msg) $('f-' + k).setAttribute('aria-invalid', 'true'); else $('f-' + k).removeAttribute('aria-invalid');
  }
  function clearErrors() { FIELDS.forEach(function (k) { setFieldError(k, ''); }); setPhotoError(''); }

  function setPhotoError(msg) {
    var e = $('e-photo');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  function setFormPhoto(blob) {
    if (ui.formUrl) { URL.revokeObjectURL(ui.formUrl); ui.formUrl = null; }
    if (blob) {
      ui.formUrl = URL.createObjectURL(blob);
      $('foto-img').src = ui.formUrl;
      $('foto-prev').hidden = false;
    } else {
      $('foto-img').removeAttribute('src');
      $('foto-prev').hidden = true;
    }
  }

  function resetForm() {
    $('form').reset();
    $('f-id').value = '';
    $('f-quantity').value = '1';
    $('f-category').value = 'Otros';
    $('t-anadir').textContent = 'Añadir producto';
    $('btn-guardar').textContent = 'Guardar';
    $('scan-info').textContent = ui.scanInfoDefault;
    ui.photo = undefined; ui.removePhoto = false;
    ui.formGen++;
    setFormPhoto(null);
    clearErrors();
    clearError('anadir');
    clearDraft();
  }

  function editItem(item) {
    resetForm();
    navigate('anadir');
    $('t-anadir').textContent = 'Editar producto';
    $('btn-guardar').textContent = 'Guardar cambios';
    $('f-id').value = item.id;
    $('f-name').value = item.name;
    $('f-expiry').value = item.expiry;
    $('f-quantity').value = String(item.quantity);
    $('f-category').value = item.category;
    $('f-barcode').value = item.barcode || '';
    if (item.photo) setFormPhoto(item.photo);
    saveDraft();
  }

  function readForm() {
    var q = $('f-quantity');
    return {
      name: $('f-name').value, expiry: $('f-expiry').value,
      quantity: q.validity && q.validity.badInput ? 'no-numero' : q.value,
      category: $('f-category').value, barcode: $('f-barcode').value
    };
  }

  /* Borrador (B4): lo escrito se conserva al cambiar de pestaña y, si el navegador recarga la página
   * (por ejemplo al volver de la cámara), se recupera de sessionStorage. La foto no se guarda en el borrador. */
  function saveDraft() {
    try {
      var d = readForm();
      d.id = $('f-id').value;
      d.editing = $('t-anadir').textContent;
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch (e) { /* sin sessionStorage: el borrador vive solo en memoria (el propio formulario) */ }
  }
  function clearDraft() { try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {} }
  function restoreDraft() {
    try {
      var d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
      if (!d) return;
      $('f-id').value = d.id || '';
      $('f-name').value = d.name || '';
      $('f-expiry').value = d.expiry || '';
      $('f-quantity').value = d.quantity === 'no-numero' ? '' : (d.quantity || '1');
      if (L.CATEGORIES.indexOf(d.category) >= 0) $('f-category').value = d.category;
      $('f-barcode').value = d.barcode || '';
      if (d.id) { $('t-anadir').textContent = 'Editar producto'; $('btn-guardar').textContent = 'Guardar cambios'; }
    } catch (e) {}
  }

  /** Al corregir un campo con error, su mensaje desaparece en cuanto el valor es válido. */
  function revalidateField(k) {
    if ($('e-' + k).hidden) return;
    var r = L.validateItem(readForm());
    if (r.ok || !r.errors[k]) setFieldError(k, '');
    else setFieldError(k, r.errors[k]);
  }

  function onSubmit(ev) {
    ev.preventDefault();
    clearErrors();
    clearError('anadir');
    var r = L.validateItem(readForm());
    if (!r.ok) {
      var first = null;
      FIELDS.forEach(function (k) {
        if (!r.errors[k]) return;
        setFieldError(k, r.errors[k]);
        if (!first) first = $('f-' + k);
      });
      if (first) { try { first.scrollIntoView({ block: 'center' }); } catch (e) {} first.focus({ preventScroll: true }); }
      return;
    }
    var id = $('f-id').value;
    var input = Object.assign({}, r.value, { photo: ui.photo || null, removePhoto: ui.removePhoto });
    $('btn-guardar').disabled = true;
    (id ? db.update(id, input) : db.add(input)).then(function (item) {
      toast((id ? 'Cambios guardados: ' : 'Añadido: ') + item.name, false);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(noop);
      resetForm();
      navigate('lista');
      return refresh();
    }).catch(function (e) {
      showError(/No existe/.test(e && e.message || '') ? 'Este producto ya no existe (quizá lo borraste en otra pestaña). Pulsa «Cancelar» y vuelve a añadirlo.'
        : 'No he podido guardar el producto. ' + friendly(e), $('err-anadir'));
    }).then(function () { $('btn-guardar').disabled = false; });
  }

  /** Reduce la foto en el propio dispositivo (canvas) y devuelve un Blob JPEG. */
  function resizePhoto(file, maxSide, quality) {
    maxSide = maxSide || 1024; quality = quality || 0.8;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, hgt = img.naturalHeight || img.height;
          if (!w || !hgt) throw new Error('No se pudo leer la imagen.');
          var k = Math.min(1, maxSide / Math.max(w, hgt));
          var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(hgt * k));
          var c = document.createElement('canvas');
          c.width = cw; c.height = ch;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url);
          if (c.toBlob) c.toBlob(function (b) { b ? resolve(b) : reject(new Error('No se pudo reducir la foto.')); }, 'image/jpeg', quality);
          else resolve(dataUrlToBlob(c.toDataURL('image/jpeg', quality)));
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen.')); };
      img.src = url;
    });
  }

  function dataUrlToBlob(d) {
    var parts = d.split(','), bin = atob(parts[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'image/jpeg' });
  }

  function onPhoto(ev) {
    var input = ev.target;
    var f = input.files && input.files[0];
    if (!f) return;
    setPhotoError('');
    resizePhoto(f).then(function (blob) {
      ui.photo = blob; ui.removePhoto = false;
      setFormPhoto(blob);
    }).catch(function (e) {
      // No se conserva en silencio una foto anterior: el formulario queda sin foto nueva y se dice por qué.
      ui.photo = undefined;
      if (!$('f-id').value) setFormPhoto(null);
      input.value = '';
      setPhotoError(e.message + ' Prueba con otra foto o guarda el producto sin foto.');
      var el = $('e-photo');
      try { el.scrollIntoView({ block: 'center' }); } catch (x) {}
      $('btn-galeria').focus({ preventScroll: true });
    });
  }

  function onBarcodeChange() {
    var code = $('f-barcode').value.replace(/\s+/g, '');
    $('scan-info').textContent = ui.scanInfoDefault;
    if (!code || !db || L.barcodeProblem(code)) return;
    var gen = ui.formGen;
    db.findByBarcode(code).then(function (prev) {
      // B7: si mientras tanto se canceló o se vació el formulario, o el código ya es otro, no se rellena nada.
      if (gen !== ui.formGen || $('f-barcode').value.replace(/\s+/g, '') !== code) return;
      if (prev && !$('f-name').value.trim()) {
        $('f-name').value = prev.name;
        $('f-category').value = prev.category;
        $('scan-info').textContent = 'Ya lo habías apuntado antes: he rellenado el nombre y la categoría.';
        saveDraft();
      }
    }).catch(noop);
  }

  /* ---------- Escáner (BarcodeDetector + cámara) ---------- */
  // Sin QR: los productos usan EAN/UPC/Code 128… Aun así, todo lo leído se valida (B5).
  var WANTED = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar'];

  function initScanner() {
    var info = $('scan-info');
    var manual = 'Escribe el código a mano (los números que hay debajo de las barras).';
    function set(t) { ui.scanInfoDefault = t; info.textContent = t; }
    var can = typeof self.BarcodeDetector === 'function' && navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' && self.isSecureContext !== false;
    if (!can) { set('Este navegador no puede escanear códigos. ' + manual); return Promise.resolve(false); }
    var gf = self.BarcodeDetector.getSupportedFormats ? self.BarcodeDetector.getSupportedFormats() : Promise.resolve(WANTED);
    return Promise.resolve(gf).then(function (formats) {
      ui.scan.formats = (formats || []).filter(function (f) { return WANTED.indexOf(f) >= 0; });
      if (!ui.scan.formats.length) { set('Este navegador no puede escanear códigos. ' + manual); return false; }
      $('btn-scan').hidden = false;
      set('Pulsa «Escanear» para usar la cámara, o escríbelo a mano.');
      return true;
    }).catch(function () { set(manual); return false; });
  }

  function startScan() {
    var msg = $('scan-msg');
    msg.textContent = 'Abriendo la cámara…';
    $('scanner').hidden = false;
    try { history.pushState({ view: 'anadir', scanner: true, depth: 2 }, '', baseUrl() + '#anadir'); } catch (e) {}
    $('btn-scan-cerrar').focus();
    try { ui.scan.detector = new self.BarcodeDetector({ formats: ui.scan.formats }); }
    catch (e) { msg.textContent = 'No se puede escanear en este navegador. Escribe el código a mano.'; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (stream) {
      if ($('scanner').hidden) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      ui.scan.stream = stream;
      var v = $('scan-video');
      v.srcObject = stream;
      return v.play().then(function () {
        msg.textContent = 'Buscando el código…';
        var busy = false;
        ui.scan.timer = setInterval(function () {
          if (busy || !ui.scan.detector) return;
          busy = true;
          ui.scan.detector.detect(v).then(function (codes) {
            busy = false;
            if (codes && codes.length) onScanned(codes[0].rawValue);
          }).catch(function () { busy = false; });
        }, 300);
      });
    }).catch(function (e) {
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      msg.textContent = denied
        ? 'No hay permiso para usar la cámara. Puedes darlo en los ajustes del navegador o escribir el código a mano.'
        : 'No se ha podido abrir la cámara. Escribe el código a mano.';
    });
  }

  /** B5: lo que no es un código de barras de producto (una dirección web, un texto) se rechaza con un mensaje
   *  claro y NO se copia al campo, así que no bloquea el guardado. */
  function onScanned(raw) {
    var r = L.checkScannedCode(raw);
    closeScanner();
    if (!r.ok) {
      setFieldError('barcode', 'Lo leído no se ha guardado: ' + r.reason + ' Escanea el código de barras del envase o escríbelo a mano.');
      $('f-barcode').focus();
      return;
    }
    setFieldError('barcode', '');
    $('f-barcode').value = r.code;
    $('f-barcode').focus();
    onBarcodeChange();
    saveDraft();
    toast('Código leído: ' + r.code, false);
  }

  function closeScanner() {
    var st = history.state;
    stopScan();
    if (st && st.scanner) { try { history.back(); } catch (e) {} }
  }

  function stopScan() {
    clearInterval(ui.scan.timer); ui.scan.timer = null;
    if (ui.scan.stream) { ui.scan.stream.getTracks().forEach(function (t) { t.stop(); }); ui.scan.stream = null; }
    var v = $('scan-video'); if (v) { try { v.pause(); } catch (e) {} v.srcObject = null; }
    if ($('scanner')) $('scanner').hidden = true;
  }

  /* ---------- Copia de seguridad: exportar e importar (JSON con fotos) ---------- */
  function sizeText(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }

  function blobBytes(b) {
    if (b.arrayBuffer) return b.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(b);
    });
  }

  function fileText(f) {
    if (f.text) return f.text();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsText(f, 'utf-8');
    });
  }

  /** Compartir el archivo solo donde de verdad funciona con .json: Chrome y Edge (con navigator.userAgentData)
   *  no dejan compartir archivos .json (su lista de tipos permitidos no lo incluye) aunque canShare diga que sí;
   *  allí se ofrece solo «Descargar». En Safari (iPhone) sí se puede. */
  function canShareFile(file) {
    if (navigator.userAgentData) return false;
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch (e) { return false; }
  }

  /** Al entrar en «Copia» se descarta una copia preparada antes (podría no tener los últimos cambios). */
  function updateBackupUI() {
    ui.exportFile = null;
    $('export-listo').hidden = true;
    $('export-estado').textContent = '';
  }

  /** Paso 1: preparar el archivo (lee todo y convierte las fotos). Se separa de «Compartir» porque Safari solo deja
   *  compartir justo después de un toque, sin esperas de por medio. */
  function prepareExport() {
    if (!db) return;
    var btn = $('btn-exportar');
    btn.disabled = true;
    clearError('copia');
    $('export-estado').textContent = 'Preparando la copia…';
    db.exportAll().then(function (items) {
      return Promise.all(items.map(function (it) {
        var p = it.photo && typeof Blob !== 'undefined' && it.photo instanceof Blob ? blobBytes(it.photo) : Promise.resolve(null);
        return p.then(function (bytes) { var c = Object.assign({}, it); c.photoBytes = bytes; return c; });
      }));
    }).then(function (items) {
      items.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0; });
      var now = new Date();
      var backup = L.buildBackup(items, now);
      var json = JSON.stringify(backup, null, 1) + '\n';
      var name = L.backupFileName(now);
      var blob = new Blob([json], { type: 'application/json' });
      var file;
      try { file = new File([blob], name, { type: 'application/json' }); } catch (e) { file = blob; file.name = name; }
      ui.exportFile = { file: file, blob: blob, name: name, counts: backup.counts, size: blob.size };
      $('export-info').textContent = 'Copia lista: ' + L.plural(backup.counts.items, 'producto', 'productos') +
        ' (con el historial) y ' + L.plural(backup.counts.photos, 'foto', 'fotos') + ', ' + sizeText(blob.size) + '. Archivo: ' + name;
      $('btn-compartir').hidden = !canShareFile(file);
      $('export-listo').hidden = false;
      $('export-estado').textContent = $('btn-compartir').hidden
        ? 'Pulsa «Descargar el archivo» y guárdalo fuera del móvil (en la nube, en el PC o enviándotelo).'
        : 'Pulsa «Compartir o guardar» y elige dónde guardarla (por ejemplo «Guardar en Archivos», tu nube o enviártela).';
      ($('btn-compartir').hidden ? $('btn-descargar') : $('btn-compartir')).focus();
    }).catch(function (e) {
      ui.exportFile = null;
      $('export-listo').hidden = true;
      $('export-estado').textContent = '';
      showError('No he podido crear la copia. ' + friendly(e), $('err-copia'));
    }).then(function () { btn.disabled = false; });
  }

  function shareExport() {
    var x = ui.exportFile; if (!x) return;
    navigator.share({ files: [x.file], title: 'Copia de Caducidades', text: 'Copia de seguridad de Caducidades (' + x.name + ')' }).then(function () {
      $('export-estado').textContent = '✓ Copia compartida. Comprueba que se ha guardado donde elegiste.';
    }).catch(function (e) {
      if (e && e.name === 'AbortError') { $('export-estado').textContent = 'No se ha compartido. Puedes volver a intentarlo o descargar el archivo.'; return; }
      $('btn-compartir').hidden = true;
      showError('Este navegador no ha dejado compartir el archivo. Usa «Descargar el archivo».', $('err-copia'));
    });
  }

  function downloadExport() {
    var x = ui.exportFile; if (!x) return;
    var url = URL.createObjectURL(x.blob);
    var a = h('a', { href: url, download: x.name, hidden: true });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 60000);
    $('export-estado').textContent = '✓ Descargado «' + x.name + '». En Android suele quedar en «Descargas»; en iPhone, en Archivos → Descargas.';
  }

  function resetImport() {
    ui.importData = null;
    $('import-confirm').hidden = true;
    $('f-importar').value = '';
  }

  function onImportFile(ev) {
    var f = ev.target.files && ev.target.files[0];
    resetImport();
    clearError('copia');
    $('import-estado').textContent = '';
    if (!f || !db) return;
    if (f.size > L.BACKUP_MAX_BYTES) { showError('El archivo es demasiado grande para ser una copia de Caducidades. No se ha cambiado nada.', $('err-copia')); return; }
    $('import-estado').textContent = 'Comprobando el archivo…';
    fileText(f).then(function (text) {
      var r = L.parseBackup(text);
      if (!r.ok) throw Object.assign(new Error(r.error), { name: 'BackupError' });
      return db.previewImport(r.backup.items).then(function (pv) { return { backup: r.backup, pv: pv, fileName: f.name }; });
    }).then(function (d) {
      ui.importData = d;
      var b = d.backup, c = d.pv.combinar, r = d.pv.sustituir;
      $('import-estado').textContent = '';
      $('import-resumen').textContent = 'El archivo «' + d.fileName + '» es una copia válida del ' + doneDate(b.exportedAt) +
        ' (app ' + b.appVersion + '): ' + L.plural(b.items.length, 'producto', 'productos') + ' y ' + L.plural(b.photos, 'foto', 'fotos') +
        '. En este móvil hay ' + L.plural(d.pv.existing, 'producto', 'productos') + '. ¿Qué quieres hacer?';
      $('imp-combinar-txt').textContent = 'Nuevos: ' + c.added + ' · Actualizados (la copia es más reciente): ' + c.updated +
        ' · Sin cambios: ' + c.kept + '. No se borra nada.';
      $('imp-sustituir-txt').textContent = 'Se borra lo que hay en este móvil (' + L.plural(d.pv.existing, 'producto', 'productos') +
        ') y queda lo de la copia (' + L.plural(b.items.length, 'producto', 'productos') + ')' +
        '.' + (r.removed === 1 ? ' Se pierde 1 producto que no está en la copia.' : r.removed > 1 ? ' Se pierden ' + r.removed + ' productos que no están en la copia.' : '');
      $('import-confirm').hidden = false;
      try { $('import-confirm').scrollIntoView({ block: 'start' }); } catch (e) {}
      $('import-resumen').focus({ preventScroll: true });
    }).catch(function (e) {
      $('import-estado').textContent = '';
      resetImport();
      showError(e && e.name === 'BackupError' ? e.message : 'No he podido leer el archivo. ' + friendly(e) + ' No se ha cambiado nada.', $('err-copia'));
    });
  }

  function doImport(mode) {
    var d = ui.importData; if (!d || !db) return;
    if (mode === 'sustituir' && d.pv.existing > 0 &&
      !window.confirm('¿Borrar lo que hay en este móvil (' + L.plural(d.pv.existing, 'producto', 'productos') + ') y dejar solo lo de la copia? No se puede deshacer.')) return;
    ['btn-imp-combinar', 'btn-imp-sustituir', 'btn-imp-cancelar'].forEach(function (id) { $(id).disabled = true; });
    db.importBackup(d.backup.items, mode).then(function (r) {
      resetImport();
      ui.histShown = HIST_PAGE;
      var txt = mode === 'sustituir'
        ? '✓ Copia importada: ahora hay ' + L.plural(r.total, 'producto', 'productos') + ' (los de la copia).'
        : '✓ Copia importada. Nuevos: ' + r.added + ' · Actualizados: ' + r.updated + ' · Sin cambios: ' + r.kept + '.';
      $('import-estado').textContent = txt;
      toast(txt.replace('✓ ', ''), false);
      return refresh();
    }).catch(function (e) {
      showError('No se ha podido importar la copia. ' + friendly(e) + ' No se ha cambiado nada: tus datos siguen como estaban.', $('err-copia'));
    }).then(function () {
      ['btn-imp-combinar', 'btn-imp-sustituir', 'btn-imp-cancelar'].forEach(function (id) { $(id).disabled = false; });
    });
  }

  /* ---------- Avisos ---------- */
  function notifSupported() { return 'Notification' in self && 'serviceWorker' in navigator; }

  function pushCapable() { return P.configured() && notifSupported() && 'PushManager' in self; }

  function updateNotifUI() {
    var st = $('notif-estado'), btn = $('btn-notif'), test = $('btn-notif-prueba');
    btn.hidden = true; test.hidden = true; $('btn-push-off').hidden = true;
    $('nota-servidor').hidden = P.configured(); $('nota-servidor-on').hidden = !P.configured();
    var pe = $('push-estado');
    pe.textContent = P.configured() ? '' : 'Avisos con la app cerrada: esta versión no tiene servidor de avisos.';
    if (!notifSupported()) {
      st.textContent = isIOS() && !isStandalone()
        ? 'En iPhone, para recibir avisos del sistema añade la app a la pantalla de inicio (iOS 16.4 o posterior) y ábrela desde allí. Mientras tanto verás el aviso dentro de la app.'
        : 'Este navegador no permite avisos del sistema. Verás el aviso dentro de la app al abrirla.';
      return Promise.resolve();
    }
    var p = Notification.permission;
    if (p === 'granted') { st.textContent = '✓ Avisos del sistema activados.'; test.hidden = false; }
    else if (p === 'denied') st.textContent = '✖ Has bloqueado los avisos. Puedes permitirlos en los ajustes del navegador (mira «Cómo permitir los avisos»). Mientras tanto verás el aviso dentro de la app.';
    else { st.textContent = 'Los avisos del sistema están desactivados.'; btn.hidden = false; }
    if (!P.configured()) return Promise.resolve();
    if (!('PushManager' in self)) {
      pe.textContent = isIOS() ? 'Avisos con la app cerrada: en iPhone hace falta abrirla desde la pantalla de inicio (iOS 16.4 o posterior).'
        : 'Avisos con la app cerrada: este navegador no los admite. Verás el aviso al abrir la app.';
      return Promise.resolve();
    }
    prefetchPushKey();
    if (!db) return Promise.resolve();
    return P.getState(db).then(function (ps) {
      if (ps && ps.on) {
        pe.textContent = '✓ Avisos con la app cerrada: activados. Cada día a las 9:00 (hora de Madrid), si hay algo caducado o que caduca en 3 días o menos.' +
          (ps.pending ? ' Hay cambios pendientes de enviar: se reintentarán solos y se mandarán en cuanto el servidor responda.' : '');
        $('btn-push-off').hidden = p === 'denied';
        btn.hidden = true;
      } else {
        pe.textContent = ps && ps.lost ? 'Avisos con la app cerrada: se ha perdido la suscripción. Pulsa «Activar avisos» otra vez.'
          : ps && ps.pendingDelete ? 'Avisos con la app cerrada: desactivados (falta borrarlos del servidor; se hará cuando vuelva la conexión).'
          : 'Avisos con la app cerrada: desactivados.';
        if (p !== 'denied') btn.hidden = false;
      }
    }).catch(noop);
  }

  /** Pide la clave pública del servidor por adelantado: así, al pulsar «Activar avisos», la suscripción se pide
   *  en el mismo gesto (Safari en iPhone lo exige). Si no hay conexión, se intenta al pulsar. */
  function prefetchPushKey() {
    if (ui.pushKey || !P.configured()) return;
    fetch(P.serverUrl() + '/api/config', { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.vapidPublicKey) ui.pushKey = j.vapidPublicKey; })
      .catch(noop);
  }

  function pushHelp(text) {
    $('push-ayuda-texto').textContent = text || '';
    $('push-ayuda').hidden = !text;
  }

  function pushErrorText(e) {
    var name = e && e.name, msg = (e && e.message) || '';
    if (name === 'NotAllowedError' || (self.Notification && Notification.permission === 'denied'))
      return 'No hay permiso para mostrar avisos. Permítelos en los ajustes del navegador y vuelve a pulsar «Activar avisos».';
    if (name === 'NetworkError') return 'No hay conexión con el servidor de avisos. Inténtalo más tarde; mientras tanto verás el aviso al abrir la app.';
    if (name === 'ServerError') return msg;
    if (name === 'AbortError' || /push service|servicio push|registration failed/i.test(msg)) {
      if (isBrave() && !isAndroid())
        return 'Brave no ha podido activar los avisos con la app cerrada. Escribe brave://settings/privacy en la barra de direcciones, activa «Usar los servicios de Google para mensajes push», cierra Brave del todo, vuelve a abrir la app y pulsa «Activar avisos».';
      return isBrave()
        ? 'Brave no ha podido activar los avisos con la app cerrada. En Brave: menú ⋮ → Ajustes → Privacidad y seguridad → activa «Usar los servicios de Google para mensajes push» (ruta no comprobada en un Android real; si no la ves, busca «push» en los Ajustes de Brave), cierra Brave del todo, vuelve a abrir la app y pulsa «Activar avisos».'
        : 'El servicio de avisos del navegador no está disponible (en Android hacen falta los servicios de Google Play). Mientras tanto verás el aviso al abrir la app.';
    }
    if (name === 'NotSupportedError') return 'Este navegador no puede recibir avisos con la app cerrada. Verás el aviso al abrir la app.';
    return 'No se han podido activar los avisos con la app cerrada. ' + friendly(e);
  }

  function afterPermission(p) {
    updateNotifUI();
    if (p === 'granted') { registerPeriodic(); maybeNotify(false); }
  }

  /** «Activar avisos»: con servidor, pide la suscripción push en el mismo gesto (eso pide también el permiso);
   *  sin servidor, solo el permiso de avisos del sistema, como en la 0.1.2. */
  function onActivate() {
    clearError('avisos'); pushHelp('');
    if (!pushCapable()) return askPermission();
    var reg = ui.reg;
    var btn = $('btn-notif');
    if (ui.pushBusy) return;
    ui.pushBusy = true; btn.disabled = true;
    $('push-estado').textContent = 'Activando los avisos…';
    var subP;
    if (reg && reg.active && reg.pushManager && ui.pushKey) {
      try { subP = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: P.b64uToBytes(ui.pushKey) }); }
      catch (e) { subP = Promise.reject(e); }
      subP = subP.catch(function (e) {
        if (e && e.name === 'InvalidStateError') return null; // había otra suscripción con otra clave: enable() la cambia
        throw e;
      });
    } else {
      // Sin la clave aún (p. ej. sin conexión al abrir «Avisos»): primero el permiso, luego la suscripción.
      subP = requestPermissionP().then(function (p) {
        if (p !== 'granted') { var e = new Error('sin permiso'); e.name = 'NotAllowedError'; throw e; }
        return null;
      });
    }
    subP.then(function () {
      afterPermission(Notification.permission);
      return (reg ? Promise.resolve(reg) : swReady()).then(function (r) { return P.enable(db, r); });
    }).then(function () {
      toast('Avisos con la app cerrada activados.');
    }).catch(function (e) {
      var t = pushErrorText(e);
      showError(t, $('err-avisos'));
      if (/Brave|servicio de avisos del navegador|permiso/.test(t)) pushHelp('Tienes los pasos para tu navegador en «Cómo permitir los avisos».');
    }).then(function () {
      ui.pushBusy = false; btn.disabled = false;
      updateNotifUI();
    });
  }

  function onDeactivate() {
    clearError('avisos'); pushHelp('');
    var btn = $('btn-push-off');
    btn.disabled = true;
    (ui.reg ? Promise.resolve(ui.reg) : swReady()).then(function (reg) { return P.disable(db, reg); }).then(function (r) {
      toast(r.serverDeleted ? 'Avisos con la app cerrada desactivados y borrados del servidor.' : 'Avisos desactivados. Se borrarán del servidor cuando vuelva la conexión.');
    }).catch(function (e) {
      showError('No se han podido desactivar los avisos. ' + friendly(e), $('err-avisos'));
    }).then(function () { btn.disabled = false; updateNotifUI(); });
  }

  /** Manda al servidor la fecha de aviso si ha cambiado (tras cada cambio en los productos, al abrir y al volver la conexión).
   *  0.1.3c (N1): los cambios se agrupan (se espera 4 s desde el último, y como mucho 30 s desde el primero) y se manda
   *  solo la fecha más reciente, que se calcula al enviar. Si el servidor no la acepta, se reintenta respetando
   *  Retry-After y con espera creciente hasta conseguirlo (y tras cerrar y abrir la app, por la hora guardada en el móvil). */
  var PUSH_DEBOUNCE_MS = 4000, PUSH_MAXWAIT_MS = 30000;
  function pushSync(force, ignoreRetry) {
    if (!db || !P.configured()) return;
    var now = Date.now();
    if (!ui.pushFirst) ui.pushFirst = now;
    ui.pushForce = ui.pushForce || !!force;
    ui.pushIgnore = ui.pushIgnore || !!ignoreRetry;
    clearTimeout(ui.pushTimer);
    ui.pushTimer = setTimeout(runPushSync, Math.max(0, Math.min(PUSH_DEBOUNCE_MS, ui.pushFirst + PUSH_MAXWAIT_MS - now)));
  }
  function runPushSync() {
    ui.pushTimer = 0;
    if (ui.pushBusy) { ui.pushRerun = true; return; }
    var opts = { force: !!ui.pushForce, ignoreRetry: !!ui.pushIgnore };
    ui.pushFirst = 0; ui.pushForce = false; ui.pushIgnore = false;
    ui.pushBusy = true;
    P.sync(db, ui.reg, opts).then(function (r) {
      if (r && (r.estado === 'pendiente' || r.estado === 'baja-pendiente')) schedulePushRetry(r.retryAt);
      else { clearTimeout(ui.pushRetry); ui.pushRetry = 0; }
      if (ui.view === 'avisos') updateNotifUI();
    }).catch(noop).then(function () {
      ui.pushBusy = false;
      if (ui.pushRerun) { ui.pushRerun = false; pushSync(); }
    });
  }
  /** 0.1.3d (N5): al ocultar o cerrar la app no se espera a los 4 s: se manda ya lo pendiente con fetch keepalive
   *  (el navegador lo termina aunque se cierre la página) y se pide Background Sync. Una vez por ocultación. */
  function pushFlush() {
    if (!db || !P.configured() || ui.pushFlushed) return;
    ui.pushFlushed = true;
    if (ui.pushTimer) { clearTimeout(ui.pushTimer); ui.pushTimer = 0; ui.pushFirst = 0; }
    P.flush(db, ui.reg, ui.activeItems).catch(noop);
  }
  function schedulePushRetry(retryAt) {
    clearTimeout(ui.pushRetry);
    ui.pushRetry = setTimeout(function () { ui.pushRetry = 0; pushSync(); }, retryAt ? Math.max(1000, retryAt - Date.now() + 250) : 15000);
  }

  function requestPermissionP() {
    return new Promise(function (resolve) {
      var done = false;
      function after(p) { if (!done) { done = true; resolve(p); } }
      try {
        var r = Notification.requestPermission(after);
        if (r && typeof r.then === 'function') r.then(after, function () { after(Notification.permission); });
      } catch (e) { after(Notification.permission); }
    });
  }

  function askPermission() {
    var done = false;
    function after(p) {
      if (done) return; done = true;
      afterPermission(p);
    }
    try {
      var r = Notification.requestPermission(after);
      if (r && typeof r.then === 'function') r.then(after);
    } catch (e) { showError('No se ha podido pedir permiso para los avisos.', $('err-avisos')); }
  }

  function swReady() {
    if (!('serviceWorker' in navigator)) return Promise.reject(new Error('Sin service worker'));
    return navigator.serviceWorker.ready;
  }

  /** Aviso del sistema: como mucho uno automático al día. El de prueba ('test') no marca el día como avisado. */
  function maybeNotify(test) {
    if (!notifSupported() || Notification.permission !== 'granted' || !db) return Promise.resolve(false);
    var today = L.todayYMD();
    return Promise.all([db.listActive(), db.getMeta('lastNotified'), swReady()]).then(function (r) {
      var body = L.alertMessage(L.summarizeAlerts(r[0], today));
      if (!body) { if (!test) return false; body = 'Nada caducado ni a punto de caducar. ¡Todo bien!'; }
      if (!test && r[1] === today) return false;
      return r[2].showNotification(test ? 'Caducidades (prueba)' : 'Caducidades', {
        body: body, tag: test ? 'caducidades-prueba' : 'caducidades-resumen', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'es'
      }).then(function () { return test ? null : db.setMeta('lastNotified', today); }).then(function () { return true; });
    }).catch(function () { return false; });
  }

  function registerPeriodic() {
    swReady().then(function (reg) {
      if (!reg.periodicSync) return;
      return reg.periodicSync.register('revisar-caducidades', { minInterval: 12 * 60 * 60 * 1000 });
    }).catch(noop);
  }

  /* ---------- Instalar ---------- */
  function updateInstallUI() {
    var st = $('inst-estado');
    var here = isIOS() ? 'guia-iphone' : isAndroid() ? (isBrave() ? 'guia-brave' : 'guia-android') : 'guia-pc';
    // Brave en el ordenador no tiene «Ajustes de Android»: su propia guía (H4 de la QA de la 0.1.3).
    var avisosHere = isIOS() ? 'avisos-iphone' : isBrave() ? (isAndroid() ? 'avisos-brave' : 'avisos-brave-pc') : 'avisos-chrome';
    ['avisos-chrome', 'avisos-brave', 'avisos-brave-pc', 'avisos-iphone'].forEach(function (id) { $(id).classList.toggle('este', id === avisosHere); });
    $('avisos-chrome').parentNode.insertBefore($(avisosHere), $('t-permitir').nextElementSibling.nextElementSibling); // tras el título y su nota
    ['guia-android', 'guia-brave', 'guia-iphone', 'guia-pc'].forEach(function (id) {
      var g = $(id);
      g.classList.toggle('este', id === here);
      var h3 = g.querySelector('h3');
      h3.textContent = h3.textContent.replace(/ \(este dispositivo\)$/, '') + (id === here ? ' (este dispositivo)' : '');
    });
    var guias = $('guia-android').parentNode;
    guias.insertBefore($(here), $('guia-android').parentNode.querySelector('.guia'));
    if (isStandalone()) st.textContent = '✓ Ya la tienes instalada y abierta como app.';
    else if (self.isSecureContext === false) st.textContent = '✖ Esta dirección no es HTTPS ni «localhost»: así no se puede instalar ni usar sin conexión.';
    else st.textContent = 'Todavía no está instalada. Sigue los pasos de tu dispositivo.';
    $('btn-instalar-ya').hidden = !ui.installPrompt || isStandalone();
    var alm = $('inst-almacen');
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (p) {
        alm.textContent = p ? 'Almacenamiento: protegido (el navegador no lo borrará por falta de espacio).'
          : 'Almacenamiento: el navegador todavía no lo ha protegido; podría borrarlo si le falta espacio. Instalar la app ayuda.';
      }).catch(noop);
    }
  }

  /* ---------- Actualizaciones (H4) ---------- */
  function showUpdate(worker) {
    ui.waitingWorker = worker;
    $('update').hidden = false;
  }

  function applyUpdate() {
    var w = ui.waitingWorker || (ui.reg && ui.reg.waiting);
    if (!w) { $('update').hidden = true; return; }
    ui.updateRequested = true;
    $('btn-update').disabled = true;
    $('btn-update').textContent = 'Actualizando…';
    w.postMessage({ type: 'SKIP_WAITING' });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // Solo se recarga si el usuario pulsó «Actualizar» (evita bucles y recargas en la primera instalación).
      if (!ui.updateRequested || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(function (reg) {
      ui.reg = reg;
      // La versión nueva puede estar ya esperando, o instalándose desde antes de que cargara esta página.
      function track(w) {
        if (!w) return;
        if (w.state === 'installed') { if (navigator.serviceWorker.controller) showUpdate(w); return; }
        w.addEventListener('statechange', function () {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
        });
      }
      track(reg.waiting);
      track(reg.installing);
      reg.addEventListener('updatefound', function () { track(reg.installing); });
      return reg.update().catch(noop);
    }).catch(noop); /* Sin HTTPS/localhost no hay service worker: la app funciona mientras haya conexión. */
    if (self.caches && caches.keys) caches.keys().then(function (k) {
      var c = k.filter(function (n) { return n.indexOf('caducidades-') === 0; })[0];
      if (c) $('version').textContent += ' · caché ' + c.slice('caducidades-'.length);
    }).catch(noop);
  }

  /* ---------- Arranque ---------- */
  function scheduleMidnight() {
    clearTimeout(ui.midnightTimer);
    var n = new Date();
    var next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 5);
    ui.midnightTimer = setTimeout(function () { refresh(); maybeNotify(false); scheduleMidnight(); }, Math.max(1000, next - n));
  }

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { navigate(b.getAttribute('data-view')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
      b.addEventListener('click', function () { navigate(b.getAttribute('data-goto')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-close-error]'), function (b) {
      b.addEventListener('click', function () { var box = b.closest('.error-box'); box.hidden = true; });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-plus]'), function (b) {
      b.addEventListener('click', function () {
        $('f-expiry').value = L.addDays(L.todayYMD(), +b.getAttribute('data-plus'));
        revalidateField('expiry'); saveDraft();
      });
    });
    FIELDS.forEach(function (k) {
      var el = $('f-' + k);
      el.addEventListener('input', function () { revalidateField(k); saveDraft(); });
      el.addEventListener('change', function () { revalidateField(k); saveDraft(); });
    });
    $('form').addEventListener('submit', onSubmit);
    $('btn-cancelar').addEventListener('click', function () { resetForm(); navigate('lista'); });
    $('f-photo').addEventListener('change', onPhoto);
    $('f-photo-gal').addEventListener('change', onPhoto);
    $('btn-camara').addEventListener('click', function () { $('f-photo').click(); });
    $('btn-galeria').addEventListener('click', function () { $('f-photo-gal').click(); });
    $('btn-quitar-foto').addEventListener('click', function () {
      ui.photo = undefined; ui.removePhoto = true; $('f-photo').value = ''; $('f-photo-gal').value = ''; setFormPhoto(null); setPhotoError('');
    });
    $('f-barcode').addEventListener('change', onBarcodeChange);
    $('btn-scan').addEventListener('click', startScan);
    $('btn-scan-cerrar').addEventListener('click', function () { closeScanner(); $('btn-scan').focus(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('scanner').hidden) closeScanner(); });
    $('toast-undo').addEventListener('click', function () { if (ui.lastMarkedId) undo(ui.lastMarkedId); $('toast').hidden = true; });
    $('btn-notif').addEventListener('click', onActivate);
    $('btn-push-off').addEventListener('click', onDeactivate);
    $('btn-push-ayuda').addEventListener('click', function () {
      navigate('instalar');
      var t = $('t-permitir'); t.setAttribute('tabindex', '-1'); t.scrollIntoView({ block: 'start' }); t.focus({ preventScroll: true });
    });
    window.addEventListener('online', function () { pushSync(false, true); }); // al volver la conexión no se espera
    $('btn-notif-prueba').addEventListener('click', function () { maybeNotify(true); });
    $('btn-exportar').addEventListener('click', prepareExport);
    $('btn-compartir').addEventListener('click', shareExport);
    $('btn-descargar').addEventListener('click', downloadExport);
    $('btn-importar').addEventListener('click', function () { $('f-importar').click(); });
    $('f-importar').addEventListener('change', onImportFile);
    $('btn-imp-combinar').addEventListener('click', function () { doImport('combinar'); });
    $('btn-imp-sustituir').addEventListener('click', function () { doImport('sustituir'); });
    $('btn-imp-cancelar').addEventListener('click', function () { resetImport(); $('import-estado').textContent = 'Importación cancelada: no se ha cambiado nada.'; });
    $('btn-mas-hist').addEventListener('click', function () { ui.histShown += HIST_PAGE; refresh(); });
    $('btn-update').addEventListener('click', applyUpdate);
    $('btn-update-later').addEventListener('click', function () { $('update').hidden = true; });
    $('btn-instalar-ya').addEventListener('click', function () {
      var p = ui.installPrompt; if (!p) return;
      ui.installPrompt = null;
      p.prompt();
      Promise.resolve(p.userChoice).then(updateInstallUI, updateInstallUI);
    });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); ui.installPrompt = e; if (ui.view === 'instalar') updateInstallUI(); });
    window.addEventListener('appinstalled', function () { ui.installPrompt = null; updateInstallUI(); });
    window.addEventListener('popstate', onPopState);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        ui.pushFlushed = false;
        refresh(); maybeNotify(false);
        if (ui.reg) ui.reg.update().catch(noop);
      } else pushFlush();
    });
    window.addEventListener('pagehide', function (e) { pushFlush(); stopScan(e); });
    window.addEventListener('pageshow', function () { ui.pushFlushed = false; });
  }

  function start() {
    fillCategories();
    bind();
    restoreDraft();
    registerSW();
    initScanner();
    updateNotifUI();
    // Vista inicial. Si la página se recarga sobre una entrada propia (p. ej. #anadir), se respeta esa entrada
    // para que Atrás siga llevando a «Lista». Si no, el historial empieza en «Lista» y un enlace #vista se apila.
    var st = history.state || {};
    var initial = (location.hash || '').slice(1);
    if (st.depth && VIEWS.indexOf(st.view) > 0) {
      ui.pushed = true;
      setView(st.view, { noFocus: true });
      if (st.scanner) { try { history.back(); } catch (e) {} } // el visor de la cámara no sobrevive a una recarga
    } else {
      try { history.replaceState({ view: 'lista' }, '', baseUrl()); } catch (e) {}
      if (VIEWS.indexOf(initial) > 0) navigate(initial); else setView('lista', { noFocus: true });
    }
    self.CadDB.open().then(function (d) {
      db = d;
      return refresh();
    }).then(function () {
      maybeNotify(false);
      if (notifSupported() && Notification.permission === 'granted') registerPeriodic();
      scheduleMidnight();
    }).catch(function (e) {
      showError('Este navegador no deja guardar datos (' + friendly(e) + ') Si estás en modo privado o incógnito, ábrela en una ventana normal.');
    });
  }

  window.addEventListener('unhandledrejection', function (e) {
    showError('Ha fallado algo inesperado. ' + friendly(e.reason));
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
