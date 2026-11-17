// acp.mjs 里各家适配共用的部分：AcpLoadRunner（session/load 重放）、会话文件缓存、写 agent 配置、回收站
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-helpers-'));
process.env.CLACLAW_DATA = path.join(tmp, 'data');   // acp.mjs 引入 auth.mjs 前先指到临时目录
const { AcpAgent, AcpLoadRunner, fileRows, syncJsonConfig, toTrash, listItem, localNames } = await import('../src/claws/acp.mjs');

const agent = new AcpAgent({ name: 'fake-load', bin: () => null, missing: 'no' });
class R extends AcpLoadRunner {
  static agent = agent; static prefix = 'fl:'; static runners = new Map(); static label = 'Fake';
  sessionInfo() { return { cwd: '/w', title: 'from list', model: 'm1' }; }
  cleanUser(t) { return t.replace(/<x>.*?<\/x>/g, '').trim(); }
}

test('AcpLoadRunner：默认值、重放收条目、去掉提示块和空的用户消息', async () => {
  assert.equal(R.permPrefix, 'fl-');
  assert.equal(R.group, 'Fake');
  assert.deepEqual(R.commands.map(c => c.name), ['model', 'mode']);
  assert.ok(R.ctxFromUsage && R.titleFromAgent);
  const r = new R('fl:abcd1', {});
  assert.equal(r.openMethod, 'session/load');
  await r.prepareAttach();
  assert.equal(r.replaying, true);
  assert.equal(r.cwd, '/w'); assert.equal(r.model, 'm1'); assert.equal(r.title, 'from list');
  r.handle({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<x>hint</x>hello' } });
  r.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
  r.handle({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<x>only</x>' } });
  r.attachDone(true);
  assert.equal(r.replaying, false);
  assert.deepEqual(r.items.map(x => [x.kind, x.text]), [['user', 'hello'], ['ai', 'hi']]);
  r.beforePrompt('next', []);
  assert.equal(r.history().total, 3);
  localNames.set('fl:abcd1', 'Local');
  await r.prepareAttach();
  assert.equal(r.title, 'Local');   // 本机改过的名字优先
  localNames.set('fl:abcd1', '');
});

test('AcpLoadRunner：没有标题时用第一句，再没有用「<label> 会话」', async () => {
  class N extends R { sessionInfo() { return null; } }
  const r = new N('fl:abcd2', {});
  await r.prepareAttach();
  r.handle({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '  first\nline ' } });
  r.attachDone(true);
  assert.equal(r.title, 'first line');
  const e = new N('fl:abcd3', {});
  await e.prepareAttach(); e.attachDone(true);
  assert.equal(e.title, 'Fake 会话');
});

test('fileRows：按大小 + 修改时间缓存，新的在前，不在了的从缓存删掉', () => {
  const d = path.join(tmp, 'rows'); fs.mkdirSync(d);
  const a = path.join(d, 'a'), b = path.join(d, 'b'), empty = path.join(d, 'e');
  fs.writeFileSync(a, '1'); fs.writeFileSync(b, '22'); fs.writeFileSync(empty, '');
  fs.utimesSync(a, 1000, 1000); fs.utimesSync(b, 2000, 2000);
  const cache = new Map();
  let parsed = 0;
  const parse = (f, st) => { parsed++; return f === b ? null : { id: path.basename(f), updated: st.mtimeMs }; };
  assert.deepEqual(fileRows(cache, [a, b, empty, path.join(d, 'missing')], parse).map(x => x.id), ['a']);
  assert.equal(parsed, 2);
  fileRows(cache, [a, b], parse);
  assert.equal(parsed, 2);   // 没变不重读
  fileRows(cache, [a], parse);
  assert.deepEqual([...cache.keys()], [a]);
});

test('syncJsonConfig：没变不写、读不懂不动、写出来 600', () => {
  const f = path.join(tmp, 'cfg', 'settings.json'), logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const merge = cur => ({ ...cur, ours: [1] });
  syncJsonConfig(f, { tag: 'x', count: 0, merge, log });
  assert.ok(!fs.existsSync(f));   // 没有文件、模型库也空：不建
  syncJsonConfig(f, { tag: 'x', count: 1, merge, log });
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "ours": [\n    1\n  ]\n}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);   // Windows 没有 Unix 权限位
  const m = fs.statSync(f).mtimeMs;
  syncJsonConfig(f, { tag: 'x', count: 1, merge, log });
  assert.equal(fs.statSync(f).mtimeMs, m);
  fs.writeFileSync(f, '{ // comment');
  syncJsonConfig(f, { tag: 'x', count: 1, merge, log });
  assert.equal(fs.readFileSync(f, 'utf8'), '{ // comment');
  assert.deepEqual(logs, ['x settings.json synced 1 models', 'x settings.json 不是标准 JSON，没有写入模型库']);
});

test('toTrash / listItem', () => {
  const src = path.join(tmp, 's.jsonl'); fs.writeFileSync(src, 'x');
  const dest = toTrash(path.join(tmp, 'trash'), 'fake', 'fl:id1', { id: 'id1', file: src, cwd: '/w' }, { ext: '.jsonl', move: true });
  assert.match(path.basename(dest), /^\d{4}-\d\d-\d\dT[\d-]+Z_fake_id1\.jsonl$/);
  assert.ok(!fs.existsSync(src) && fs.existsSync(dest));
  assert.equal(JSON.parse(fs.readFileSync(dest + '.origin.json', 'utf8')).from, src);
  assert.deepEqual(listItem('fake', 'fl:1', id => id === 'fl:1', { title: 't', cwd: os.homedir() + '/p', updated: 5 }), {
    id: 'fl:1', title: 't', cwd: os.homedir() + '/p', cwdShort: '~/p', branch: '', lastModified: 5,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0, claw: 'fake', busy: true,
  });
});
