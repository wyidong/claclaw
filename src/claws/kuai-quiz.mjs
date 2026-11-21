// kuAi 的上岗小测验：5 道固定的小题，看一个模型实际能把 kuAi 用到哪一档（参数量、家族只是估计，这个是实测）。
// 题目走的就是平时那套提示和调用方式（原生工具调用或 claw 代码块、填空的 JSON），只是技能和命令的结果是这里编好的假结果，不真跑；判分是确定的。
// 纯函数；怎么发请求在 kuai-agent.mjs（runQuiz）。结果按「主机|模型」记在 KUAI_LEARN 里。
//   fill   填空：从一句话里取出歌名、歌手                  → 过了就够 L1
//   chat   闲聊时不调工具
//   one    单步：看磁盘空间 → 跑 df
//   chain  两步：开客厅的灯 → 先读技能说明，再用说明里的房间代号    chat + one + chain 都过 → L2
//   fix    出错后换参数：report.txt 没有 → 按报错里给的实际名字换成 Report.txt   再过这题 → L3
//          （题目里写明了「找不到就按实际的名字看」：考的是出错后会不会接着做，不是该不该先问用户——DeepSeek 不写这句时会停下来问）
// 工具题按顺序做，错一题后面的不做（后面的档反正到不了，省时间；本机小模型一题要几十秒）
export const QUIZ_V = 1;

// 测验里的假技能：第一个只是清单里的陪衬（提示词里的例子用它），第二个是 chain 题要用的
const LAMP_DOC = `# 开关家里的灯

## 命令

\`\`\`sh
claw-lamp <房间代号> <on|off>
\`\`\`

房间代号：客厅 lr-2、卧室 br-1、厨房 kt-5。只认代号，不认房间名。

## 怎么回复

一句话告诉用户灯开了还是关了。`;
export const QUIZ_SKILLS = [
  { name: 'claw-clock', brief: '查世界各地现在几点', eg: 'claw-clock "东京"', md: '# 世界时间\n\n命令：claw-clock "城市名"。把结果用一句话告诉用户。' },
  { name: 'claw-lamp', brief: '开关家里的灯', eg: 'claw-lamp br-1 off', md: LAMP_DOC },
];
// 填空题用的假技能（和听歌技能一个样子）。只考「从原话里取出两段」这一件事：L1 靠的就是它。
// 试过再加一个枚举参数（音质：标准 / 无损），qwen3:1.7b 歌名歌手都取对了、枚举留空——实际的技能里枚举参数是可有可无的，拿它卡 L1 就卡错了
export const QUIZ_FILL_META = { 'claw-radio': { fill: {
  what: '点歌（放一首歌）', when: '.', need: ['song'], args: ['{song} {artist}'],
  slots: { song: { desc: '歌名' }, artist: { desc: '歌手，没说就留空' } },
  examples: [['放一首张学友的吻别', { song: '吻别', artist: '张学友' }], ['来首海阔天空', { song: '海阔天空', artist: '' }], ['吻别是谁唱的', null]],
} } };

export const QUESTIONS = [
  { key: 'fill', name: '填参数', text: '我想听王菲的红豆' },
  { key: 'chat', name: '闲聊不调工具', text: '谢谢你，今天辛苦了！', steps: 1 },
  { key: 'one', name: '单步调用', text: '帮我看一下这台电脑的磁盘还剩多少空间。', steps: 1 },
  { key: 'chain', name: '两步（先读说明再用）', text: '把客厅的灯打开。', steps: 3 },
  { key: 'fix', name: '出错后换参数', text: '看一下 report.txt 的前 5 行写了什么。文件名的大小写我记不清了，找不到就按目录里实际的名字看。', steps: 4 },
];
export const TOOL_KEYS = ['chat', 'one', 'chain', 'fix'];

const words = l => String(l || '').replace(/^\$\s+/, '').replace(/["']/g, '').trim().split(/\s+/).filter(Boolean);
const DF = `Filesystem      Size   Used  Avail Capacity  Mounted on
/dev/disk1s1   466Gi  402Gi   37Gi    92%    /`;
// 假的世界：一条命令 → { out, ok, skill（是技能不是简单命令）, doc（没读说明就用技能时附上的说明） }
export function fakeRun(line) {
  const w = words(line), c = (w[0] || '').replace(/^.*\//, ''), rest = w.slice(1).join(' ');
  if (/^read$/i.test(c)) { const k = QUIZ_SKILLS.find(x => x.name === w[1]); return k ? { out: k.md, ok: true, skill: true } : { out: '没有这个技能：' + (w[1] || '') + '。能用的：' + QUIZ_SKILLS.map(x => x.name).join('、'), ok: false, skill: true }; }
  if (c === 'claw-lamp') {
    const room = { 'lr-2': '客厅', 'br-1': '卧室', 'kt-5': '厨房' }[w[1]];
    if (room && /^(on|off)$/.test(w[2] || '')) return { out: '已把' + room + '的灯' + (w[2] === 'on' ? '打开' : '关掉'), ok: true, skill: true };
    return { out: '没有这个房间代号：' + (w[1] || '（空）') + '（退出码 2）', ok: false, skill: true, doc: 'claw-lamp' };
  }
  if (c === 'claw-clock') return { out: (w[1] || '东京') + ' 现在是 21:05', ok: true, skill: true };
  if (/^claw-/.test(c)) return { out: '没有这个技能：' + c + '。能用的：' + QUIZ_SKILLS.map(x => x.name).join('、'), ok: false, skill: true };
  if (c === 'df') return { out: DF, ok: true };
  if (c === 'date') return { out: 'Sat Nov 21 21:05:00 CST 2026', ok: true };
  if (c === 'pwd') return { out: '/Users/demo', ok: true };
  if (c === 'ls' || c === 'find') return { out: 'Report.txt\nnotes.md\nphotos', ok: true };
  if (/^(head|cat|tail|wc|stat|file|grep)$/.test(c)) {
    if (rest.includes('Report.txt')) return { out: '2026 年度报告\n一、概况\n今年一共完成 12 个项目。\n二、收入\n比去年多了两成。', ok: true };
    return { out: c + ': ' + (w.filter(x => !x.startsWith('-') && !/^\d+$/.test(x))[1] || 'report.txt') + ': No such file or directory。这个目录里有：Report.txt、notes.md（退出码 1）', ok: false };
  }
  return { out: '（小测验里这条命令没有结果）', ok: true };
}

// 判分。lines：这一题里模型要跑的全部命令（按先后）；text：最后的回答；fill：填空题填回来的参数（parseFill 的结果）
export function grade(key, { lines = [], text = '', fill = null } = {}) {
  const ws = lines.map(words);
  if (key === 'fill') return !!fill && fill.use && fill.slots.song === '红豆' && fill.slots.artist === '王菲';
  if (key === 'chat') return !lines.length && !!String(text).trim();
  if (key === 'one') return ws.some(w => w[0] === 'df');
  if (key === 'chain') return ws.some(w => w[0] === 'claw-lamp' && w[1] === 'lr-2' && w[2] === 'on' && w.length === 3);
  if (key === 'fix') return ws.some(w => /^(head|cat|tail)$/.test(w[0]) && w.some(x => /(^|\/)Report\.txt$/.test(x)));
  return false;
}
// 这一题已经有结论了没有（过了就不用再往下跑）
export const settled = (key, got) => key !== 'chat' && grade(key, got);

// pass：{ fill, chat, one, chain, fix } → true / false / null（没做）。→ 能力档
export function quizTier(pass) {
  const p = k => pass?.[k] === true;
  if (p('chat') && p('one') && p('chain')) return p('fix') ? 3 : 2;
  return p('fill') ? 1 : 0;
}
export const quizCount = pass => ({ pass: QUESTIONS.filter(q => pass?.[q.key] === true).length, of: QUESTIONS.length });
// 下一道该做的题；做完了（或者后面的不用做了）返回 null
export function nextQuestion(pass) {
  if (pass?.fill == null) return QUESTIONS[0];
  for (const k of TOOL_KEYS) { if (pass[k] == null) return QUESTIONS.find(q => q.key === k); if (pass[k] === false) return null; }
  return null;
}
