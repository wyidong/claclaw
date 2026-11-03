// 群聊：几个会话（本机任意 Claw 的、协同对方开放的）在一个群里，@ 谁谁回一轮，回复贴回群里。
// 这里只管数据和规则（存储、@ 解析、带上下文、跳数、排队重试、镜像），投递和跨电脑收发由 server 注入：
//   deliver(member, text, {asUser, groupId, groupName, from}) → {ok, reply} | {busy} | {accepted, msgId} | {ok:false, error}
//   peerOp(peerId, body)：发到协同对方的 /group（sync / post / dissolve）
// 群的主体在建群的电脑上；拉了协同会话的群，在对方电脑上有一份镜像（mirror），镜像里发的消息转回主群处理。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOPS = 2, CTX_MAX = 20, ITEM_CUT = 300, LIMIT = 4000, KEEP = 500, SNAP = 200;
export const isGroupId = id => /^gp:[0-9a-f]{8}$/.test(String(id || ''));
export const toWire = id => 'gp-' + String(id).slice(3);   // 对方会把 from_session 里 [\w-] 以外的字符去掉
export const fromWire = s => /^gp-[0-9a-f]{8}$/.test(String(s || '')) ? 'gp:' + String(s).slice(3) : null;

// 成员名（@ 用）：标题压空格、截 16 字；重名加序号
export function memberNames(members) {
  const taken = new Set();
  return members.map(m => {
    const base = Array.from(String(m.title || '').replace(/\s+/g, ' ').trim().replace(/@/g, '')).slice(0, 16).join('') || '会话';
    let name = base;
    for (let n = 2; taken.has(name); n++) name = base + n;
    taken.add(name);
    return { ...m, name };
  });
}

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

const speaker = (it, members) => it.kind === 'user' ? '用户' + (it.via ? '（在 ' + it.via + ' 上）' : '') : (members.find(m => m.key === it.who)?.name || '成员');
const cut = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;

// 发给某个成员的正文：它上次之后的群记录（不含它自己的话、最多 20 条）+ 本条；总长不超过 limit，旧的先截短再丢，本条原样
export function composeDelivery({ items, since, upto, selfKey, members, current, limit = LIMIT }) {
  const cur = speaker(current, members) + '：' + current.text;
  let ctx = items.filter(i => i.seq > since && i.seq < upto && i.kind !== 'sys' && i.who !== selfKey).slice(-CTX_MAX)
    .map(i => speaker(i, members) + '：' + cut(String(i.text || '').replace(/\n{3,}/g, '\n\n'), ITEM_CUT));
  const build = () => ctx.length ? '[群里你上次之后的消息]\n' + ctx.join('\n') + '\n[这一条]\n' + cur : cur;
  while (ctx.length && build().length > limit) ctx.shift();
  const t = build();
  return t.length > limit ? t.slice(0, limit) : t;
}

class Group {
  constructor(store, d) {
    this.store = store;
    Object.assign(this, { name: '', created: Date.now(), members: [], items: [], seen: {}, pending: {}, seqMax: 0, mirror: null, status: {} }, d);
    this.subs = new Set(); this.q = {}; this.running = {}; this.closed = false;
    this.busy = false; this.queue = [];
  }
  get title() { return this.mirror ? (this.mirrorTitle || this.name || '群聊') : this.name || cut(this.members.map(m => m.name).join('、'), 24) || '群聊'; }
  get lastAt() { const a = this.items.length ? this.items[this.items.length - 1].at : this.created; return Number.isFinite(a) ? a : 0; }
  // 给 ws 用：和各 Claw 的会话进程同样的接口
  subscribe(ws) { this.subs.add(ws); }
  unsubscribe(ws) { this.subs.delete(ws); }
  watched() { return [...this.subs].some(ws => ws.visible !== false); }
  emit(o) { const s = JSON.stringify(o); for (const ws of this.subs) if (ws.readyState === 1) ws.send(s); }
  send(text) { return this.store.post(this.id, text); }
  async interrupt() {}
  replyPermission() {}
  view(it, viewer) {
    if (this.mirror) return it;
    const m = it.who && this.members.find(x => x.key === it.who);
    return { seq: it.seq, at: it.at, kind: it.kind, text: it.text, via: it.via, who: m ? memberView(m, viewer) : undefined };
  }
  history() { return { items: this.items.map(it => this.view(it)), total: this.items.length }; }
  statusView() { return this.mirror ? (this.status || []) : Object.entries(this.status).map(([k, text]) => ({ name: this.members.find(m => m.key === k)?.name || '', text })); }
  membersView(viewer) { return this.mirror ? this.members : this.members.map(m => memberView(m, viewer)); }
  preview() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.view(this.items[i]);
      if (it.kind !== 'sys') return (it.kind === 'user' ? '我' : it.who?.name || '成员') + '：' + String(it.text || '').replace(/\s+/g, ' ').slice(0, 40);
    }
    return '';
  }
  peers() { return [...new Set(this.members.map(m => m.peerId).filter(Boolean))]; }
  toJSON() { const { name, created, members, items, seen, pending, seqMax, mirror, mirrorTitle, id } = this; return { id, name, created, members, items, seen, pending, seqMax, mirror, mirrorTitle, status: this.mirror ? this.status : undefined }; }
}
// viewer：给哪台电脑看（undefined = 本机）；collab = 对看的人来说是不是别的电脑上的会话
const memberView = (m, viewer) => ({ name: m.name, claw: m.claw || '', collab: viewer === undefined ? !!m.peerId : m.peerId !== viewer, peer: m.peerName || undefined });

export class Groups {
  constructor({ dir, log = () => {}, deliver, peerOp = async () => ({}), onItem = () => {}, retryMs = 20000, retryFor = 30 * 60e3, syncDelay = 300 }) {
    Object.assign(this, { dir, log, deliver, peerOp, onItem, retryMs, retryFor, syncDelay });
    this.map = new Map(); this.syncT = new Map();
    fs.mkdirSync(dir, { recursive: true });
    // 解散过的群（墓碑，留 30 天）：之后晚到的同步、消息、回复一律不收，镜像不会被「复活」
    this.goneFile = path.join(dir, 'gone.json');
    try { this.gone = JSON.parse(fs.readFileSync(this.goneFile, 'utf8')) || {}; } catch { this.gone = {}; }
    for (const [k, t] of Object.entries(this.gone)) if (Date.now() - t > 30 * 864e5) delete this.gone[k];
    for (const f of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{8}\.json$/.test(f)) continue;
      try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (isGroupId(d.id)) this.map.set(d.id, new Group(this, d)); } catch {}
    }
  }
  get(id) { return this.map.get(id) || null; }
  list() { return [...this.map.values()]; }
  save(g) { if (g.closed) return; const f = path.join(this.dir, g.id.slice(3) + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(g)); fs.renameSync(f + '.tmp', f); }

  // members：[{id, peerId?, peerName?, title, claw}]
  create({ name, members }) {
    const seen = new Set(), ms = [];
    for (const m of members || []) {
      const key = (m.peerId ? m.peerId + '/' : '') + m.id;
      if (!m.id || seen.has(key)) continue;
      seen.add(key); ms.push({ key, id: m.id, peerId: m.peerId || undefined, peerName: m.peerName || undefined, title: m.title || '', claw: m.claw || '' });
    }
    if (ms.length < 2) throw new Error('至少选 2 个会话');
    let id; do id = 'gp:' + crypto.randomBytes(4).toString('hex'); while (this.map.has(id));
    const g = new Group(this, { id, name: String(name || '').trim().slice(0, 40), members: memberNames(ms) });
    this.map.set(id, g); this.save(g); this.syncOut(g);
    this.log('group create', id, ms.length + ' members');
    return g;
  }

  // 用户在群里发一条（via：在哪台对方电脑上发的，经协同转来）；镜像里发的转回主群
  post(id, text, { via } = {}) {
    const g = this.get(id); text = String(text || '').trim();
    if (!g || !text) return false;
    if (g.mirror) {   // 镜像：转给建群的电脑，它收下后会随快照回来；没送到就告诉页面（输入框放回原文）
      const fail = why => g.emit({ t: 'group.msg', id, item: { kind: 'sys', fail: true, text: '没发到建群的电脑：' + why } });
      this.peerOp(g.mirror.peerId, { op: 'post', id: toWire(id), text }).then(j => { if (!j?.ok) fail(j?.error || '对方没收下'); }, e => { this.log('group post fwd', e.message); fail(e.message); });
      return true;
    }
    const it = this.add(g, { kind: 'user', text: text.slice(0, 8000), via: via || undefined, depth: 0 });
    this.route(g, it);
    return true;
  }
  // 协同对方（镜像那边）发来的：只收群里有它的会话的对方
  peerPost(id, peerId, text, via) { const g = this.get(id); return !!g && !g.mirror && g.peers().includes(peerId) && this.post(id, text, { via }); }
  // 本机这个群是不是对方 peerId 那边建的群的镜像（对方发来的群投递，只有这时才按群消息处理）
  isMirrorOf(id, peerId) { return this.get(id)?.mirror?.peerId === peerId; }

  add(g, it) {
    it = { seq: ++g.seqMax, at: Date.now(), ...it };
    g.items.push(it);
    if (g.items.length > KEEP) g.items.splice(0, g.items.length - KEEP);
    this.save(g);
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
    const targets = parseMentions(it.text, g.members).filter(k => k !== it.who);
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
    const text = composeDelivery({ items: g.items, since: g.seen[key] || 0, upto: job.trigger, selfKey: key, members: g.members, current: trig });
    for (;;) {
      this.setStatus(g, key, '正在回复…');
      let r;
      job.msgId ||= crypto.randomUUID();   // 重试用同一个编号：对方据此去重，不会把同一条处理两遍
      try { r = await this.deliver(m, text, { asUser: job.asUser, groupId: g.id, groupName: g.title, from: speaker(trig, g.members), msgId: job.msgId }); }
      catch (e) { r = { ok: false, error: e.message }; }
      if (g.closed) return;
      if (r?.busy) {
        if (Date.now() - job.firstAt >= this.retryFor) { this.setStatus(g, key, ''); this.add(g, { kind: 'sys', text: '「' + m.name + '」一直在忙，这条没送到' }); return; }
        this.setStatus(g, key, r.offline ? '连不上，排队重试中' : '在忙，排队中');
        await new Promise(res => setTimeout(res, this.retryMs));
        if (g.closed) return;
        continue;
      }
      if (r?.accepted) {
        g.seen[key] = Math.max(g.seen[key] || 0, job.trigger);
        g.pending[r.msgId] = { key, depth: job.depth + 1, peerId: m.peerId, at: Date.now() };
        this.save(g); this.setStatus(g, key, '已收到，回复稍后到');
        return;
      }
      this.setStatus(g, key, '');
      if (r?.ok) {
        g.seen[key] = Math.max(g.seen[key] || 0, job.trigger);
        const it = this.add(g, { kind: 'gm', who: key, text: String(r.reply || '（这一轮没有文字回复）').slice(0, 20000), depth: job.depth + 1 });
        g.seen[key] = it.seq; this.save(g);
        this.route(g, it);
      } else this.add(g, { kind: 'sys', text: '「' + m.name + '」没收到：' + (r?.error || '未知错误') });
      return;
    }
  }

  // 协同成员先回了 202，回复稍后以「回复 <编号>」单独发来：只收自己发过、同一个对方的编号，一个编号只收一次
  remoteReply(id, peerId, replyTo, text) {
    const g = this.get(id);
    if (!g || g.mirror) return false;
    const p = g.pending[replyTo];
    if (!p || p.peerId !== peerId) return false;
    delete g.pending[replyTo];
    this.setStatus(g, p.key, '');
    const it = this.add(g, { kind: 'gm', who: p.key, text: String(text || '').replace(/^回复 \S+\n?/, '') || '（这一轮没有文字回复）', depth: p.depth });
    g.seen[p.key] = it.seq; this.save(g);
    this.route(g, it);
    return true;
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
    const members = snap.members.slice(0, 20).map(who);
    if (!members.some(m => !m.collab)) return null;   // 群里得有本机的会话
    const items = snap.items.filter(x => x && Number.isInteger(x.seq) && ['user', 'gm', 'sys'].includes(x.kind)).slice(-SNAP)
      .map(x => ({ seq: x.seq, at: Number.isFinite(x.at) ? x.at : Date.now(), kind: x.kind, text: str(x.text, 20000), via: x.via ? str(x.via, 40) : undefined, who: who(x.who) }));
    snap = { ...snap, members, items, status: Array.isArray(snap.status) ? snap.status.slice(0, 20).map(s => ({ name: str(s?.name, 40), text: str(s?.text, 40) })) : [] };
    let g = this.get(id);
    if (g && (!g.mirror || g.mirror.peerId !== peerId)) return null;
    const isNew = !g;
    if (!g) { g = new Group(this, { id, mirror: { peerId }, created: Number.isFinite(snap.created) ? snap.created : Date.now() }); this.map.set(id, g); this.log('group mirror', id, 'from', peerId); }
    const fresh = snap.items.filter(x => x.seq > g.seqMax);
    Object.assign(g, { name: str(snap.name, 40), mirrorTitle: str(snap.title, 60), members: snap.members, items: snap.items, status: snap.status });
    g.seqMax = snap.items.reduce((a, x) => Math.max(a, x.seq || 0), g.seqMax);
    this.save(g);
    for (const it of fresh) { g.emit({ t: 'group.msg', id, item: it }); if (!isNew) try { this.onItem(g, it); } catch {} }
    if (isNew && fresh.length) try { this.onItem(g, fresh[fresh.length - 1]); } catch {}   // 第一次同步：未读只记一条
    g.emit({ t: 'group.status', id, status: g.statusView() });
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
    try { fs.rmSync(path.join(this.dir, id.slice(3) + '.json'), { force: true }); } catch {}
    g.emit({ t: 'group.gone', id });
    const to = g.mirror ? (fromPeer ? [] : [g.mirror.peerId]) : g.peers().filter(p => p !== fromPeer);
    for (const pid of to) this.peerOp(pid, { op: 'dissolve', id: toWire(id) }).catch(e => this.log('group dissolve', pid, e.message));
    this.log('group dissolve', id, fromPeer ? 'by peer' : '');
    return true;
  }
}
