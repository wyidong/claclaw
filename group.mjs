// 群聊：几个会话（本机任意 Claw 的、协同对方开放的）在一个群里，@ 谁谁回一轮，回复贴回群里。
// 这里只管数据和规则（存储、@ 解析、带上下文、跳数、排队重试、镜像），投递和跨电脑收发由 server 注入：
//   deliver(member, text, {asUser, groupId, groupName, from}) → {ok, reply} | {busy} | {accepted, msgId} | {ok:false, error}
//   peerOp(peerId, body)：发到协同对方的 /group（sync / post / dissolve）
// 群的主体在建群的电脑上；拉了协同会话的群，在对方电脑上有一份镜像（mirror），镜像里发的消息转回主群处理。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOPS = 5, INLINE = 400, CUR_MAX = 1500, KEEP = 500, SNAP = 200, LOG_MAX = 4e6, ATT_MAX = 12 * 1024 * 1024, ATT_CHUNK = 512 * 1024;
export const isGroupId = id => /^gp:[0-9a-f]{8}$/.test(String(id || ''));
export const toWire = id => 'gp-' + String(id).slice(3);   // 对方会把 from_session 里 [\w-] 以外的字符去掉
export const fromWire = s => /^gp-[0-9a-f]{8}$/.test(String(s || '')) ? 'gp:' + String(s).slice(3) : null;

// 成员名（@ 用）：标题压空格、截 16 字；重名加序号
export function memberNames(members, taken = new Set()) {
  return members.map(m => {
    const base = Array.from(String(m.title || '').replace(/\s+/g, ' ').trim().replace(/@/g, '')).slice(0, 16).join('') || '会话';
    let name = base;
    for (let n = 2; taken.has(name); n++) name = base + n;
    taken.add(name);
    return { ...m, name };
  });
}
const memberKey = m => (m.peerId ? m.peerId + '/' : '') + m.id;
const memberRec = m => ({ key: memberKey(m), id: m.id, peerId: m.peerId || undefined, peerName: m.peerName || undefined, title: m.title || '', claw: m.claw || '' });

// 文字里 @ 了谁（key 列表，按出现顺序去重）；@全体 / @all = 全部。长名先匹配，短名不会误中长名的一部分
export function parseMentions(text, members) {
  let t = String(text || '');
  const hits = [];
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const at = '@' + m.name;
    let i = t.indexOf(at);
    if (i < 0) continue;
    hits.push([i, m.key]);
    while (i >= 0) { t = t.slice(0, i) + '\u0000'.repeat(at.length) + t.slice(i + at.length); i = t.indexOf(at); }
  }
  if (/@(全体|所有人|all)(?![\w])/i.test(t)) return members.map(m => m.key);   // 成员名已经先换掉了：「@全体项目」不算 @全体
  return [...new Set(hits.sort((a, b) => a[0] - b[0]).map(h => h[1]))];
}

const speaker = (it, members) => it.kind === 'user' ? '用户' + (it.via ? '（在 ' + it.via + ' 上）' : '') : it.kind === 'sys' ? '（群通知）'
  : ((it.who && typeof it.who === 'object' ? it.who.name : members.find(m => m.key === it.who)?.name) || '成员');
const cut = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
const pad = n => String(n).padStart(2, '0');
const stamp = t => { const d = new Date(t); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
// 群记录文件里的一条：「#序号 时间 谁：内容」，成员要前文自己去读
export const logLine = (it, members, dir) => '#' + it.seq + ' ' + stamp(it.at || Date.now()) + ' ' + speaker(it, members) + '：' + withAtt(it, dir) + '\n';
// 附件（图片 / 文件）：存在群记录目录的 files/<群>/<aid> 里；aid = 16 位十六进制 + 扩展名
export const isAid = s => /^[0-9a-f]{16}(\.[a-z0-9]{1,8})?$/.test(String(s || ''));
const ATT_KIND = { image: '图片', video: '视频', file: '文件' };
export const cleanAtt = a => Array.isArray(a) ? a.filter(x => x && isAid(x.aid)).slice(0, 10).map(x => ({ aid: x.aid, kind: ATT_KIND[x.kind] ? x.kind : 'file', name: String(x.name || '').replace(/[\r\n「」\]]/g, ' ').slice(0, 80), size: Number.isFinite(x.size) ? x.size : 0 })) : undefined;
export const attKind = name => /\.(png|jpe?g|gif|webp)$/i.test(name || '') ? 'image' : /\.(mp4|mov|m4v|webm)$/i.test(name || '') ? 'video' : 'file';
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
// 一条的附件写成文字：dir 给了就带上本机路径（成员要看就去读）
export const attText = (it, dir) => (it.att || []).map(a => '[' + ATT_KIND[a.kind] + '「' + (a.name || a.aid) + '」 ' + fmtSize(a.size) + (dir ? '：' + path.join(dir, a.aid) : '') + ']').join(' ');
const withAtt = (it, dir) => { const t = String(it.text || ''), a = attText(it, dir); return a ? (t ? t + '\n' : '') + a : t; };
const LOG_HEAD = '# 群聊记录：每条以「#序号 时间 谁：」开头，新的在后面（只读需要的部分，比如最后几十行）\n';

// 发给某个成员的正文：本条（太长截断）+ 它上次之后别人说的。别人说的很短就直接带上，长了只说有几条、谁说的，要前文让它去读群记录
// dir：本条附件在本机的目录（协同成员不给，由它那边收到后补上自己的路径）
export function composeDelivery({ items, since, upto, selfKey, members, current, dir }) {
  const t = String(current.text || ''), a = attText(current, dir);
  const cur = '#' + current.seq + ' ' + speaker(current, members) + '：' + (t.length > CUR_MAX ? t.slice(0, CUR_MAX) + '…（太长，全文看群记录 #' + current.seq + '）' : t) + (a ? (t ? '\n' : '') + a + (dir ? '（附件要看内容再读，不需要就不用管）' : '') : '');
  const un = items.filter(i => i.seq > since && i.seq < upto && i.kind !== 'sys' && i.who !== selfKey);
  if (!un.length) return cur;
  const full = un.map(i => '#' + i.seq + ' ' + speaker(i, members) + '：' + withAtt(i)).join('\n');
  if (full.length <= INLINE) return '[群里你上次之后的消息]\n' + full + '\n[这一条]\n' + cur;
  const cnt = new Map(); for (const i of un) { const k = speaker(i, members); cnt.set(k, (cnt.get(k) || 0) + 1); }
  return '[群里你上次之后还有 ' + un.length + ' 条（#' + un[0].seq + '～#' + un[un.length - 1].seq + '，' + [...cnt].map(([k, n]) => k + ' ' + n + ' 条').join('、') + '）没贴过来，要前文就读群记录]\n[这一条]\n' + cur;
}

class Group {
  constructor(store, d) {
    this.store = store;
    Object.assign(this, { name: '', created: Date.now(), members: [], items: [], seen: {}, pending: {}, seqMax: 0, mirror: null, status: {}, host: '' }, d);
    this.subs = new Set(); this.q = {}; this.running = {}; this.closed = false; this.perms = new Map();   // perms：本机成员这一轮在等的确认（只在内存）
    this.busy = false; this.queue = [];
  }
  get title() { return this.mirror ? (this.mirrorTitle || this.name || '群聊') : this.name || cut(this.members.map(m => m.name).join('、'), 24) || '群聊'; }
  // 主理人：用户发的消息没 @ 任何人时由它接（镜像里看成员的 host 标记）
  get hostName() { return (this.mirror ? this.members.find(m => m.host) : this.members.find(m => m.key === this.host))?.name || ''; }
  get lastAt() { const a = this.items.length ? this.items[this.items.length - 1].at : this.created; return Number.isFinite(a) ? a : 0; }
  // 给 ws 用：和各 Claw 的会话进程同样的接口
  subscribe(ws) { this.subs.add(ws); }
  unsubscribe(ws) { this.subs.delete(ws); }
  watched() { return [...this.subs].some(ws => ws.visible !== false); }
  emit(o) { const s = JSON.stringify(o); for (const ws of this.subs) if (ws.readyState === 1) ws.send(s); }
  send(text, att) { return this.store.post(this.id, text, { att }); }
  async interrupt() {}
  // 在群里点了允许 / 拒绝：交给那个成员会话（只有本机成员的确认会出现在本机的群里）
  replyPermission(requestId, decision, answers) { const p = this.perms.get(requestId); if (p) this.store.permReply(p.sid, requestId, decision, answers); }
  pendingPerms() { return [...this.perms.values()].map(p => p.req); }
  view(it, viewer) {
    if (this.mirror) return it;
    const m = it.who && this.members.find(x => x.key === it.who);
    return { seq: it.seq, at: it.at, kind: it.kind, text: it.text, att: it.att, via: it.via, who: m ? memberView(m, viewer) : undefined };
  }
  history() { return { items: this.items.map(it => this.view(it)), total: this.items.length }; }
  statusView() { return this.mirror ? (this.status || []) : Object.entries(this.status).map(([k, text]) => ({ name: this.members.find(m => m.key === k)?.name || '', text })); }
  membersView(viewer) { return this.mirror ? this.members : this.members.map(m => ({ ...memberView(m, viewer), host: m.key === this.host || undefined })); }
  preview() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.view(this.items[i]);
      if (it.kind !== 'sys') return (it.kind === 'user' ? '我' : it.who?.name || '成员') + '：' + withAtt(it).replace(/\s+/g, ' ').slice(0, 40);
    }
    return '';
  }
  peers() { return [...new Set(this.members.map(m => m.peerId).filter(Boolean))]; }
  toJSON() { const { name, created, members, items, seen, pending, seqMax, mirror, mirrorTitle, id, host } = this; return { id, name, created, members, items, seen, pending, seqMax, mirror, mirrorTitle, host: host || undefined, status: this.mirror ? this.status : undefined }; }
}
// viewer：给哪台电脑看（undefined = 本机）；collab = 对看的人来说是不是别的电脑上的会话
const memberView = (m, viewer) => ({ name: m.name, claw: m.claw || '', collab: viewer === undefined ? !!m.peerId : m.peerId !== viewer, peer: m.peerName || undefined });

export class Groups {
  // logDir：群记录文件（给成员会话读的纯文本）放这里；不要放在数据目录里，那里对协同那一轮算敏感位置
  constructor({ dir, logDir = path.join(dir, 'logs'), log = () => {}, deliver, peerOp = async () => ({}), onItem = () => {}, permReply = () => {}, retryMs = 20000, retryFor = 30 * 60e3, syncDelay = 300 }) {
    Object.assign(this, { dir, logDir, log, deliver, peerOp, onItem, permReply, retryMs, retryFor, syncDelay });
    this.map = new Map(); this.syncT = new Map();
    // 正在发给协同成员、还没等到对方回话（202 / 回复）的：`群id|编号` → { key, depth, peerId, answered }。
    // 对方可能在我们这边还等着 202 时就把回复发来了（不装 claclaw 的对方常这样），这时也要认
    this.inflight = new Map();
    // 群记录和附件只给自己看：目录 0700（里面的文件靠目录挡住，已有的目录也收紧）
    for (const d of [dir, logDir]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} }
    // 解散过的群（墓碑，留 30 天）：之后晚到的同步、消息、回复一律不收，镜像不会被「复活」
    this.goneFile = path.join(dir, 'gone.json');
    try { this.gone = JSON.parse(fs.readFileSync(this.goneFile, 'utf8')) || {}; } catch { this.gone = {}; }
    for (const [k, t] of Object.entries(this.gone)) if (Date.now() - t > 30 * 864e5) delete this.gone[k];
    for (const f of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{8}\.json$/.test(f)) continue;
      try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (isGroupId(d.id)) this.map.set(d.id, new Group(this, d)); } catch {}
    }
    for (const g of this.map.values()) if (!fs.existsSync(this.logFile(g.id))) this.writeLog(g);
  }
  attDir(id) { return isGroupId(id) ? path.join(this.logDir, 'files', id.slice(3)) : null; }
  attFile(id, aid) { return isAid(aid) ? path.join(this.attDir(id), aid) : null; }
  // 存一个附件：buf（图片）或 src（已上传的文件，拷过来）；返回附件记录
  saveAtt(id, { kind, name, ext, buf, src }) {
    const e = String(ext || path.extname(name || '').slice(1)).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const aid = crypto.randomBytes(8).toString('hex') + (e ? '.' + e : '');
    fs.mkdirSync(this.attDir(id), { recursive: true });
    const f = path.join(this.attDir(id), aid);
    if (buf) fs.writeFileSync(f, buf); else fs.copyFileSync(src, f);
    return cleanAtt([{ aid, kind, name, size: fs.statSync(f).size }])[0];
  }
  // 附件在本机吗；不在就从 peerId（有这个附件的那台）分段拉过来
  async fetchAtt(id, peerId, a) {
    const f = this.attFile(id, a?.aid);
    if (!f) throw new Error('附件编号不对');
    if (fs.existsSync(f)) return f;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.part' + crypto.randomBytes(3).toString('hex');
    try {
      for (let off = 0; ;) {
        const j = await this.peerOp(peerId, { op: 'attget', id: toWire(id), aid: a.aid, off });
        if (!j?.ok || typeof j.data !== 'string') throw new Error(j?.error || '对方没给');
        const buf = Buffer.from(j.data, 'base64');
        fs.appendFileSync(tmp, buf); off += buf.length;
        if (off > ATT_MAX) throw new Error('附件太大');
        if (j.done || !buf.length) break;
      }
      fs.renameSync(tmp, f);
      return f;
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }
  // 对方来拉附件：只给这个群的另一边（主群给有成员的对方，镜像只给主群）
  attChunk(id, peerId, aid, off) {
    const g = this.get(id), f = this.attFile(id, aid);
    if (!g || !f || !(g.mirror ? g.mirror.peerId === peerId : g.peers().includes(peerId))) return { ok: false, error: '没有这个附件' };
    let st; try { st = fs.statSync(f); } catch { return { ok: false, error: '没有这个附件' }; }
    off = Math.max(0, Math.floor(Number(off) || 0));
    const fd = fs.openSync(f, 'r'), buf = Buffer.alloc(Math.max(0, Math.min(ATT_CHUNK, st.size - off)));
    try { fs.readSync(fd, buf, 0, buf.length, off); } finally { fs.closeSync(fd); }
    return { ok: true, data: buf.toString('base64'), done: off + buf.length >= st.size };
  }
  logFile(id) { return isGroupId(id) ? path.join(this.logDir, id.slice(3) + '.md') : null; }
  writeLog(g) { try { fs.writeFileSync(this.logFile(g.id), LOG_HEAD + g.items.map(it => logLine(it, g.members, this.attDir(g.id))).join('')); } catch (e) { this.log('group log', e.message); } }
  appendLog(g, its) {
    if (g.closed || !its.length) return;
    const f = this.logFile(g.id);
    try { if (fs.statSync(f).size > LOG_MAX) return this.writeLog(g); fs.appendFileSync(f, its.map(it => logLine(it, g.members, this.attDir(g.id))).join('')); } catch { this.writeLog(g); }
  }
  get(id) { return this.map.get(id) || null; }
  list() { return [...this.map.values()]; }
  save(g) { if (g.closed) return; const f = path.join(this.dir, g.id.slice(3) + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(g)); fs.renameSync(f + '.tmp', f); }

  // members：[{id, peerId?, peerName?, title, claw}]
  create({ name, members, host }) {
    const seen = new Set(), ms = [];
    for (const m of members || []) {
      if (!m.id || seen.has(memberKey(m))) continue;
      seen.add(memberKey(m)); ms.push(memberRec(m));
    }
    if (ms.length < 2) throw new Error('至少选 2 个会话');
    let id; do id = 'gp:' + crypto.randomBytes(4).toString('hex'); while (this.map.has(id));
    const g = new Group(this, { id, name: String(name || '').trim().slice(0, 40), members: memberNames(ms), host: ms.some(m => m.key === host) ? host : '' });
    this.map.set(id, g); this.save(g); this.syncOut(g);
    this.log('group create', id, ms.length + ' members');
    return g;
  }

  // 改群名 / 加减成员（只在建群的电脑上改）：老成员名字不变，新成员名字不和现有的撞；被移出的对方不再有成员就让它删掉镜像
  // host：主理人的成员 key（'' = 不设）
  edit(id, { name, members, host } = {}) {
    const g = this.get(id);
    if (!g) throw new Error('这个群已经解散了');
    if (g.mirror) throw new Error('群名和成员只能在建群的电脑上改');
    const notes = [];
    let list = null;
    if (Array.isArray(members)) {
      const seen = new Set(); list = [];
      for (const m of members) { if (!m?.id || seen.has(memberKey(m))) continue; seen.add(memberKey(m)); list.push(g.members.find(x => x.key === memberKey(m)) || memberRec(m)); }
      if (list.length < 2) throw new Error('群里至少要有 2 个会话');
    }
    if (typeof name === 'string' && name.trim().slice(0, 40) !== g.name) {
      g.name = name.trim().slice(0, 40);
      notes.push(g.name ? '群名改成「' + g.name + '」' : '群名改回默认（成员名）');
    }
    if (list) {
      const keep = list.filter(m => m.name), fresh = list.filter(m => !m.name);
      const named = memberNames(fresh, new Set(keep.map(m => m.name)));
      const out = list.map(m => m.name ? m : named[fresh.indexOf(m)]);
      const removed = g.members.filter(m => !out.some(x => x.key === m.key));
      const oldPeers = g.peers();
      g.members = out;
      for (const m of removed) { delete g.q[m.key]; delete g.seen[m.key]; delete g.status[m.key]; }
      if (named.length) notes.push('把 ' + named.map(m => m.name).join('、') + ' 加进群');
      if (removed.length) notes.push('把 ' + removed.map(m => m.name).join('、') + ' 移出群');
      for (const pid of oldPeers) if (!g.peers().includes(pid)) this.peerOp(pid, { op: 'dissolve', id: toWire(id) }).catch(e => this.log('group dissolve', pid, e.message));
      if (g.host && !out.some(m => m.key === g.host)) { g.host = ''; if (host === undefined) notes.push('主理人被移出群，现在没有主理人'); }
    }
    if (typeof host === 'string') {
      const h = host ? g.members.find(m => m.key === host) : null;
      if (host && !h) throw new Error('主理人得是群里的成员');
      if ((h?.key || '') !== g.host) { g.host = h?.key || ''; notes.push(h ? '设「' + h.name + '」为主理人（没 @ 人的消息由它接）' : '取消了主理人'); }
    }
    this.save(g);
    g.emit({ t: 'group.meta', id, title: g.title, members: g.membersView() });
    for (const n of notes) this.add(g, { kind: 'sys', text: n });
    if (!notes.length) this.syncOut(g);
    return g;
  }

  // 用户在群里发一条（via：在哪台对方电脑上发的，经协同转来）；镜像里发的转回主群
  post(id, text, { via, att } = {}) {
    const g = this.get(id); text = String(text || '').trim(); att = cleanAtt(att);
    if (!att?.length) att = undefined;
    if (!g || (!text && !att)) return false;
    if (g.mirror) {   // 镜像：转给建群的电脑，它收下后会随快照回来；没送到就告诉页面（输入框放回原文）
      const fail = why => g.emit({ t: 'group.msg', id, item: { kind: 'sys', fail: true, text: '没发到建群的电脑：' + why } });
      this.peerOp(g.mirror.peerId, { op: 'post', id: toWire(id), text, ...(att ? { att } : {}) }).then(j => { if (!j?.ok) fail(j?.error || '对方没收下'); }, e => { this.log('group post fwd', e.message); fail(e.message); });
      return true;
    }
    const it = this.add(g, { kind: 'user', text: text.slice(0, 8000), att, via: via || undefined, depth: 0 });
    this.route(g, it);
    return true;
  }
  // 协同对方（镜像那边）发来的：只收群里有它的会话的对方
  // 镜像那边带附件发的：先把附件拉过来再贴进群
  async peerPost(id, peerId, text, via, att) {
    const g = this.get(id);
    if (!g || g.mirror || !g.peers().includes(peerId)) return false;
    att = cleanAtt(att);
    for (const a of att || []) await this.fetchAtt(id, peerId, a);
    return this.post(id, text, { via, att });
  }
  // 本机这个群是不是对方 peerId 那边建的群的镜像（对方发来的群投递，只有这时才按群消息处理）
  isMirrorOf(id, peerId) { return this.get(id)?.mirror?.peerId === peerId; }

  add(g, it) {
    it = { seq: ++g.seqMax, at: Date.now(), ...it };
    g.items.push(it);
    if (g.items.length > KEEP) g.items.splice(0, g.items.length - KEEP);
    this.save(g); this.appendLog(g, [it]);
    g.emit({ t: 'group.msg', id: g.id, item: g.view(it) });
    try { this.onItem(g, it); } catch {}
    this.syncOut(g);
    return it;
  }
  setStatus(g, key, text) {
    if (text) g.status[key] = text; else delete g.status[key];
    g.emit({ t: 'group.status', id: g.id, status: g.statusView() });
    this.syncOut(g);
  }

  route(g, it) {
    if (it.kind === 'sys') return;
    let targets = parseMentions(it.text, g.members).filter(k => k !== it.who);
    if (!targets.length && it.kind === 'user' && g.members.some(m => m.key === g.host)) targets = [g.host];   // 用户没 @ 人：主理人接
    if (!targets.length) return;
    if (it.kind === 'gm' && it.depth > HOPS) {
      this.add(g, { kind: 'sys', text: '已到转发上限（成员之间最多连着转 ' + HOPS + ' 次），没有转给 ' + targets.map(k => g.members.find(m => m.key === k)?.name).join('、') });
      return;
    }
    for (const key of targets) {
      (g.q[key] ||= []).push({ trigger: it.seq, depth: it.depth || 0, asUser: it.kind === 'user' && !it.via, firstAt: Date.now() });
      this.pump(g, key);
    }
  }
  pump(g, key) {
    if (g.running[key] || !g.q[key]?.length || g.closed) return;
    g.running[key] = true;
    const job = g.q[key].shift();
    this.run(g, key, job).catch(e => this.log('group run', e.message)).finally(() => { g.running[key] = false; this.pump(g, key); });
  }
  async run(g, key, job) {
    const m = g.members.find(x => x.key === key), trig = g.items.find(x => x.seq === job.trigger);
    if (!m || !trig) return;
    const text = composeDelivery({ items: g.items, since: g.seen[key] || 0, upto: job.trigger, selfKey: key, members: g.members, current: trig, dir: m.peerId ? undefined : this.attDir(g.id) });
    for (;;) {
      this.setStatus(g, key, '正在回复…');
      let r;
      job.msgId ||= crypto.randomUUID();   // 重试用同一个编号：对方据此去重，不会把同一条处理两遍
      const fk = m.peerId ? g.id + '|' + job.msgId : '';
      if (fk) this.inflight.set(fk, { key, depth: job.depth + 1, peerId: m.peerId });
      try { r = await this.deliver(m, text, { att: m.peerId ? trig.att : undefined, host: key === g.host, asUser: job.asUser, groupId: g.id, groupName: g.title, from: speaker(trig, g.members), msgId: job.msgId }); }
      catch (e) { r = { ok: false, error: e.message }; }
      const early = fk && this.inflight.get(fk)?.answered;
      if (fk) this.inflight.delete(fk);
      if (g.closed) return;
      if (early) { g.seen[key] = Math.max(g.seen[key] || 0, job.trigger); this.save(g); return; }   // 回复已经先到、贴过了
      if (r?.busy) {
        if (Date.now() - job.firstAt >= this.retryFor) { this.setStatus(g, key, ''); this.add(g, { kind: 'sys', text: '「' + m.name + '」一直在忙，这条没送到' }); return; }
        this.setStatus(g, key, r.offline ? '连不上，排队重试中' : '在忙，排队中');
        await new Promise(res => setTimeout(res, this.retryMs));
        if (g.closed) return;
        continue;
      }
      if (r?.accepted) {
        g.seen[key] = Math.max(g.seen[key] || 0, job.trigger);
        g.pending[r.msgId] = { key, depth: job.depth + 1, peerId: m.peerId, at: Date.now(), ...(r.msgId !== job.msgId ? { alt: job.msgId } : {}) };   // 对方回的编号和我们发的不同：两个都认
        this.save(g); this.setStatus(g, key, '已收到，回复稍后到');
        return;
      }
      this.setStatus(g, key, '');
      if (r?.ok) {
        g.seen[key] = Math.max(g.seen[key] || 0, job.trigger);
        const att = cleanAtt(r.att);
        const it = this.add(g, { kind: 'gm', who: key, text: String(r.reply || (att?.length ? '' : '（这一轮没有文字回复）')).slice(0, 20000), att: att?.length ? att : undefined, depth: job.depth + 1 });
        g.seen[key] = it.seq; this.save(g);
        this.route(g, it);
      } else this.add(g, { kind: 'sys', text: '「' + m.name + '」没收到：' + (r?.error || '未知错误') });
      return;
    }
  }

  // 本机成员处理群消息时要确认：群里也弹出来（标上是谁），在群里就能点；主群顺带把这个成员的状态改成「等你确认」，镜像告诉主群
  permOpen(id, sid, name, req) {
    const g = this.get(id);
    if (!g || g.perms.has(req.requestId)) return;
    const r = { ...req, who: name || undefined, sessionId: id };
    g.perms.set(req.requestId, { sid, req: r });
    g.emit(r);
    this.permStatus(g, sid, true);
  }
  permClose(id, requestId, ev) {
    const g = this.get(id), p = g?.perms.get(requestId);
    if (!p) return;
    g.perms.delete(requestId);
    g.emit({ ...ev, sessionId: id });
    if (![...g.perms.values()].some(x => x.sid === p.sid)) this.permStatus(g, p.sid, false);
  }
  // 这个会话这一轮结束了：还挂着的确认都撤掉
  permEnd(id, sid) { const g = this.get(id); for (const [rid, p] of g?.perms || []) if (p.sid === sid) this.permClose(id, rid, { t: 'perm.cancel', requestId: rid, toolUseID: p.req.toolUseID }); }
  permStatus(g, sid, on) {
    if (g.mirror) { this.peerOp(g.mirror.peerId, { op: 'permstat', id: toWire(g.id), sid, on }).catch(e => this.log('group permstat', e.message)); return; }
    const m = g.members.find(x => !x.peerId && x.id === sid);
    if (m && g.running[m.key]) this.setStatus(g, m.key, on ? '等你确认' : '正在回复…');
  }
  // 镜像那边（peerId）的成员在等确认：主群里显示它在哪台电脑上等
  peerPermStatus(id, peerId, peerName, sid, on) {
    const g = this.get(id); sid = String(sid || '').toLowerCase();
    if (!g || g.mirror || !sid) return false;
    const m = g.members.find(x => x.peerId === peerId && sid.startsWith(String(x.id).toLowerCase()));
    if (!m) return false;
    if (on) this.setStatus(g, m.key, '等你在 ' + (peerName || '对方') + ' 上确认');
    else if (/^等你在/.test(g.status[m.key] || '')) this.setStatus(g, m.key, g.running[m.key] ? '正在回复…' : '已收到，回复稍后到');
    return true;
  }

  // 协同成员发到群（gp-…）的消息：
  // - 回复：编号来自 reply_to 或正文开头「回复 <编号>」；只收自己发过、同一个对方的编号，一个编号只收一次。
  //   我们还在等对方 202 时回复就先到了，也认（inflight）。没写编号、这个对方又正好只有一条在等回复：就当是它的回复
  // - 没写编号、也没有在等的回复：当成这个对方的成员在群里主动说话（@ 谁照样转给谁）。写了编号却对不上：不收
  // att：附件（在对方那台上），先拉过来再贴
  remoteReply(id, peerId, replyTo, text, att, fromSession) {
    const g = this.get(id);
    if (!g || g.mirror || !g.peers().includes(peerId)) return false;
    const rid = String(replyTo || '') || (String(text || '').match(/^回复 (\S+)/) || [])[1] || '';
    const mine = Object.entries(g.pending).filter(([, x]) => x.peerId === peerId);
    const fl = [...this.inflight].filter(([k, x]) => k.startsWith(id + '|') && x.peerId === peerId && !x.answered);
    let p = null;
    if (rid) {
      const hit = mine.find(([k, x]) => k === rid || x.alt === rid);
      if (hit) { p = hit[1]; delete g.pending[hit[0]]; }
      else { const f = this.inflight.get(id + '|' + rid); if (f && f.peerId === peerId && !f.answered) { f.answered = true; p = f; } }
      if (!p) return false;
    } else if (mine.length + fl.length === 1) {
      if (mine.length) { p = mine[0][1]; delete g.pending[mine[0][0]]; } else { p = fl[0][1]; p.answered = true; }
    } else {
      const ms = g.members.filter(x => x.peerId === peerId), fsid = String(fromSession || '').toLowerCase();
      const m = (fsid && ms.find(x => { const k = String(x.id).toLowerCase(); return k.startsWith(fsid) || fsid.startsWith(k); })) || (ms.length === 1 ? ms[0] : null);
      if (!m) return false;
      p = { key: m.key, depth: 1 };
    }
    this.save(g);
    att = cleanAtt(att);
    (async () => {
      let note = '';
      if (att?.length) { this.setStatus(g, p.key, '正在传附件…'); try { for (const a of att) await this.fetchAtt(id, peerId, a); } catch (e) { note = '\n（附件没传过来：' + e.message + '）'; att = undefined; } }
      if (g.closed) return;
      this.setStatus(g, p.key, '');
      const body = String(text || '').replace(/^回复 \S+\n?/, '');
      const it = this.add(g, { kind: 'gm', who: p.key, text: (body || (att?.length ? '' : '（这一轮没有文字回复）')) + note, att: att?.length ? att : undefined, depth: p.depth });
      g.seen[p.key] = it.seq; this.save(g);
      this.route(g, it);
    })().catch(e => this.log('group reply', e.message));
    return true;
  }
  // 协同成员（没有镜像、读不到本机群记录文件的）来读群记录：after 之后的（最多 limit 条）；不给 after 就是最近 limit 条
  historyFor(id, peerId, after, limit = 50) {
    const g = this.get(id);
    if (!g || g.mirror || !g.peers().includes(peerId)) return null;
    limit = Math.max(1, Math.min(200, Number(limit) || 50));
    const n = Number(after);
    const its = Number.isFinite(n) && String(after ?? '') !== '' ? g.items.filter(it => it.seq > n).slice(0, limit) : g.items.slice(-limit);
    return { ok: true, name: g.title, members: g.members.map(m => m.name), last: g.seqMax, more: its.length ? g.items.some(it => it.seq > its[its.length - 1].seq) : false, text: its.map(it => logLine(it, g.members)).join('') };
  }

  // 镜像：给某个对方看的快照（collab 按对方的视角）
  snapshotFor(id, peerId) {
    const g = this.get(id);
    return g && { id: toWire(id), name: g.name, title: g.title, created: g.created, members: g.membersView(peerId), items: g.items.slice(-SNAP).map(it => { const v = g.view(it, peerId); return v.text && v.text.length > 8000 ? { ...v, text: v.text.slice(0, 8000) + '…' } : v; }), status: Object.entries(g.status).map(([k, text]) => ({ name: g.members.find(m => m.key === k)?.name || '', text })) };
  }
  syncOut(g) {
    if (g.mirror || !g.peers().length) return;
    clearTimeout(this.syncT.get(g.id));
    this.syncT.set(g.id, setTimeout(() => {
      this.syncT.delete(g.id);
      if (g.closed) return;
      for (const pid of g.peers()) this.peerOp(pid, { op: 'sync', group: this.snapshotFor(g.id, pid) }).catch(e => this.log('group sync', pid, e.message));
    }, this.syncDelay));
  }
  // 收到主群的快照：建 / 更新镜像；别的对方不能改它
  applyMirror(peerId, snap) {
    const id = fromWire(snap?.id);
    if (!id || this.gone[id] || !Array.isArray(snap.items) || !Array.isArray(snap.members)) return null;
    const str = (x, n) => String(x ?? '').slice(0, n);
    const who = w => w && typeof w === 'object' ? { name: str(w.name, 40), claw: /^[a-z]{1,20}$/.test(w.claw) ? w.claw : '', collab: !!w.collab, peer: w.peer ? str(w.peer, 40) : undefined } : undefined;
    const members = snap.members.slice(0, 20).map(w => ({ ...who(w), host: w?.host === true || undefined }));
    if (!members.some(m => !m.collab)) return null;   // 群里得有本机的会话
    const items = snap.items.filter(x => x && Number.isInteger(x.seq) && ['user', 'gm', 'sys'].includes(x.kind)).slice(-SNAP)
      .map(x => ({ seq: x.seq, at: Number.isFinite(x.at) ? x.at : Date.now(), kind: x.kind, text: str(x.text, 20000), att: cleanAtt(x.att), via: x.via ? str(x.via, 40) : undefined, who: who(x.who) }));
    snap = { ...snap, members, items, status: Array.isArray(snap.status) ? snap.status.slice(0, 20).map(s => ({ name: str(s?.name, 40), text: str(s?.text, 40) })) : [] };
    let g = this.get(id);
    if (g && (!g.mirror || g.mirror.peerId !== peerId)) return null;
    const isNew = !g;
    if (!g) { g = new Group(this, { id, mirror: { peerId }, created: Number.isFinite(snap.created) ? snap.created : Date.now() }); this.map.set(id, g); this.log('group mirror', id, 'from', peerId); }
    const fresh = snap.items.filter(x => x.seq > g.seqMax);
    Object.assign(g, { name: str(snap.name, 40), mirrorTitle: str(snap.title, 60), members: snap.members, items: snap.items, status: snap.status });
    g.seqMax = snap.items.reduce((a, x) => Math.max(a, x.seq || 0), g.seqMax);
    this.save(g);
    if (isNew) this.writeLog(g); else this.appendLog(g, fresh);
    for (const it of fresh) { g.emit({ t: 'group.msg', id, item: it }); if (!isNew) try { this.onItem(g, it); } catch {} }
    if (isNew && fresh.length) try { this.onItem(g, fresh[fresh.length - 1]); } catch {}   // 第一次同步：未读只记一条
    g.emit({ t: 'group.status', id, status: g.statusView() });
    g.emit({ t: 'group.meta', id, title: g.title, members: g.membersView() });
    return g;
  }
  // 解散（从「最近」删）：两边都删。fromPeer：对方发来的解散（镜像只认主群，主群只认有成员的对方），不再回发给它
  dissolve(id, { fromPeer } = {}) {
    const g = this.get(id);
    if (!g) return false;
    if (fromPeer && (g.mirror ? g.mirror.peerId !== fromPeer : !g.peers().includes(fromPeer))) return false;
    this.map.delete(id); g.closed = true;
    this.gone[id] = Date.now(); try { fs.writeFileSync(this.goneFile, JSON.stringify(this.gone)); } catch {}
    clearTimeout(this.syncT.get(id)); this.syncT.delete(id);
    try { fs.rmSync(path.join(this.dir, id.slice(3) + '.json'), { force: true }); fs.rmSync(this.logFile(id), { force: true }); fs.rmSync(this.attDir(id), { recursive: true, force: true }); } catch {}
    g.emit({ t: 'group.gone', id });
    const to = g.mirror ? (fromPeer ? [] : [g.mirror.peerId]) : g.peers().filter(p => p !== fromPeer);
    for (const pid of to) this.peerOp(pid, { op: 'dissolve', id: toWire(id) }).catch(e => this.log('group dissolve', pid, e.message));
    this.log('group dissolve', id, fromPeer ? 'by peer' : '');
    return true;
  }
}
