// 投屏：YouTube 音视频分段合成一路 TS、走代理取上游、DLNA 的 DIDL 转义
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mux, parsePackedAudio, crc32, APID } from '../src/cast/tsmux.mjs';
import { didl } from '../src/cast/dlna.mjs';
import { upstream, CASTABLE } from '../src/cast/cast.mjs';

// ---- 造测试数据：一段只有 H.264 的 TS（PAT + PMT + 两个视频 PES），一段 packed audio（ID3 时间戳 + 3 个 ADTS 帧）----
function tsPacket(pid, payload, { pusi = false, cc = 0 } = {}) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = (pusi ? 0x40 : 0) | (pid >> 8); p[2] = pid & 0xff;
  const stuff = 184 - payload.length;
  if (stuff > 0) { p[3] = 0x30 | cc; p[4] = stuff - 1; if (stuff > 1) p[5] = 0; payload.copy(p, 4 + stuff); }
  else { p[3] = 0x10 | cc; payload.copy(p, 4); }
  return p;
}
function psi(table) { const c = crc32(table), b = Buffer.alloc(table.length + 5); b[0] = 0; table.copy(b, 1); b.writeUInt32BE(c, 1 + table.length); return b; }
const PAT = psi(Buffer.from([0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | 0x0f, 0xff]));
const PMT = psi(Buffer.from([0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0, 0x1b, 0xe1, 0x00, 0xf0, 0]));
const pts5 = pts => { const hi = Math.floor(pts / 2 ** 30), lo = pts % 2 ** 30; return Buffer.from([0x21 | (hi << 1), (lo >> 22) & 0xff, ((lo >> 14) & 0xfe) | 1, (lo >> 7) & 0xff, ((lo << 1) & 0xfe) | 1]); };
const vpes = pts => Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]), pts5(pts), Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3])]);
const video = Buffer.concat([tsPacket(0, PAT, { pusi: true }), tsPacket(0xfff, PMT, { pusi: true }), tsPacket(0x100, vpes(900000), { pusi: true }), tsPacket(0x100, vpes(904000), { pusi: true, cc: 1 })]);
function adts(len) { const b = Buffer.alloc(len); b[0] = 0xff; b[1] = 0xf1; b[2] = (1 << 6) | (4 << 2); b[3] = 0x80 | ((len >> 11) & 3); b[4] = (len >> 3) & 0xff; b[5] = ((len & 7) << 5) | 0x1f; b[6] = 0xfc; return b; }
function packedAudio(pts, n) {
  const owner = Buffer.from('com.apple.streaming.transportStreamTimestamp\0', 'latin1'), ts = Buffer.alloc(8); ts.writeUInt32BE(Math.floor(pts / 2 ** 32), 0); ts.writeUInt32BE(pts % 2 ** 32, 4);
  const body = Buffer.concat([owner, ts]), frame = Buffer.concat([Buffer.from('PRIV'), Buffer.alloc(4), Buffer.from([0, 0]), body]); frame.writeUInt32BE(body.length, 4);
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), Buffer.from([0, 0, 0, frame.length]), frame]);
  return Buffer.concat([id3, ...Array.from({ length: n }, () => adts(200))]);
}

test('packed audio：读出 ID3 里的起始时间，按 44.1kHz 每帧 1024 个样本排 PTS', () => {
  const f = parsePackedAudio(packedAudio(898000, 3));
  assert.equal(f.length, 3);
  assert.deepEqual(f.map(x => x.pts), [898000, 898000 + 2090, 898000 + 4180]);
  assert.equal(f[0].data.length, 200);
});

test('合成：PMT 换成视频 + 音频两路（CRC 对），音频帧打成 PES、按时间插在视频前面', () => {
  const out = mux(video, packedAudio(898000, 3));
  assert.equal(out.length % 188, 0);
  const pk = []; for (let o = 0; o < out.length; o += 188) pk.push(out.subarray(o, o + 188));
  assert.ok(pk.every(p => p[0] === 0x47));
  const pid = p => ((p[1] & 0x1f) << 8) | p[2];
  const pmt = pk.find(p => pid(p) === 0xfff), t = pmt.subarray(5), len = ((t[1] & 0xf) << 8) | t[2];
  assert.equal(crc32(t.subarray(0, 3 + len - 4)), t.readUInt32BE(3 + len - 4));
  const es = t.subarray(12, 3 + len - 4);
  assert.deepEqual([es[0], ((es[1] & 0x1f) << 8) | es[2], es[5], ((es[6] & 0x1f) << 8) | es[7]], [0x1b, 0x100, 0x0f, APID]);
  const order = pk.map(pid).filter(p => p === 0x100 || p === APID);
  // 每个音频 PES 214 字节占两个包；898000 那帧在 900000 的视频前，900090、902180 两帧在 904000 的视频前
  assert.deepEqual(order, [APID, APID, 0x100, APID, APID, APID, APID, 0x100]);
  assert.equal(pk.filter(p => pid(p) === APID && p[1] & 0x40).length, 3);   // 三个音频 PES
  const cc = pk.filter(p => pid(p) === APID).map(p => p[3] & 0xf);
  assert.deepEqual(cc, cc.map((_, i) => i % 16));   // 连续计数
});

test('DIDL：标题和网址里的 & < > 转义', () => {
  const x = didl({ url: 'http://a/b?x=1&y=2', title: '<好戏>&', mime: 'video/mp4' });
  assert.match(x, /<dc:title>&lt;好戏&gt;&amp;<\/dc:title>/);
  assert.match(x, />http:\/\/a\/b\?x=1&amp;y=2<\/res>/);
});

test('能投屏的网址：YouTube、Dailymotion、Archive；NFB、B 站不行', () => {
  for (const u of ['https://www.youtube.com/watch?v=dTN7JhVLPJI', 'https://youtu.be/dTN7JhVLPJI', 'https://www.dailymotion.com/video/x4js048', 'https://archive.org/details/suddenly']) assert.ok(CASTABLE.test(u), u);
  for (const u of ['https://www.nfb.ca/film/x/', 'https://www.bilibili.com/video/BV1xx411c7mD']) assert.ok(!CASTABLE.test(u), u);
});

test('走代理取上游：HTTP CONNECT 隧道，跟着跳转走', async () => {
  const origin = http.createServer((req, res) => {
    if (req.url === '/a') { res.writeHead(302, { location: '/b' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok ' + req.url + ' ' + (req.headers.range || ''));
  });
  await new Promise(r => origin.listen(0, '127.0.0.1', r));
  const tunnels = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, sock) => { tunnels.push(req.url); const [h, p] = req.url.split(':'); const up = net.connect(+p, h, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(sock); sock.pipe(up); }); up.on('error', () => sock.destroy()); });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const op = origin.address().port;
  const r = await upstream(`http://127.0.0.1:${op}/a`, { proxy: 'http://127.0.0.1:' + proxy.address().port, headers: { range: 'bytes=0-9' } });
  let s = ''; for await (const c of r) s += c;
  assert.equal(r.statusCode, 200); assert.equal(s, 'ok /b bytes=0-9');
  assert.deepEqual(tunnels, [`127.0.0.1:${op}`, `127.0.0.1:${op}`]);
  origin.close(); proxy.close();
});
