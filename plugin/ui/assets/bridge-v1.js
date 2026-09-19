(function (global) {
  'use strict';
  const pending = new Map();
  const responseTypes = new Set(['config.load', 'config.save', 'config.test', 'plugin.status']);
  const fragment = new URLSearchParams(global.location.hash.slice(1));
  const token = fragment.get('bridge_token');
  const i18n = global.Sub2APIPluginI18n;
  const locale = i18n ? i18n.localeFromHash(global.location.hash) : 'zh';
  const text = function (key) { return i18n ? i18n.t(locale, key) : key; };
  let origin = '';
  let closed = false;
  let sequence = 0;
  try {
    const hostURL = new URL(global.document.referrer || global.location.href);
    if (hostURL.protocol === 'http:' || hostURL.protocol === 'https:') origin = hostURL.origin;
  } catch (_) { /* A malformed parent URL must fail closed. */ }

  function assertReady() {
    if (closed) throw new Error(text('bridgeClosed'));
    if (!token || !origin || global.parent === global) throw new Error(text('bridgeOpenFromHost'));
  }
  function send(type, payload) {
    assertReady();
    global.parent.postMessage(Object.assign({}, payload, {
      source: 'sub2api-plugin-ui', bridge_token: token, type: type
    }), origin);
  }
  function request(type, payload, timeoutMs) {
    if (!responseTypes.has(type)) return Promise.reject(new Error(text('bridgeUnsupported')));
    return new Promise(function (resolve, reject) {
      let id;
      try {
        assertReady();
        const bytes = new Uint32Array(4);
        global.crypto.getRandomValues(bytes);
        id = Array.from(bytes, function (n) { return n.toString(16); }).join('-') + '-' + (++sequence);
        const timer = global.setTimeout(function () {
          pending.delete(id);
          reject(new Error(text('bridgeTimeout')));
        }, timeoutMs || 20000);
        pending.set(id, { type: type, resolve: resolve, reject: reject, timer: timer });
        send(type, Object.assign({}, payload, { request_id: id }));
      } catch (error) {
        const item = pending.get(id);
        if (item) global.clearTimeout(item.timer);
        pending.delete(id);
        reject(error);
      }
    });
  }
  function onMessage(event) {
    if (closed || event.source !== global.parent || event.origin !== origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'sub2api-plugin-host' || data.bridge_token !== token || typeof data.request_id !== 'string') return;
    const item = pending.get(data.request_id);
    if (!item || data.type !== item.type + '.result') return;
    pending.delete(data.request_id);
    global.clearTimeout(item.timer);
    if (data.ok === true) item.resolve(data);
    else item.reject(new Error(text('bridgeFailed')));
  }
  function dispose() {
    if (closed) return;
    closed = true;
    global.removeEventListener('message', onMessage);
    global.removeEventListener('pagehide', dispose);
    pending.forEach(function (item) {
      global.clearTimeout(item.timer);
      item.reject(new Error(text('bridgeClosed')));
    });
    pending.clear();
  }
  global.addEventListener('message', onMessage);
  global.addEventListener('pagehide', dispose);
  global.Sub2APIPluginBridge = Object.freeze({
    load: function () { return request('config.load'); },
    save: function (config) { return request('config.save', { config: config }, 120000); },
    test: function () { return request('config.test', {}, 120000); },
    status: function () { return request('plugin.status'); },
    ready: function () { send('sub2api.plugin.ready'); },
    resize: function (height) { if (Number.isFinite(height)) send('ui.resize', { height: Math.max(520, Math.min(960, Math.round(height))) }); },
    dispose: dispose
  });
})(window);
