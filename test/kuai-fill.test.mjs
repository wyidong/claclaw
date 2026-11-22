import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFills, routeFill, askSlots, fillSchema, fillAsk, parseFill, enough, fillArgs, fillLine, fillLead, pasteOut } from '../src/claws/kuai-fill.mjs';
import { QUIZ_SKILLS, QUIZ_FILL_META, QUESTIONS, fakeRun, grade, settled, quizTier, quizCount, nextQuestion } from '../src/claws/kuai-quiz.mjs';

const SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const META = JSON.parse(fs.readFileSync(path.join(SKILLS, 'kuai.json'), 'utf8'));
const FILLS = loadFills(META);
const by = n => FILLS.find(f => f.name === n);

test('kuAi 填空：skills/kuai.json 里每个 kuAi 能用的技能都有一句话和填空定义，定义都读得出来', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(SKILLS, 'index.json'), 'utf8')).map(x => x.name).filter(n => !['claw-interconnect', 'claw-file'].includes(n));
  assert.deepEqual(Object.keys(META).sort(), idx.sort());
  for (const n of idx) {
    assert.ok(META[n].brief && META[n].brief.length <= 40, n + ' 的 brief 要有、要短');
    const f = by(n); assert.ok(f, n + ' 的 fill 读不出来（正则写错了？）');
    for (const [text, slots] of f.examples) {   // 例子自己要过得了校验：参数都是原话里的一段
      if (!slots) continue;
      const got = parseFill(f, JSON.stringify({ ...slots, use: true }), text);
      assert.ok(got.use, n + ' 的例子「' + text + '」过不了校验');
      for (const s of askSlots(f)) assert.equal(got.slots[s.key], slots[s.key] || '', n + ' 的例子「' + text + '」的 ' + s.key);
    }
  }
  assert.deepEqual(loadFills(META, n => n === 'claw-tv').map(f => f.name), ['claw-tv']);   // 没装的技能不要
  assert.deepEqual(loadFills({ a: { fill: { when: '(', args: [] } }, b: { brief: 'x' }, c: { fill: { when: 'x' } } }), []);   // 正则坏的、没有 fill 的、没有 args 的都不要
});

test('kuAi 填空：按关键词认技能——要做事的话才走，提问、太长、多行的不走；几个技能都沾边时按顺序', () => {
  const R = t => routeFill(FILLS, t)?.name || null;
  const yes = { '放一首周杰伦的晴天': 'claw-music', '来点古筝纯音乐': 'claw-music', '我想听郭德纲的相声': 'claw-music', '来首 Beyond 的光辉岁月': 'claw-music',
    '打开四川卫视': 'claw-tv', '我想看央视五套': 'claw-tv', '看看湖南台在播什么': 'claw-tv', '放一下周杰伦晴天的MV': 'claw-audio', '找个五月天的演唱会现场': 'claw-audio',
    '找部沈腾的电影': 'claw-movie', '来部科幻片': 'claw-movie', '找一段讲黑洞的视频': 'claw-video', '来个红烧肉的教程': 'claw-video',
    '发几张大熊猫的图片': 'claw-image', '雪豹长什么样': 'claw-image', '帮我挑个保温杯': 'claw-shopping', '推荐几款50块以内的耳机': 'claw-shopping',
    '换个皮肤': 'claw-theme', '换成粉色的主题': 'claw-theme', '恢复默认皮肤': 'claw-theme' };
  for (const [t, n] of Object.entries(yes)) assert.equal(R(t), n, t);
  for (const t of ['周杰伦的晴天是哪一年发行的？', '听歌对学习有帮助吗', '四川卫视是哪年开播的', '霸王别姬是谁演的', '图片怎么压缩', '保温杯能带上飞机吗', '怎么换皮肤', '你好', '1+1 等于几',
    '打开阳台的灯', '帮我写个 Python 脚本', '推荐几本书', '放一首歌\n再来一首', '放一首' + '很长'.repeat(70)]) assert.equal(R(t), null, t);
});

test('kuAi 填空：约束输出的 JSON 和填空说明——只问要模型填的参数（程序定的不问），枚举多一个空值，最后是 use，带例子', () => {
  const m = by('claw-music'), sh = by('claw-shopping'), th = by('claw-theme');
  assert.deepEqual(fillSchema(m), { type: 'object', properties: { song: { type: 'string' }, artist: { type: 'string' }, use: { type: 'boolean' } }, required: ['song', 'artist', 'use'], additionalProperties: false });
  assert.deepEqual(fillSchema(sh).properties.sort, { type: 'string', enum: ['价格', '销量', ''] });
  assert.deepEqual(askSlots(th), []);   // 换皮肤的参数全由程序按关键词定：不问模型
  const ask = fillAsk(m);
  assert.match(ask, /^\n\n———\n\[claclaw\] claclaw 可以替你放歌/);
  assert.match(ask, /例：「放一首张学友的吻别」→ \{"song":"吻别","artist":"张学友","use":true\}/);
  assert.match(ask, /例：「吻别是谁唱的」→ \{"song":"","artist":"","use":false\}/);
  assert.match(fillAsk(sh), /sort 写要便宜的写价格，要卖得好的写销量（只能是 价格 \/ 销量，没说就留空）/);
});

test('kuAi 填空：模型填回来的要过校验——必须是原话里的一段，照抄例子的、整句话、以 - 开头的、不在枚举里的都不要；缺了必须有的就不用', () => {
  const m = by('claw-music'), sh = by('claw-shopping'), th = by('claw-theme');
  const P = (f, o, t) => parseFill(f, typeof o === 'string' ? o : JSON.stringify(o), t);
  assert.deepEqual(P(m, { song: '晴天', artist: '周杰伦', use: true }, '放一首周杰伦的晴天'), { use: true, slots: { song: '晴天', artist: '周杰伦' }, said: true });
  assert.deepEqual(P(m, '好的：{"song":"光辉岁月","artist":"beyond","use":true} 完', '来首 Beyond 的光辉岁月').slots, { song: '光辉岁月', artist: 'beyond' });   // 前后多了字、大小写不同也认
  assert.equal(P(m, { song: '二胡', artist: '', use: true }, '放一首歌要多少流量').use, false);             // 照抄例子：不是原话里的
  assert.equal(P(m, { song: '放一首歌要多少流量', artist: '', use: true }, '放一首歌要多少流量').use, false);   // 把整句话填进去
  assert.equal(P(m, { song: '--src', artist: '', use: true }, '放一首 --src x').use, false);                // 不让它变成命令的选项
  assert.equal(P(m, { song: '晴天', artist: '周杰伦', use: false }, '放一首周杰伦的晴天').use, false);        // 模型说不用：听它的
  assert.deepEqual(P(m, { song: '', artist: '周杰伦' }, '来首周杰伦的歌'), { use: true, slots: { song: '', artist: '周杰伦' }, said: null });   // 歌名、歌手有一个就行
  assert.equal(P(m, '我不知道', '放一首晴天'), null);                                                        // 认不出 JSON
  assert.deepEqual(P(sh, { what: '耳机', max: '50', sort: '销量', use: true }, '推荐几款50块以内销量高的耳机').slots, { what: '耳机', max: '50', sort: '销量' });
  assert.deepEqual(P(sh, { what: '耳机', max: '五十', sort: '好评', use: true }, '推荐几款五十块以内的耳机').slots, { what: '耳机', max: '', sort: '' });   // 预算要是数字；排序不在枚举里
  assert.equal(enough(sh, { what: '', max: '50' }), false);
  // 程序定的参数：不用模型
  assert.deepEqual(P(th, '', '换成粉色的主题'), { use: true, slots: { theme: '未' }, said: null });
  assert.equal(P(th, '', '界面太亮了，换个暗一点的').slots.theme, 'dark');
  assert.equal(P(th, '', '换成深蓝色的皮肤').slots.theme, '酉');
  assert.equal(P(th, '', '恢复默认皮肤').slots.theme, 'auto');
  assert.deepEqual(P(th, '', '换个皮肤'), { use: false, slots: { theme: '' }, said: null });   // 没说要什么样的：走兜底（给几张卡片挑）
  assert.deepEqual(th.else, ['show', 'dark,未,申']); assert.match(th.elseLead, /点哪张就换哪个/);
});

test('kuAi 填空：参数拼成命令（空的那项、那一组不要），结果贴成用户看的样子', () => {
  const m = by('claw-music'), sh = by('claw-shopping'), im = by('claw-image'), tv = by('claw-tv');
  assert.deepEqual(fillArgs(m, { song: '晴天', artist: '周杰伦' }), ['晴天 周杰伦']);
  assert.deepEqual(fillArgs(m, { song: '', artist: '周杰伦' }), ['周杰伦']);
  assert.deepEqual(fillArgs(sh, { what: '耳机', max: '50', sort: '' }), ['耳机', '--max', '50']);
  assert.deepEqual(fillArgs(sh, { what: '耳机', max: '', sort: '销量' }), ['耳机', '--sort', '销量']);
  assert.deepEqual(fillArgs(by('claw-theme'), { theme: '未' }), ['set', '未']);
  assert.equal(fillLine('claw-music', ['晴天 周杰伦']), 'claw-music "晴天 周杰伦"');
  assert.equal(fillLine('claw-shopping', ['耳机', '--max', '50']), 'claw-shopping "耳机" --max 50');
  assert.equal(fillLead(tv, { channel: '四川卫视' }), '四川卫视的官方直播，点卡片去看：');
  assert.equal(pasteOut(tv, '```tv\n卫视 | 川 | 四川卫视 | https://x\n```\n'), '```tv\n卫视 | 川 | 四川卫视 | https://x\n```');   // 卡片代码块整块原样
  assert.equal(pasteOut(m, '[晴天](https://a#audio)\tB 站音轨 · 最高 320k\t4:30'), '[晴天](https://a#audio) · B 站音轨 · 最高 320k · 4:30');
  assert.equal(pasteOut(m, '[甲](https://a)\tx\t1:00\n[乙](https://b)\ty\t2:00'), '1. [甲](https://a) · x · 1:00\n2. [乙](https://b) · y · 2:00');   // 几条就编号
  assert.equal(pasteOut(im, '/tmp/a.jpg\t120KB\tbing\t熊猫\thttps://x\n/tmp/b.jpg\t80KB\tbaidu\t熊猫\thttps://y'), '`/tmp/a.jpg`\n`/tmp/b.jpg`');
});

test('kuAi 小测验：假结果是确定的；判分——闲聊不调、单步 df、读了说明用代号、出错后换成实际的名字；填空要歌名歌手都对', () => {
  assert.match(fakeRun('read claw-lamp').out, /房间代号：客厅 lr-2/);
  assert.deepEqual([fakeRun('claw-lamp lr-2 on').ok, fakeRun('claw-lamp 客厅 on').ok, fakeRun('claw-lamp 客厅 on').doc], [true, false, 'claw-lamp']);   // 没读说明就用错：附上说明
  assert.match(fakeRun('df -h').out, /37Gi/);
  assert.match(fakeRun('head -5 report.txt').out, /head: report\.txt: No such file or directory。这个目录里有：Report\.txt/);
  assert.match(fakeRun('head -n 5 "Report.txt"').out, /2026 年度报告/);
  assert.equal(fakeRun('read claw-nope').ok, false);
  assert.equal(grade('chat', { lines: [], text: '不客气' }), true);
  assert.equal(grade('chat', { lines: ['date'], text: '' }), false);
  assert.equal(grade('chat', { lines: [], text: '' }), false);
  assert.equal(grade('one', { lines: ['df -h'] }), true);
  assert.equal(grade('one', { lines: [], text: 'df -h' }), false);   // 只是把命令写出来、没调用：不算
  assert.equal(grade('chain', { lines: ['read claw-lamp', 'claw-lamp lr-2 on'] }), true);
  assert.equal(grade('chain', { lines: ['claw-lamp 客厅 on'] }), false);
  assert.equal(grade('chain', { lines: ['claw-lamp "lr-2" on'] }), true);
  assert.equal(grade('fix', { lines: ['head -5 report.txt', 'head -5 Report.txt'] }), true);
  assert.equal(grade('fix', { lines: ['ls', 'cat ./Report.txt'] }), true);
  assert.equal(grade('fix', { lines: ['head -5 report.txt'] }), false);
  assert.equal(settled('chain', { lines: ['claw-lamp lr-2 on'] }), true);
  const QF = loadFills(QUIZ_FILL_META)[0], q = QUESTIONS[0];
  assert.equal(grade('fill', { fill: parseFill(QF, '{"song":"红豆","artist":"王菲","use":true}', q.text) }), true);
  assert.equal(grade('fill', { fill: parseFill(QF, '{"song":"吻别","artist":"张学友","use":true}', q.text) }), false);   // 照抄例子
  assert.equal(grade('fill', { fill: parseFill(QF, '{"song":"红豆","artist":"","use":true}', q.text) }), false);
  assert.equal(grade('fill', { fill: null }), false);
  assert.deepEqual(QUIZ_SKILLS.map(k => k.name), ['claw-clock', 'claw-lamp']);
  // look 题（开了只读工具的假世界）：笔记里写的是「年度检查」——搜「体检」搜不到，要换个找法
  const F3 = { files: true };
  assert.match(fakeRun('search "体检"', F3).out, /^没找到（搜了 2 个文件）。先别下结论/);
  assert.match(fakeRun('search 检查', F3).out, /^notes\.md:4: - 12 月 3 日上午去医院做年度检查/);
  assert.match(fakeRun('read notes.md', F3).out, /^notes\.md（第 1–5 行，共 5 行）\n1\t# 备忘/);
  assert.equal(fakeRun('read nope.md', F3).ok, false);
  assert.match(fakeRun('read notes.md').out, /没有这个技能/);                       // 没开只读工具的题里，read 只认技能
  assert.match(fakeRun('cat notes.md').out, /年度检查/); assert.match(fakeRun('grep 检查 notes.md').out, /年度检查/);
  assert.equal(grade('look', { lines: ['search 体检'], text: '没找到' }), false);
  assert.equal(grade('look', { lines: ['search 体检', 'ls', 'read notes.md'] }), true);
  assert.equal(grade('look', { lines: ['ls', 'cat ~/notes.md'] }), true);
  assert.equal(grade('look', { lines: ['search "检查|体检"'] }), true);                 // 换了个词搜到了
  assert.equal(grade('look', { lines: ['read Report.txt'] }), false);
  assert.equal(grade('look', { lines: [], text: '是 12 月 3 号' }), true);
  assert.equal(QUESTIONS.find(q => q.key === 'look').tier, 3);
});

test('kuAi 小测验：分数 → 能力档；工具题按顺序做，错一题后面的不做', () => {
  assert.equal(quizTier({ fill: true, chat: true, one: true, chain: true, fix: true, look: true }), 3);
  assert.equal(quizTier({ fill: true, chat: true, one: true, chain: true, fix: true, look: false }), 2);   // 没找到不会换个找法：不给只读工具
  assert.equal(quizTier({ fill: false, chat: true, one: true, chain: true, fix: false }), 2);   // 填空没过不挡 L2：L2 用不着它
  assert.equal(quizTier({ fill: true, chat: true, one: false, chain: null, fix: null }), 1);
  assert.equal(quizTier({ fill: true, chat: false, one: null, chain: null, fix: null }), 1);
  assert.equal(quizTier({ fill: false, chat: true, one: true, chain: false, fix: null }), 0);
  assert.equal(quizTier({}), 0);
  assert.deepEqual(quizCount({ fill: true, chat: true, one: false, chain: null, fix: null }), { pass: 2, of: 6 });
  const order = []; const pass = {};
  for (let q; (q = nextQuestion(pass));) { order.push(q.key); pass[q.key] = true; }
  assert.deepEqual(order, ['fill', 'chat', 'one', 'chain', 'fix', 'look']);
  assert.equal(nextQuestion({ fill: false, chat: true, one: false }), null);        // 单步错了：后面的不做
  assert.equal(nextQuestion({ fill: false })?.key, 'chat');                          // 填空错了不影响工具题
  assert.equal(nextQuestion({ fill: true, chat: true })?.key, 'one');                // 没测完的接着测
});
