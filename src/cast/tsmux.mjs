// 把 YouTube HLS 的一段视频（MPEG-TS，只有 H.264）和对应的一段音频（packed audio：ID3 时间戳 + ADTS AAC）合成一段带声音的 TS
// YouTube 的音频、视频 HLS 分段一一对齐（段数、每段时长都一样），所以按段合就行，不用 ffmpeg。
// 做法：视频的 TS 包原样保留；PMT 换成「视频 + 音频」两路；每个 ADTS 帧打成一个 PES（带 PTS），切成 TS 包，按时间穿插在视频包之间
export const APID = 0x101;

const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; t[i] = c >>> 0; } return t; })();
export function crc32(b) { let c = 0xffffffff; for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]) >>> 0; return c >>> 0; }

function psiPacket(pid, table, cc) {
  const p = Buffer.alloc(188, 0xff), crc = crc32(table);
  p[0] = 0x47; p[1] = 0x40 | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10 | (cc & 0xf); p[4] = 0;
  table.copy(p, 5); p.writeUInt32BE(crc, 5 + table.length);
  return p;
}

function pmtTable(program, pcrPid, streams) {
  const es = Buffer.concat(streams.map(s => Buffer.concat([Buffer.from([s.type, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0 | (s.info.length >> 8), s.info.length & 0xff]), s.info])));
  const len = 9 + es.length + 4;
  return Buffer.concat([Buffer.from([0x02, 0xb0 | (len >> 8), len & 0xff, program >> 8, program & 0xff, 0xc1, 0, 0, 0xe0 | (pcrPid >> 8), pcrPid & 0xff, 0xf0, 0]), es]);
}

const ptsAt = (b, p) => (b[p] & 0x0e) * 536870912 + (b[p + 1] << 22) + ((b[p + 2] & 0xfe) << 14) + (b[p + 3] << 7) + (b[p + 4] >> 1);
function ptsBytes(pts) {
  const hi = Math.floor(pts / 1073741824) & 7, lo = pts % 1073741824;   // 33 位：最高 3 位单独放，低 30 位按位拆
  return Buffer.from([0x21 | (hi << 1), (lo >> 22) & 0xff, ((lo >> 14) & 0xfe) | 1, (lo >> 7) & 0xff, ((lo << 1) & 0xfe) | 1]);
}

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
// 音频分段 → [{pts, data}]，每个 ADTS 帧一个；起始时间在开头 ID3 标签的 com.apple.streaming.transportStreamTimestamp 里
export function parsePackedAudio(b) {
  let o = 0, base = 0;
  while (b.length - o >= 10 && b.toString('latin1', o, o + 3) === 'ID3') {
    const size = (b[o + 6] << 21) | (b[o + 7] << 14) | (b[o + 8] << 7) | b[o + 9], end = o + 10 + size;
    for (let p = o + 10; p + 10 <= end;) {
      const id = b.toString('latin1', p, p + 4), fs = b.readUInt32BE(p + 4);
      if (!fs) break;
      if (id === 'PRIV') {
        const body = b.subarray(p + 10, p + 10 + fs), z = body.indexOf(0);
        if (body.toString('latin1', 0, z) === 'com.apple.streaming.transportStreamTimestamp' && body.length >= z + 9) base = (body[z + 4] & 1) * 4294967296 + body.readUInt32BE(z + 5);
      }
      p += 10 + fs;
    }
    o = end;
  }
  const frames = [];
  for (let n = 0; o + 7 <= b.length;) {
    if (b[o] !== 0xff || (b[o + 1] & 0xf6) !== 0xf0) { o++; continue; }
    const len = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5), rate = RATES[(b[o + 2] >> 2) & 0xf];
    if (len < 7 || !rate || o + len > b.length) break;
    frames.push({ pts: Math.round(base + n * 1024 * 90000 / rate), data: b.subarray(o, o + len) });
    o += len; n++;
  }
  return frames;
}

function pesPackets(pid, pts, data, cc) {
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5]), ptsBytes(pts), data]);
  pes.writeUInt16BE(pes.length - 6, 4);
  const out = [];
  for (let o = 0; o < pes.length;) {
    const p = Buffer.alloc(188, 0xff), left = pes.length - o;
    p[0] = 0x47; p[1] = (o === 0 ? 0x40 : 0) | (pid >> 8); p[2] = pid & 0xff;
    if (left >= 184) { p[3] = 0x10 | (cc.n++ & 0xf); pes.copy(p, 4, o, o + 184); o += 184; }
    else {   // 最后一包不满：adaptation field 填充
      const stuff = 184 - left;
      p[3] = 0x30 | (cc.n++ & 0xf); p[4] = stuff - 1; if (stuff > 1) p[5] = 0;
      pes.copy(p, 4 + stuff, o); o = pes.length;
    }
    out.push(p);
  }
  return out;
}

// 视频 TS 段 + 音频 packed 段 → 合成的 TS 段。ccState 跨段传（音频 PID、PMT 的连续计数）
export function mux(video, audio, ccState = { a: { n: 0 }, pmt: { n: 0 } }) {
  const frames = parsePackedAudio(audio);
  let pmtPid = -1, program = 1, pcrPid = 0x100, vStreams = null, ai = 0;
  const out = [];
  const flush = upto => { while (ai < frames.length && (upto == null || frames[ai].pts <= upto)) { for (const p of pesPackets(APID, frames[ai].pts, frames[ai].data, ccState.a)) out.push(p); ai++; } };
  for (let o = 0; o + 188 <= video.length; o += 188) {
    const b = video.subarray(o, o + 188);
    if (b[0] !== 0x47) continue;
    const pid = ((b[1] & 0x1f) << 8) | b[2], pusi = b[1] & 0x40, afc = (b[3] >> 4) & 3;
    let p = 4; if (afc & 2) p += 1 + b[4];
    if (pid === 0) {
      if (pusi) { const q = p + 1 + b[p]; program = (b[q + 8] << 8) | b[q + 9]; pmtPid = ((b[q + 10] & 0x1f) << 8) | b[q + 11]; }
      out.push(b); continue;
    }
    if (pid === pmtPid) {
      if (!pusi) continue;
      if (!vStreams) {
        const q = p + 1 + b[p], len = ((b[q + 1] & 0xf) << 8) | b[q + 2], pil = ((b[q + 10] & 0xf) << 8) | b[q + 11], end = q + 3 + len - 4;
        pcrPid = ((b[q + 8] & 0x1f) << 8) | b[q + 9];
        vStreams = [];
        for (let r = q + 12 + pil; r + 5 <= end;) { const il = ((b[r + 3] & 0xf) << 8) | b[r + 4]; vStreams.push({ type: b[r], pid: ((b[r + 1] & 0x1f) << 8) | b[r + 2], info: Buffer.from(b.subarray(r + 5, r + 5 + il)) }); r += 5 + il; }
      }
      out.push(psiPacket(pmtPid, pmtTable(program, pcrPid, [...vStreams, { type: 0x0f, pid: APID, info: Buffer.alloc(0) }]), ccState.pmt.n++));
      continue;
    }
    // 视频 PES 开头：这一帧的 PTS 之前的音频帧先放进去
    if (pusi && afc & 1 && b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 1 && b[p + 7] & 0x80) flush(ptsAt(b, p + 9));
    out.push(b);
  }
  flush(null);
  return Buffer.concat(out);
}
