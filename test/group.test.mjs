import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isGroupId, toWire, fromWire, memberNames, parseMentions, composeDelivery, Groups } from '../group.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grp-'));
const flush = () => new Promise(r => setTimeout(r, 5));
const M = (id, title, extra = {}) => ({ id, title, claw: 'claude', ...extra });

test('群 id：gp:8 位十六进制；经协同写成 gp-', () => {
  assert.ok(isGroupId('gp:0a1b2c3d'));
  assert.ok(!isGroupId('gp:xyz') && !isGroupId('0a1b2c3d') && !isGroupId(null));
  assert.equal(toWire('gp:0a1b2c3d'), 'gp-0a1b2c3d');
  assert.equal(fromWire('gp-0a1b2c3d'), 'gp:0a1b2c3d');
  assert.equal(fromWire('gp-zz'), null);
  assert.equal(fromWire('abc'), null);
});

test('成员名：压空格、截 16 字、重名加序号', () => {
  const ms = memberNames([{ key: 'a', title: '  后端   开发 ' }, { key: 'b', title: '后端 开发' }, { key: 'c', title: '一二三四五六七八九十一二三四五六七八' }, { key: 'd', title: '' }]);
  assert.deepEqual(ms.map(m => m.name), ['后端 开发', '后端 开发2', '一二三四五六七八九十一二三四五六', '会话']);
});

test('@ 解析：最长名优先、@全体 = 全部、去重保序', () => {
  const ms = memberNames([{ key: 'a', title: '前端' }, { key: 'b', title: '前端测试' }, { key: 'c', title: '后端' }]);
  assert.deepEqual(parseMentions('@前端测试 看一下', ms), ['b']);
  assert.deepEqual(parseMentions('@后端 @前端 再 @后端', ms), ['c', 'a']);
  assert.deepEqual(parseMentions('@全体 开会', ms), ['a', 'b', 'c']);
  assert.deepEqual(parseMentions('@all hi', ms), ['a', 'b', 'c']);
  assert.deepEqual(parseMentions('没有 at', ms), []);
});

test('拼投递：带上次之后的群记录（不含自己的话、最多 20 条），总长不超过上限，本条原样', () => {
  const members = memberNames([{ key: 'a', title: '需求' }, { key: 'b', title: '后端' }]);
  const items = [];
  for (let i = 1; i <= 30; i++) items.push({ seq: i, kind: i % 2 ? 'user' : 'gm', who: i % 2 ? undefined : (i % 4 ? 'a' : 'b'), text: '消息' + i });
  const cur = { seq: 31, kind: 'user', text: '@后端 开始' };
  const t = composeDelivery({ items, since: 5, upto: 31, selfKey: 'b', members, current: cur });
  assert.ok(t.endsWith('用户：@后端 开始'));
  assert.ok(!/后端：/.test(t), '不带自己说过的');
  assert.ok(t.includes('需求：消息30'));
  assert.ok(!t.includes('消息5\n') && !t.includes('：消息3\n'), 'since 之前的不带');
  const lines = t.split('\n').filter(l => /^(用户|需求)：消息/.test(l));
  assert.ok(lines.length <= 20);
  // 超长：旧的先截短 / 丢，本条原样
  const big = items.map(x => ({ ...x, text: 'x'.repeat(1000) }));
  const t2 = composeDelivery({ items: big, since: 0, upto: 31, selfKey: 'b', members, current: { ...cur, text: '@后端 ' + 'y'.repeat(2000) } });
  assert.ok(t2.length <= 4000, 'len ' + t2.length);
  assert.ok(t2.includes('y'.repeat(2000)));
  // 没有可带的：只有本条
  assert.equal(composeDelivery({ items: [], since: 0, upto: 1, selfKey: 'b', members, current: { seq: 1, kind: 'user', text: 'hi' } }), '用户：hi');
});

function setup(deliverImpl, opts = {}) {
  const calls = [], ops = [], items = [];
  const groups = new Groups({
    dir: tmp(), retryMs: 10, retryFor: opts.retryFor ?? 1000, syncDelay: 0,
    deliver: async (m, text, o) => { calls.push({ key: m.key, text, o }); return deliverImpl(m, text, o, calls); },
    peerOp: async (peerId, body) => { ops.push({ peerId, body }); return { ok: true }; },
    onItem: (g, it) => items.push(it),
  });
  return { groups, calls, ops, items };
}

test('建群至少 2 个成员；@ 谁谁回，回复贴回群里；不 @ 不触发', async () => {
  const { groups, calls } = setup(async m => ({ ok: true, reply: m.name + ' 收到' }));
  assert.throws(() => groups.create({ members: [M('s1', '后端')] }));
  const g = groups.create({ members: [M('s1', '后端'), M('s2', '前端')] });
  assert.ok(isGroupId(g.id));
  assert.equal(g.title, '后端、前端');
  groups.post(g.id, '大家好');
  await flush();
  assert.equal(calls.length, 0);
  groups.post(g.id, '@后端 写接口');
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 's1');
  assert.equal(calls[0].o.asUser, true);
  assert.ok(calls[0].text.includes('用户：大家好'), '带上没看过的群记录');
  const last = g.items[g.items.length - 1];
  assert.equal(last.kind, 'gm'); assert.equal(last.who, 's1'); assert.equal(last.text, '后端 收到');
  // 第二次 @ 后端：已经看过的不再带
  groups.post(g.id, '@后端 再来');
  await flush();
  assert.ok(!calls[1].text.includes('大家好'));
});

test('成员互相 @ 最多转 2 跳，不转给自己', async () => {
  const say = { s1: '@前端 接口好了', s2: '@测试 你看', s3: '@后端 有问题', };
  const { groups, calls } = setup(async m => ({ ok: true, reply: say[m.id] || 'ok' }));
  const g = groups.create({ members: [M('s1', '后端'), M('s2', '前端'), M('s3', '测试')] });
  groups.post(g.id, '@后端 开工');
  for (let i = 0; i < 10; i++) await flush();
  assert.deepEqual(calls.map(c => c.key), ['s1', 's2', 's3']);
  assert.equal(calls[1].o.asUser, false);
  assert.ok(g.items.some(x => x.kind === 'sys' && /转发上限/.test(x.text)));
});

test('成员在忙：排队重试，送到后照常贴回；一直忙就放弃并说明', async () => {
  let n = 0;
  const { groups, calls } = setup(async () => (++n < 3 ? { busy: true } : { ok: true, reply: '好' }));
  const g = groups.create({ members: [M('s1', '后端'), M('s2', '前端')] });
  groups.post(g.id, '@后端 x');
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(calls.length, 3);
  assert.equal(g.items.at(-1).text, '好');
  const b = setup(async () => ({ busy: true }), { retryFor: 0 });
  const g2 = b.groups.create({ members: [M('s1', '后端'), M('s2', '前端')] });
  b.groups.post(g2.id, '@后端 x');
  for (let i = 0; i < 5; i++) await flush();
  assert.ok(g2.items.some(x => x.kind === 'sys' && /一直在忙/.test(x.text)));
});

test('协同成员先回 202：回复稍后按编号落回群里，别的对方、没发过的编号不收', async () => {
  const { groups } = setup(async () => ({ accepted: true, msgId: 'm-1' }));
  const g = groups.create({ members: [M('s1', '后端'), M('abc12345', '需求', { peerId: 'P15' })] });
  groups.post(g.id, '@需求 整理一下');
  await flush();
  assert.equal(groups.remoteReply(g.id, 'P99', 'm-1', '回复 m-1\n伪造'), false);
  assert.equal(groups.remoteReply(g.id, 'P15', 'm-x', '回复 m-x\n伪造'), false);
  assert.equal(groups.remoteReply(g.id, 'P15', 'm-1', '回复 m-1\n整理好了'), true);
  assert.equal(g.items.at(-1).text, '整理好了');
  assert.equal(groups.remoteReply(g.id, 'P15', 'm-1', '回复 m-1\n再来'), false, '一个编号只收一次');
});

test('镜像：快照按对方视角标协同；对方那边建镜像、发消息转回主群；解散两边都删', async () => {
  const host = setup(async () => ({ ok: true, reply: 'ok' }));
  const g = host.groups.create({ members: [M('s1', '后端'), M('abc12345', '需求', { peerId: 'P15' })] });
  await flush();
  const sync = host.ops.find(o => o.body.op === 'sync');
  assert.equal(sync.peerId, 'P15');
  const snap = sync.body.group;
  assert.equal(snap.id, toWire(g.id));
  assert.deepEqual(snap.members.map(m => m.collab), [true, false], '对 15 来说，本机的后端是协同成员，它自己的需求是本地的');
  // 对方（15）
  const peer = setup(async () => { throw new Error('镜像不投递'); });
  const mg = peer.groups.applyMirror('PHOST', snap);
  assert.equal(mg.id, g.id); assert.ok(mg.mirror);
  peer.groups.post(mg.id, '@后端 hi');
  await flush();
  assert.deepEqual(peer.ops.at(-1), { peerId: 'PHOST', body: { op: 'post', id: toWire(g.id), text: '@后端 hi' } });
  assert.equal(peer.calls.length, 0);
  // 主群收到镜像发来的：按协同规矩（不是用户本人指令）
  host.groups.post(g.id, '@后端 hi', { via: '15' });
  await flush();
  assert.equal(host.calls.at(-1).o.asUser, false);
  // 新快照：镜像补上新条目
  await flush();
  const snap2 = host.ops.filter(o => o.body.op === 'sync').at(-1).body.group;
  peer.groups.applyMirror('PHOST', snap2);
  assert.equal(mg.items.length, snap2.items.length);
  // 别的对方不能改这个镜像
  assert.equal(peer.groups.applyMirror('POTHER', snap2), null);
  // 镜像这边解散：告诉主群
  peer.groups.dissolve(mg.id);
  assert.equal(peer.groups.get(mg.id), null);
  assert.deepEqual(peer.ops.at(-1), { peerId: 'PHOST', body: { op: 'dissolve', id: toWire(g.id) } });
  // 主群收到解散：删掉并通知其他对方（不回发给来源）
  host.groups.dissolve(g.id, { fromPeer: 'P15' });
  assert.equal(host.groups.get(g.id), null);
  assert.ok(!host.ops.some(o => o.body.op === 'dissolve' && o.peerId === 'P15'));
  // 解散后的回复、同步丢弃
  assert.equal(host.groups.remoteReply(g.id, 'P15', 'x', 'y'), false);
});

test('重启后从磁盘读回群', async () => {
  const dir = tmp();
  const a = new Groups({ dir, deliver: async () => ({ ok: true, reply: 'r' }), peerOp: async () => ({}), syncDelay: 0 });
  const g = a.create({ name: '项目组', members: [M('s1', '后端'), M('s2', '前端')] });
  a.post(g.id, '你好');
  const b = new Groups({ dir, deliver: async () => ({}), peerOp: async () => ({}) });
  const g2 = b.get(g.id);
  assert.equal(g2.title, '项目组');
  assert.equal(g2.items.at(-1).text, '你好');
  assert.equal(b.list().length, 1);
});

test('评审修复：重试用同一个 msgId；解散后的同步 / 消息不再复活镜像；同步必须带本机成员、条目字段校验', async () => {
  const ids = [];
  let n = 0;
  const { groups } = setup(async (m, t, o) => { ids.push(o.msgId); return ++n < 3 ? { busy: true } : { ok: true, reply: 'ok' }; });
  const g = groups.create({ members: [M('s1', '后端'), M('s2', '前端')] });
  groups.post(g.id, '@后端 x');
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(ids.length, 3); assert.ok(ids[0] && ids.every(x => x === ids[0]));
  // 镜像：没有本机成员的快照不收
  const peer = setup(async () => ({}));
  const snap = { id: 'gp-0a0b0c0d', name: '', title: 't', members: [{ name: 'a', collab: true }, { name: 'b', collab: true }], items: [], status: [] };
  assert.equal(peer.groups.applyMirror('PH', snap), null);
  const snap2 = { ...snap, members: [{ name: 'a', collab: true }, { name: 'b', collab: false }], items: [{ seq: 1, at: 'bad', kind: 'user', text: 'hi' }, { seq: 'x', kind: 'gm', text: 1 }, { seq: 2, at: 5, kind: 'evil', text: 'y' }] };
  const mg = peer.groups.applyMirror('PH', snap2);
  assert.ok(mg);
  assert.equal(mg.items.length, 1); assert.equal(typeof mg.items[0].at, 'number');
  assert.equal(typeof mg.lastAt, 'number');
  // 解散后晚到的同步不再建镜像
  peer.groups.dissolve(mg.id, { fromPeer: 'PH' });
  assert.equal(peer.groups.applyMirror('PH', snap2), null);
  assert.equal(peer.groups.get(mg.id), null);
  // 主群：解散后对方再发 post 不收
  const h = setup(async () => ({ ok: true, reply: 'r' }));
  const hg = h.groups.create({ members: [M('s1', '后端'), M('a1', '需求', { peerId: 'P15' })] });
  h.groups.dissolve(hg.id);
  assert.equal(h.groups.peerPost(hg.id, 'P15', 'hi', '15'), false);
});

test('评审修复：重名序号不撞名；成员名以「全体」开头不误触 @全体', () => {
  const ms = memberNames([{ key: 'a', title: '会话' }, { key: 'b', title: '会话' }, { key: 'c', title: '会话2' }]);
  assert.equal(new Set(ms.map(m => m.name)).size, 3);
  const ms2 = memberNames([{ key: 'a', title: '全体项目' }, { key: 'b', title: '前端' }]);
  assert.deepEqual(parseMentions('@全体项目 看下', ms2), ['a']);
  assert.deepEqual(parseMentions('@全体 看下', ms2), ['a', 'b']);
});

test('改群名、加减成员：保留老成员的名字，新成员名字不撞；少于 2 个不行；不再有成员的对方收到解散', async () => {
  const { groups, ops } = setup(async () => ({ ok: true, reply: 'ok' }));
  const g = groups.create({ members: [M('s1', '后端'), M('s2', '前端'), M('a1', '需求', { peerId: 'P15' })] });
  groups.edit(g.id, { name: '项目组' });
  assert.equal(g.title, '项目组');
  assert.ok(g.items.at(-1).kind === 'sys' && /项目组/.test(g.items.at(-1).text));
  groups.edit(g.id, { members: [M('s1', '后端'), M('s2', '前端'), M('s3', '后端')] });
  assert.deepEqual(g.members.map(m => m.name), ['后端', '前端', '后端2']);
  assert.ok(g.items.some(x => x.kind === 'sys' && /加进群/.test(x.text) && /后端2/.test(x.text)));
  assert.ok(g.items.some(x => x.kind === 'sys' && /移出群/.test(x.text) && /需求/.test(x.text)));
  assert.ok(ops.some(o => o.peerId === 'P15' && o.body.op === 'dissolve'));
  assert.throws(() => groups.edit(g.id, { members: [M('s1', '后端')] }));
  assert.equal(g.members.length, 3);
});
