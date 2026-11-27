/* Caducidades - configuración. Script clásico (página y service worker).
 * pushServerUrl: dirección del servidor de avisos con la app cerrada (Web Push). VACÍA = sin servidor:
 * la app funciona como la 0.1.2 (aviso al abrirla). Para la versión publicada se rellena al construir:
 *   node tools/build-web.mjs --push-url <dirección del servidor> --out <carpeta>
 * (eso también añade el origen del servidor a la CSP de index.html). No hace falta tocar este archivo. */
self.CAD_CONFIG = { pushServerUrl: 'https://caducidades-avisos.caducidades-avisos.workers.dev' };
