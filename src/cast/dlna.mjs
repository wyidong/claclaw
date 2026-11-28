// DLNA / UPnP 投屏：在局域网里找电视（SSDP），用 AVTransport 让它播一个网址、暂停、跳转、停止
// 电视盒子上常常同时开着好几个接收端（系统自带的、腾讯视频、芒果 TV、乐播…），每个都是一台「设备」；
// 接收端的端口会变（App 重启后换端口），所以按 uuid 记，控制失败时重新找一遍
import dgram from 'node:dgram';
import os from 'node:os';

const SSDP = '239.255.255.250', ST_RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1', RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const VIRTUAL_IF = /\b(wsl|hyper-?v|virtualbox|vmware|vethernet|docker|loopback|bluetooth|tailscale|zerotier)\b|^(utun|bridge|awdl|llw)\d+$/i;   // 同 src/peer/peer.mjs

export function lanAddrs() {
  const out = [];
  for (const [ifn, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IF.test(ifn)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && PRIVATE_IP.test(a.address)) out.push(a.address);
  }
  return out;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (x, t) => { const m = new RegExp(`<(?:\\w+:)?${t}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${t}>`).exec(x); return m ? unesc(m[1].trim()) : ''; };

// 发 M-SEARCH，收各接收端的 LOCATION（按 uuid 去重）
function search(ms) {
  return new Promise(done => {
    const found = new Map(), socks = [];
    for (const ip of lanAddrs()) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socks.push(s);
      s.on('error', () => {});
      s.on('message', m => {
        const t = m.toString(), loc = /^LOCATION:\s*(\S+)/im.exec(t)?.[1], usn = /^USN:\s*(\S+)/im.exec(t)?.[1] || '';
        const id = /uuid:([^:\s]+)/i.exec(usn)?.[1];
        if (loc && id && /^https?:\/\//.test(loc) && !found.has(id)) found.set(id, { id, location: loc, local: ip });
      });
      s.bind(0, ip, () => {
        const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${ST_RENDERER}\r\n\r\n`);
        const send = () => s.send(msg, 1900, SSDP, () => {});
        try { s.setMulticastInterface(ip); } catch {}
        send(); setTimeout(send, 400);
      });
    }
    setTimeout(() => { for (const s of socks) try { s.close(); } catch {} done([...found.values()]); }, ms);
  });
}

async function describe(d) {
  const r = await fetch(d.location, { signal: AbortSignal.timeout(3000) });
  const x = await r.text();
  const base = tag(x, 'URLBase') || d.location;
  const svc = type => {
    for (const m of x.matchAll(/<(?:\w+:)?service>([\s\S]*?)<\/(?:\w+:)?service>/g)) if (tag(m[1], 'serviceType') === type) return new URL(tag(m[1], 'controlURL'), base).href;
    return '';
  };
  const avt = svc(AVT);
  if (!avt) return null;
  return { id: d.id, name: tag(x, 'friendlyName') || new URL(d.location).hostname, model: [tag(x, 'manufacturer'), tag(x, 'modelName')].filter(Boolean).join(' '), host: new URL(d.location).hostname, avt, rc: svc(RC), local: d.local };
}

let cache = { at: 0, list: [] };
export async function discover({ fresh = false, ms = 2500 } = {}) {
  if (!fresh && Date.now() - cache.at < 60000 && cache.list.length) return cache.list;
  const raw = await search(ms);
  const list = (await Promise.all(raw.map(d => describe(d).catch(() => null)))).filter(Boolean);
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  cache = { at: Date.now(), list };
  return list;
}
export const cached = id => cache.list.find(d => d.id === id);

export async function soap(url, service, action, args = {}) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">`
    + Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('') + `</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service}#${action}"` }, body, signal: AbortSignal.timeout(8000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`电视拒绝了 ${action}：` + (tag(t, 'errorDescription') || tag(t, 'faultstring') || 'HTTP ' + r.status));
  return t;
}

const hms = s => { s = Math.max(0, Math.round(s)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const secs = t => { const m = /^(\d+):(\d\d):(\d\d)/.exec(t || ''); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };

export function didl({ url, title, mime }) {
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1">`
    + `<dc:title>${esc(title || '视频')}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:${mime}:*">${esc(url)}</res></item></DIDL-Lite>`;
}

// 对一个接收端的操作
export const avt = {
  async load(d, { url, title, mime }) {
    try { await soap(d.avt, AVT, 'Stop', { InstanceID: 0 }); } catch {}   // 有的接收端正在播时不接新地址
    await soap(d.avt, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl({ url, title, mime }) });
    await soap(d.avt, AVT, 'Play', { InstanceID: 0, Speed: 1 });
  },
  play: d => soap(d.avt, AVT, 'Play', { InstanceID: 0, Speed: 1 }),
  pause: d => soap(d.avt, AVT, 'Pause', { InstanceID: 0 }),
  stop: d => soap(d.avt, AVT, 'Stop', { InstanceID: 0 }),
  seek: (d, s) => soap(d.avt, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(s) }),
  async state(d) {
    const [a, b] = await Promise.all([soap(d.avt, AVT, 'GetTransportInfo', { InstanceID: 0 }), soap(d.avt, AVT, 'GetPositionInfo', { InstanceID: 0 }).catch(() => '')]);
    return { state: tag(a, 'CurrentTransportState'), pos: secs(tag(b, 'RelTime')), dur: secs(tag(b, 'TrackDuration')), uri: tag(b, 'TrackURI') };
  },
};
