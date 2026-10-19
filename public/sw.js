// claclaw 的 Service Worker：只负责推送通知 —— 收到推送就弹通知，点通知回到对应会话。
// 不做离线缓存（页面每次都要连本机服务，缓存旧页面只会添乱）。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

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
  e.waitUntil(Promise.all(jobs));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ('focus' in c) { c.postMessage({ t: 'open', url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
