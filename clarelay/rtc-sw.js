// clarelay 直连（Service Worker 端）：由电脑端 clarelay 在 /_clarelay/sw.js 提供。宿主页面的 SW 里这样用：
//
//   try { importScripts('/_clarelay/sw.js'); } catch (e) {}       // 不是经 clarelay 打开时会 404，忽略
//   self.addEventListener('fetch', e => { if (self.clarelay && self.clarelay.handle(e)) return; ... });
//
// handle(event, match?)：同源 GET、match(url, request) 为真（默认：图片 / 视频 / 音频），且发起请求的页面当前是直连，
// 就把请求交给页面（页面的 rtc.js 经 DataChannel 取），一块块流回来；页面不在、不是直连、5 秒没回响应头 → 照常走网络（中继）。
(function () {
  'use strict';
  const routes = new Map();   // 页面（client id）→ { route, at }：页面每 20 秒、路线变化时报一次
  self.addEventListener('message', e => {
    const m = e.data;
    if (m && m.t === 'clarelay:route' && e.source) routes.set(e.source.id, { route: m.route, at: Date.now() });
  });
  const MEDIA = new Set(['image', 'video', 'audio', 'track']);
  const NULL_BODY = new Set([101, 103, 204, 205, 304]);

  function handle(event, match) {
    const req = event.request;
    if (req.method !== 'GET' || !event.clientId) return false;
    const u = new URL(req.url);
    if (u.origin !== self.location.origin || u.pathname.startsWith('/_clarelay/')) return false;
    if (!(match ? match(u, req) : MEDIA.has(req.destination))) return false;
    const r = routes.get(event.clientId);
    if (!r || r.route !== 'direct' || Date.now() - r.at > 60e3) return false;
    event.respondWith(viaPage(event.clientId, req).catch(() => fetch(req)));
    return true;
  }

  async function viaPage(clientId, req) {
    const client = await self.clients.get(clientId);
    if (!client) throw new Error('页面不在了');
    const ch = new MessageChannel(), port = ch.port1;
    const h = []; req.headers.forEach((v, k) => h.push([k, v]));
    return new Promise((resolve, reject) => {
      let ctrl = null, got = false;
      const t = setTimeout(() => { if (!got) { try { port.postMessage({ t: 'cancel' }); } catch (e) {} reject(new Error('页面没回')); } }, 5000);
      port.onmessage = e => {
        const m = e.data || {};
        if (!got && (m.t === 'nope' || m.t === 'error')) { clearTimeout(t); return reject(new Error(m.e || '页面不是直连')); }
        if (m.t === 'head') {
          got = true; clearTimeout(t);
          const body = NULL_BODY.has(m.s) ? null : new ReadableStream({ start(c) { ctrl = c; }, cancel() { try { port.postMessage({ t: 'cancel' }); } catch (e) {} } });
          resolve(new Response(body, { status: m.s >= 200 && m.s <= 599 ? m.s : 502, statusText: m.st || '', headers: m.h || [] }));
        } else if (m.t === 'chunk') { if (ctrl) try { ctrl.enqueue(new Uint8Array(m.b)); } catch (x) {} }
        else if (m.t === 'end') { if (ctrl) try { ctrl.close(); } catch (x) {} port.close(); }
        else if (m.t === 'error') { if (ctrl) try { ctrl.error(new TypeError(m.e || '直连中断')); } catch (x) {} port.close(); }
      };
      client.postMessage({ t: 'clarelay:fetch', url: req.url, headers: h }, [ch.port2]);
    });
  }
  self.clarelay = { handle };
})();
