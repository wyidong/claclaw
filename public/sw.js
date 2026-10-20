// claclaw 的 Service Worker：只负责推送通知 —— 收到推送就弹通知，点通知回到对应会话。
// 不做离线缓存（页面每次都要连本机服务，缓存旧页面只会添乱）。只有 Claw logo 例外，见下面。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// 例外：Claw 页的三个官方 logo（各家官网的公开地址）第一次取到就存下来，之后直接用缓存，离线也有
const LOGOS = ['https://claude.com/apple-touch-icon.png', 'https://openclaw.ai/apple-touch-icon.png', 'https://cdn.deepseek.com/chat/icon.png'];
self.addEventListener('fetch', e => {
  if (!LOGOS.includes(e.request.url)) return;
  e.respondWith(caches.open('claclaw-logos').then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()).catch(() => {});
    return r;
  }))));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  const jobs = [self.registration.showNotification(d.title || 'Claclaw', {
    body: d.body || '',
    tag: d.tag || 'claclaw',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: d.url || '/' },
  })];
  // 应用图标角标（Dock / 主屏幕）：未读总数；浏览器不支持就算了
  if (typeof d.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
    jobs.push((d.badge ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  // 告诉打开着的页面：推送到了，让它按服务器的未读表把角标再对一次（推送可能比「已读」晚到）
  jobs.push(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => list.forEach(c => c.postMessage({ t: 'pushed' }))));
  e.waitUntil(Promise.all(jobs));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  // 先把「要打开哪个会话」记到缓存里：iPhone 常常把后台的网页 App 直接丢掉、点通知时重新启动，
  // 光靠 postMessage 会丢；页面启动 / 回到前台时会来读这条记录
  const q = new URL(url, self.location.href).searchParams;
  const id = q.get('s'), view = q.get('view');   // view=peer：配对申请 → 协同页
  const remember = id || view ? caches.open('claclaw-nav').then(c => c.put('/__pending-open', new Response(JSON.stringify({ id, view, at: Date.now() })))).catch(() => {}) : Promise.resolve();
  e.waitUntil(remember.then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true })).then(list => {
    for (const c of list) {
      if ('focus' in c) { c.postMessage({ t: 'open', url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
